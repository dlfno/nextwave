import { createHash, randomUUID } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';
import { canonicalize } from 'json-canonicalize';

import type { DatabaseClient } from '../../database/client.js';
import { AuditService } from '../audit/audit-service.js';
import {
  checkoutLineItems,
  checkoutSessions,
  discoveryRuns,
  mandates,
  mandateVersions,
  offers,
  purchaseAttempts,
  purchaseIntents,
  quotes,
} from '../../database/schema.js';
import { HttpError } from '../../shared/http-error.js';
import type { AuthoritativeQuote, CommerceProvider, SignedCheckout } from './commerce-types.js';

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === '23505') return true;
  return 'cause' in error && isUniqueViolation(error.cause);
}

export class CheckoutService {
  private readonly providers: ReadonlyMap<string, CommerceProvider>;
  private readonly audit: AuditService;

  constructor(database: DatabaseClient, providers: readonly CommerceProvider[]) {
    this.database = database;
    this.providers = new Map(providers.map((provider) => [provider.merchantId, provider]));
    this.audit = new AuditService(database);
  }

  private readonly database: DatabaseClient;

  async createAttempt(userId: string, intentId: string, offerId: string) {
    const selection = await this.findOwnedSelection(userId, intentId, offerId);
    const provider = this.providers.get(selection.offer.merchantId);
    if (!provider) throw new HttpError(503, 'COMMERCE_PROVIDER_UNAVAILABLE', 'Commerce provider is unavailable');
    const currentTime = new Date();
    const quoteId = randomUUID();
    const attemptId = randomUUID();
    const checkoutId = randomUUID();
    const quote = await provider.getLiveQuote({
      offerId: selection.offer.id,
      merchantId: selection.offer.merchantId,
      merchantProductId: selection.offer.merchantProductId,
      productId: selection.offer.productId,
      productName: selection.offer.productName,
      category: selection.offer.category,
      discoveredUnitPriceMinor: selection.offer.unitPriceMinor,
      currency: selection.offer.currency,
    }, currentTime);
    this.assertQuote(quote, selection.offer, currentTime);
    const checkout = await provider.createCheckout({
      attemptId,
      quoteId,
      mandateId: selection.mandate.id,
      mandateVersionId: selection.version.id,
      quote,
      currentTime,
    });
    await this.assertCheckout(provider, checkout, {
      attemptId, quoteId, offerId, mandateId: selection.mandate.id,
      mandateVersionId: selection.version.id, quote,
    }, currentTime);

    try {
      await this.database.db.transaction(async (transaction) => {
        await transaction.insert(quotes).values({
          id: quoteId,
          offerId,
          merchantId: quote.merchantId,
          providerQuoteId: quote.providerQuoteId,
          totalMinor: quote.totalMinor,
          currency: quote.currency,
          payload: quote.payload,
          observedAt: quote.observedAt,
          expiresAt: quote.expiresAt,
        });
        await transaction.insert(purchaseAttempts).values({
          id: attemptId,
          intentId,
          mandateId: selection.mandate.id,
          mandateVersionId: selection.version.id,
          selectedOfferId: offerId,
          quoteId,
          status: 'QUOTED',
        });
        await transaction.insert(checkoutSessions).values({
          id: checkoutId,
          attemptId,
          quoteId,
          merchantId: quote.merchantId,
          providerCheckoutId: checkout.providerCheckoutId,
          status: 'READY',
          totalMinor: quote.totalMinor,
          currency: quote.currency,
          signedCheckout: checkout.signedPayload,
          checkoutHash: checkout.payloadHash,
          rawPayload: checkout.payload,
          createdAt: currentTime,
          expiresAt: checkout.expiresAt,
        });
        await transaction.insert(checkoutLineItems).values(quote.lineItems.map((item) => ({
          checkoutId,
          merchantProductId: item.merchantProductId,
          productId: item.productId,
          productName: item.productName,
          category: item.category,
          originIata: item.originIata,
          destinationIata: item.destinationIata,
          departureDate: item.departureDate,
          quantity: item.quantity,
          unitPriceMinor: item.unitPriceMinor,
          totalMinor: item.totalMinor,
          currency: item.currency,
        })));
        await transaction.update(purchaseIntents).set({ status: 'OFFER_SELECTED', updatedAt: currentTime })
          .where(eq(purchaseIntents.id, intentId));
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, 'CHECKOUT_REPLAYED', 'Merchant checkout evidence has already been used');
      }
      throw error;
    }

    await this.audit.append({
      eventType: 'CHECKOUT_CREATED', actorType: 'AGENT', actorId: selection.mandate.agentId,
      intentId, mandateId: selection.mandate.id, mandateVersionId: selection.version.id,
      attemptId, payload: {
        offerId, quoteId, checkoutId, merchantId: quote.merchantId,
        totalMinor: quote.totalMinor.toString(), currency: quote.currency,
        checkoutHash: checkout.payloadHash.toString('base64url'),
        priceDriftMinor: (quote.totalMinor - selection.offer.unitPriceMinor).toString(),
      },
    });
    return this.getAttempt(userId, attemptId, selection.offer.unitPriceMinor);
  }

