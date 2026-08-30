import { createHash, randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import { canonicalize } from 'json-canonicalize';

import type { DatabaseClient } from '../../database/client.js';
import { AuditService } from '../audit/audit-service.js';
import {
  checkoutLineItems,
  checkoutSessions,
  humanApprovals,
  mandateEvaluations,
  mandateMerchantAllowlist,
  mandateProductConstraints,
  mandateRevocations,
  mandates,
  mandateUsageReservations,
  mandateVersions,
  purchaseAttempts,
  purchaseIntents,
  quotes,
} from '../../database/schema.js';
import { HttpError } from '../../shared/http-error.js';
import type { CommerceProvider } from '../commerce/commerce-types.js';
import { checkoutPayloadBound } from '../commerce/checkout-binding.js';
import type { MandateSigner } from '../mandates/mandate-signer.js';
import { DeterministicMandateEngine } from '../policy-engine/mandate-engine.js';
import type { HumanApprovalEvidence, MandateDecision, MandateEvaluationInput } from '../policy-engine/policy-types.js';
import { approvalPayload } from './approval-evidence.js';

interface LoadedAttempt {
  attempt: typeof purchaseAttempts.$inferSelect;
  intent: typeof purchaseIntents.$inferSelect;
  mandate: typeof mandates.$inferSelect;
  version: typeof mandateVersions.$inferSelect;
  checkout: typeof checkoutSessions.$inferSelect;
  lineItems: (typeof checkoutLineItems.$inferSelect)[];
  approval: typeof humanApprovals.$inferSelect | undefined;
  quote: typeof quotes.$inferSelect;
}

export class PurchaseAuthorizationService {
  private readonly engine = new DeterministicMandateEngine();
  private readonly providers: ReadonlyMap<string, CommerceProvider>;
  private readonly audit: AuditService;

  constructor(
    private readonly database: DatabaseClient,
    private readonly mandateSigner: MandateSigner,
    providers: readonly CommerceProvider[],
  ) {
    this.providers = new Map(providers.map((provider) => [provider.merchantId, provider]));
    this.audit = new AuditService(database);
  }

  async evaluate(userId: string, attemptId: string): Promise<MandateDecision> {
    const loaded = await this.load(userId, attemptId);
    const evaluatedAt = new Date();
    const input = await this.buildInput(loaded, evaluatedAt);
    const decision = this.engine.evaluate(input);
    const inputHash = createHash('sha256').update(canonicalize({
      attemptId,
      mandateVersionId: loaded.version.id,
      checkoutHash: input.checkout.hash,
      evaluatedAt: evaluatedAt.toISOString(),
      revokedAt: input.revokedAt?.toISOString() ?? null,
      priorUsage: {
        consumedUses: input.priorUsage.consumedUses,
        reservedUses: input.priorUsage.reservedUses,
        consumedAmountMinor: input.priorUsage.consumedAmountMinor.toString(),
        reservedAmountMinor: input.priorUsage.reservedAmountMinor.toString(),
      },
      approval: input.humanApproval ?? null,
    }), 'utf8').digest();
    const status = decision.decision === 'ALLOW' ? 'AUTHORIZED'
      : decision.decision === 'REQUIRE_HUMAN_APPROVAL' ? 'APPROVAL_REQUIRED' : 'DENIED';

    await this.database.db.transaction(async (transaction) => {
      await transaction.insert(mandateEvaluations).values({
        attemptId,
        mandateVersionId: loaded.version.id,
        checkoutId: loaded.checkout.id,
        decision: decision.decision,
        reasonCode: decision.reasonCode,
        checks: decision.checks,
        inputHash,
        evaluatedAt,
      });
      await transaction.update(purchaseAttempts).set({
        status,
        reasonCode: decision.decision === 'ALLOW' ? null : decision.reasonCode,
        updatedAt: evaluatedAt,
      }).where(eq(purchaseAttempts.id, attemptId));
    });
    await this.audit.append({
      eventType: 'MANDATE_EVALUATED', actorType: 'SYSTEM', intentId: loaded.intent.id,
      mandateId: loaded.mandate.id, mandateVersionId: loaded.version.id,
      attemptId, correlationId: loaded.attempt.correlationId,
      payload: { decision: decision.decision, reasonCode: decision.reasonCode, checks: decision.checks },
    });
    return decision;
  }

  async decide(userId: string, attemptId: string, decision: 'APPROVED' | 'DENIED') {
    const before = await this.evaluate(userId, attemptId);
    if (before.decision !== 'REQUIRE_HUMAN_APPROVAL') {
      throw new HttpError(409, before.decision === 'DENY' ? before.reasonCode : 'HUMAN_APPROVAL_NOT_REQUIRED',
        before.decision === 'DENY' ? 'Purchase does not satisfy the mandate' : 'Human approval is not required');
    }
    const loaded = await this.load(userId, attemptId);
    if (loaded.approval) throw new HttpError(409, 'HUMAN_APPROVAL_ALREADY_DECIDED', 'Approval was already decided');
    const decidedAt = new Date();
    const expiresAt = new Date(Math.min(loaded.checkout.expiresAt.getTime(), decidedAt.getTime() + 2 * 60 * 1000));
    if (expiresAt.getTime() <= decidedAt.getTime()) {
      throw new HttpError(409, 'CHECKOUT_EXPIRED', 'Checkout expired before approval');
    }
    const approvalId = randomUUID();
    const checkoutHash = loaded.checkout.checkoutHash.toString('base64url');
    const payload = approvalPayload({
      approvalId, attemptId, userId, mandateVersionId: loaded.version.id,
      checkoutId: loaded.checkout.id, checkoutHash, decision, decidedAt, expiresAt,
    });
    const signed = await this.mandateSigner.sign(payload);
    await this.database.db.insert(humanApprovals).values({
      id: approvalId,
      attemptId,
      userId,
      mandateVersionId: loaded.version.id,
      checkoutId: loaded.checkout.id,
      checkoutHash: loaded.checkout.checkoutHash,
      decision,
      signedEvidence: signed.signedPayload,
      decidedAt,
      expiresAt,
    });
    await this.audit.append({
      eventType: decision === 'APPROVED' ? 'HUMAN_APPROVAL_GRANTED' : 'HUMAN_APPROVAL_DENIED',
      actorType: 'USER', actorId: userId, intentId: loaded.intent.id,
      mandateId: loaded.mandate.id, mandateVersionId: loaded.version.id,
      attemptId, correlationId: loaded.attempt.correlationId,
      payload: { approvalId, checkoutId: loaded.checkout.id, checkoutHash, expiresAt: expiresAt.toISOString() },
    });
    return { approval: { id: approvalId, decision, decidedAt, expiresAt, checkoutHash }, decision: await this.evaluate(userId, attemptId) };
  }

  private async buildInput(loaded: LoadedAttempt, currentTime: Date): Promise<MandateEvaluationInput> {
    const [constraints, allowlist, revocations, usage] = await Promise.all([
      this.database.db.select().from(mandateProductConstraints)
        .where(eq(mandateProductConstraints.mandateVersionId, loaded.version.id)),
      this.database.db.select().from(mandateMerchantAllowlist)
        .where(eq(mandateMerchantAllowlist.mandateVersionId, loaded.version.id)),
      this.database.db.select().from(mandateRevocations)
        .where(eq(mandateRevocations.mandateId, loaded.mandate.id)),
      this.database.db.select({
        status: mandateUsageReservations.status,
        amountMinor: mandateUsageReservations.amountMinor,
      }).from(mandateUsageReservations)
        .where(and(eq(mandateUsageReservations.mandateVersionId, loaded.version.id),
          inArray(mandateUsageReservations.status, ['RESERVED', 'CONSUMED']))),
    ]);
    const provider = this.providers.get(loaded.checkout.merchantId);
    const payload = loaded.checkout.rawPayload as Record<string, unknown>;
    const checkoutEvidenceValid = provider ? await provider.verifyCheckout({
      providerCheckoutId: loaded.checkout.providerCheckoutId,
      payload,
      payloadHash: loaded.checkout.checkoutHash,
      signedPayload: loaded.checkout.signedCheckout,
      expiresAt: loaded.checkout.expiresAt,
    }) && createHash('sha256').update(canonicalize(payload), 'utf8').digest()
      .equals(loaded.checkout.checkoutHash) : false;
    const signatureValid = checkoutEvidenceValid && checkoutPayloadBound(payload, {
      providerCheckoutId: loaded.checkout.providerCheckoutId,
      expiresAt: loaded.checkout.expiresAt,
    }, {
      attemptId: loaded.attempt.id, quoteId: loaded.checkout.quoteId,
      offerId: loaded.attempt.selectedOfferId, mandateId: loaded.attempt.mandateId,
      mandateVersionId: loaded.attempt.mandateVersionId,
      quote: {
        providerQuoteId: loaded.quote.providerQuoteId,
        offerId: loaded.quote.offerId,
        merchantId: loaded.quote.merchantId,
        totalMinor: loaded.quote.totalMinor,
        currency: loaded.quote.currency,
        lineItems: loaded.lineItems.map((item) => ({
          merchantProductId: item.merchantProductId, productId: item.productId,
          productName: item.productName, category: item.category,
          ...(item.originIata ? { originIata: item.originIata } : {}),
          ...(item.destinationIata ? { destinationIata: item.destinationIata } : {}),
          ...(item.departureDate ? { departureDate: item.departureDate } : {}),
          quantity: item.quantity, unitPriceMinor: item.unitPriceMinor,
          totalMinor: item.totalMinor, currency: item.currency,
        })),
        observedAt: loaded.quote.observedAt, expiresAt: loaded.quote.expiresAt,
        payload: loaded.quote.payload as Record<string, unknown>,
      },
    });
    const mandateSignatureValid = loaded.version.signedPayload !== null
      && await this.mandateSigner.verify(
        loaded.version.signedPayload,
        loaded.version.canonicalPayload as Record<string, unknown>,
      );
    const approvedEvidence = await this.validApproval(loaded);
    const consumed = usage.filter((entry) => entry.status === 'CONSUMED');
    const reserved = usage.filter((entry) => entry.status === 'RESERVED');
    const allowedProductIds = constraints.flatMap((entry) => entry.productId ? [entry.productId] : []);
    const allowedProductNames = constraints.flatMap((entry) => entry.normalizedName ? [entry.normalizedName] : []);

    return {
      mandate: {
        id: loaded.mandate.id,
        versionId: loaded.version.id,
        version: loaded.version.version,
        signatureValid: mandateSignatureValid,
        authorizedAgentId: loaded.mandate.agentId,
        status: loaded.mandate.status,
        validFrom: loaded.version.validFrom,
        validUntil: loaded.version.validUntil,
        constraints: {
          maxTotalMinor: loaded.version.maxTotalMinor,
          currency: loaded.version.currency,
          allowedMerchantIds: loaded.version.allowedMerchantsAny ? 'ANY' : allowlist.map((entry) => entry.merchantId),
          allowedCategoryPrefixes: constraints.flatMap((entry) => entry.categoryPrefix ? [entry.categoryPrefix] : []),
          ...(allowedProductIds.length === 0 ? {} : { allowedProductIds }),
          ...(allowedProductNames.length === 0 ? {} : { allowedProductNames }),
          ...(constraints[0]?.originIata ? { originIata: constraints[0].originIata } : {}),
          ...(constraints[0]?.destinationIata ? { destinationIata: constraints[0].destinationIata } : {}),
          ...(constraints[0]?.departureDate ? { departureDate: constraints[0].departureDate } : {}),
          maxQuantity: Math.max(...constraints.map((entry) => entry.maxQuantity), 0),
          ...(loaded.version.maxUses === null ? {} : { maxUses: loaded.version.maxUses }),
          ...(loaded.version.budgetMinor === null ? {} : { budgetMinor: loaded.version.budgetMinor }),
          requiresFinalConfirmation: loaded.version.requiresFinalConfirmation,
        },
      },
      checkout: {
        id: loaded.checkout.id,
        hash: loaded.checkout.checkoutHash.toString('base64url'),
        signatureValid,
        status: loaded.checkout.status === 'READY' ? 'READY' : loaded.checkout.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
        alreadyUsed: loaded.checkout.status !== 'READY',
        mandateId: loaded.attempt.mandateId,
        mandateVersionId: loaded.attempt.mandateVersionId,
        selectedOfferId: loaded.attempt.selectedOfferId,
        quoteId: loaded.checkout.quoteId,
        merchantId: loaded.checkout.merchantId,
        totalMinor: loaded.checkout.totalMinor,
        currency: loaded.checkout.currency,
        expiresAt: loaded.checkout.expiresAt,
        lineItems: loaded.lineItems.map((item) => ({
          ...(item.productId === null ? {} : { productId: item.productId }),
          productName: item.productName,
          category: item.category,
          ...(item.originIata ? { originIata: item.originIata } : {}),
          ...(item.destinationIata ? { destinationIata: item.destinationIata } : {}),
          ...(item.departureDate ? { departureDate: item.departureDate } : {}),
          quantity: item.quantity,
          unitPriceMinor: item.unitPriceMinor,
          totalMinor: item.totalMinor,
          currency: item.currency,
        })),
      },
      context: {
        mandateId: loaded.attempt.mandateId,
        mandateVersionId: loaded.attempt.mandateVersionId,
        selectedOfferId: loaded.attempt.selectedOfferId,
        quoteId: loaded.checkout.quoteId,
        merchantId: loaded.checkout.merchantId,
        expectedTotalMinor: loaded.checkout.totalMinor,
        expectedCurrency: loaded.checkout.currency,
      },
      agentId: loaded.intent.agentId,
      currentTime,
      revokedAt: revocations[0]?.revokedAt ?? loaded.mandate.revokedAt,
      priorUsage: {
        consumedUses: consumed.length,
        reservedUses: reserved.length,
        consumedAmountMinor: consumed.reduce((sum, entry) => sum + entry.amountMinor, 0n),
        reservedAmountMinor: reserved.reduce((sum, entry) => sum + entry.amountMinor, 0n),
      },
      ...(approvedEvidence === undefined ? {} : { humanApproval: approvedEvidence }),
    };
  }

  private async validApproval(loaded: LoadedAttempt): Promise<HumanApprovalEvidence | undefined> {
    const approval = loaded.approval;
    if (!approval) return undefined;
    const checkoutHash = approval.checkoutHash.toString('base64url');
    const payload = approvalPayload({
      approvalId: approval.id,
      attemptId: approval.attemptId,
      userId: approval.userId,
      mandateVersionId: approval.mandateVersionId,
      checkoutId: approval.checkoutId,
      checkoutHash,
      decision: approval.decision,
      decidedAt: approval.decidedAt,
      expiresAt: approval.expiresAt,
    });
    if (!(await this.mandateSigner.verify(approval.signedEvidence, payload))) return undefined;
    return { decision: approval.decision, mandateVersionId: approval.mandateVersionId, checkoutHash, expiresAt: approval.expiresAt };
  }

  private async load(userId: string, attemptId: string): Promise<LoadedAttempt> {
    const [record] = await this.database.db.select({
      attempt: purchaseAttempts,
      intent: purchaseIntents,
      mandate: mandates,
      version: mandateVersions,
      checkout: checkoutSessions,
      quote: quotes,
    }).from(purchaseAttempts)
      .innerJoin(purchaseIntents, eq(purchaseIntents.id, purchaseAttempts.intentId))
      .innerJoin(mandates, eq(mandates.id, purchaseAttempts.mandateId))
      .innerJoin(mandateVersions, eq(mandateVersions.id, purchaseAttempts.mandateVersionId))
      .innerJoin(checkoutSessions, eq(checkoutSessions.attemptId, purchaseAttempts.id))
      .innerJoin(quotes, eq(quotes.id, purchaseAttempts.quoteId))
      .where(and(eq(purchaseAttempts.id, attemptId), eq(purchaseIntents.userId, userId))).limit(1);
    if (!record) throw new HttpError(404, 'PURCHASE_ATTEMPT_NOT_FOUND', 'Purchase attempt not found');
    const [lineItems, approvals] = await Promise.all([
      this.database.db.select().from(checkoutLineItems).where(eq(checkoutLineItems.checkoutId, record.checkout.id)),
      this.database.db.select().from(humanApprovals).where(eq(humanApprovals.attemptId, attemptId)).limit(1),
    ]);
    return { ...record, lineItems, approval: approvals[0] };
  }
}