  async getAttempt(userId: string, attemptId: string, discoveredPrice?: bigint) {
    const [record] = await this.database.db.select({
      attempt: purchaseAttempts,
      checkout: checkoutSessions,
      quote: quotes,
      offer: offers,
    }).from(purchaseAttempts)
      .innerJoin(purchaseIntents, eq(purchaseIntents.id, purchaseAttempts.intentId))
      .innerJoin(checkoutSessions, eq(checkoutSessions.attemptId, purchaseAttempts.id))
      .innerJoin(quotes, eq(quotes.id, purchaseAttempts.quoteId))
      .innerJoin(offers, eq(offers.id, purchaseAttempts.selectedOfferId))
      .where(and(eq(purchaseAttempts.id, attemptId), eq(purchaseIntents.userId, userId))).limit(1);
    if (!record) throw new HttpError(404, 'PURCHASE_ATTEMPT_NOT_FOUND', 'Purchase attempt not found');
    const lineItems = await this.database.db.select().from(checkoutLineItems)
      .where(eq(checkoutLineItems.checkoutId, record.checkout.id)).orderBy(asc(checkoutLineItems.id));
    const provider = this.providers.get(record.checkout.merchantId);
    const signedCheckout = {
      providerCheckoutId: record.checkout.providerCheckoutId,
      payload: record.checkout.rawPayload as Record<string, unknown>,
      payloadHash: record.checkout.checkoutHash,
      signedPayload: record.checkout.signedCheckout,
      expiresAt: record.checkout.expiresAt,
    };
    const signatureValid = provider ? await provider.verifyCheckout(signedCheckout) : false;
    const hashValid = this.payloadHash(signedCheckout.payload).equals(signedCheckout.payloadHash);
    const now = new Date();
    const expired = record.checkout.expiresAt.getTime() <= now.getTime();
    const replayed = record.checkout.status !== 'READY';
    const originalPrice = discoveredPrice ?? record.offer.unitPriceMinor;
    return {
      attempt: record.attempt,
      quote: this.serializeMoney(record.quote),
      checkout: {
        ...this.serializeMoney(record.checkout),
        checkoutHash: record.checkout.checkoutHash.toString('base64url'),
        lineItems: lineItems.map((item) => ({
          ...item,
          unitPriceMinor: item.unitPriceMinor.toString(),
          totalMinor: item.totalMinor.toString(),
        })),
      },
      verification: {
        signatureValid,
        expired,
        replayed,
        hashValid,
        valid: signatureValid && hashValid && !expired && !replayed,
      },
      priceDriftMinor: (record.quote.totalMinor - originalPrice).toString(),
    };
  }

  private assertQuote(quote: AuthoritativeQuote, offer: typeof offers.$inferSelect, now: Date): void {
    const total = quote.lineItems.reduce((sum, item) => sum + item.totalMinor, 0n);
    const bound = quote.offerId === offer.id && quote.merchantId === offer.merchantId
      && quote.currency === offer.currency && quote.lineItems.length > 0
      && quote.lineItems.every((item) => item.merchantProductId === offer.merchantProductId
        && item.currency === quote.currency && item.quantity > 0
        && item.totalMinor === item.unitPriceMinor * BigInt(item.quantity))
      && total === quote.totalMinor;
    if (!bound) throw new HttpError(502, 'QUOTE_BINDING_MISMATCH', 'Merchant quote does not match the selected offer');
    if (quote.observedAt.getTime() > now.getTime() || quote.expiresAt.getTime() <= now.getTime()) {
      throw new HttpError(409, 'QUOTE_EXPIRED', 'Merchant quote is expired');
    }
  }

  private async assertCheckout(
    provider: CommerceProvider,
    checkout: SignedCheckout,
    expected: { attemptId: string; quoteId: string; offerId: string; mandateId: string; mandateVersionId: string; quote: AuthoritativeQuote },
    now: Date,
  ): Promise<void> {
    if (!(await provider.verifyCheckout(checkout))) {
      throw new HttpError(502, 'CHECKOUT_SIGNATURE_INVALID', 'Merchant checkout signature is invalid');
    }
    if (!this.payloadHash(checkout.payload).equals(checkout.payloadHash)) {
      throw new HttpError(502, 'CHECKOUT_HASH_INVALID', 'Merchant checkout hash is invalid');
    }
    const payload = checkout.payload;
    const bound = payload.providerCheckoutId === checkout.providerCheckoutId
      && payload.attemptId === expected.attemptId && payload.quoteId === expected.quoteId
      && payload.providerQuoteId === expected.quote.providerQuoteId
      && payload.offerId === expected.offerId && payload.mandateId === expected.mandateId
      && payload.mandateVersionId === expected.mandateVersionId
      && payload.merchantId === expected.quote.merchantId
      && payload.totalMinor === expected.quote.totalMinor.toString()
      && payload.currency === expected.quote.currency
      && payload.expiresAt === checkout.expiresAt.toISOString();
    if (!bound) throw new HttpError(502, 'CHECKOUT_BINDING_MISMATCH', 'Merchant checkout is not bound to this purchase');
    if (checkout.expiresAt.getTime() <= now.getTime()) {
      throw new HttpError(409, 'CHECKOUT_EXPIRED', 'Merchant checkout is expired');
    }
  }

  private async findOwnedSelection(userId: string, intentId: string, offerId: string) {
    const [selection] = await this.database.db.select({ offer: offers })
      .from(offers).innerJoin(discoveryRuns, eq(discoveryRuns.id, offers.discoveryRunId))
      .innerJoin(purchaseIntents, eq(purchaseIntents.id, discoveryRuns.intentId))
      .where(and(eq(offers.id, offerId), eq(discoveryRuns.intentId, intentId),
        eq(discoveryRuns.status, 'COMPLETED'), eq(purchaseIntents.userId, userId))).limit(1);
    if (!selection) throw new HttpError(404, 'OFFER_NOT_FOUND', 'Offer not found');
    if (!selection.offer.supportsAuthoritativeCheckout) {
      throw new HttpError(409, 'AUTHORITATIVE_CHECKOUT_UNSUPPORTED', 'Offer cannot produce an authoritative checkout');
    }
    const [authorization] = await this.database.db.select({ mandate: mandates, version: mandateVersions })
      .from(mandates).innerJoin(mandateVersions, eq(mandateVersions.id, mandates.currentVersionId))
      .where(and(eq(mandates.intentId, intentId), eq(mandates.userId, userId),
        eq(mandates.status, 'ACTIVE'), eq(mandateVersions.status, 'ACTIVE'))).limit(1);
    if (!authorization) throw new HttpError(409, 'ACTIVE_MANDATE_REQUIRED', 'An active mandate is required');
    return { ...selection, ...authorization };
  }

  private serializeMoney<T extends { totalMinor: bigint }>(record: T) {
    return { ...record, totalMinor: record.totalMinor.toString() };
  }

  private payloadHash(payload: Readonly<Record<string, unknown>>): Buffer {
    return createHash('sha256').update(canonicalize(payload), 'utf8').digest();
  }
}
