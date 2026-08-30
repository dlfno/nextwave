import { and, asc, desc, eq } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { canonicalize } from 'json-canonicalize';

import type { DatabaseClient } from '../../database/client.js';
import { AuditService } from '../audit/audit-service.js';
import {
  mandateProductConstraints,
  mandateRevocations,
  mandates,
  mandateVersions,
  purchaseIntents,
} from '../../database/schema.js';
import { HttpError } from '../../shared/http-error.js';
import { authorizationSpecificationSchema, type AuthorizationSpecification } from '../purchase-intents/specifications.js';
import { compileSpecifications, flightIntentDraftSchema, hashIntentDraft } from '../purchase-intents/flight-intent-draft.js';
import type { MandateSigner } from './mandate-signer.js';
import {
  ap2CredentialHash,
  ap2OpenCheckoutMandateSchema,
  ap2OpenPaymentMandateSchema,
  type Ap2CredentialIssuer,
} from './ap2-credential.js';

interface AuthorizeRow {
  mandate_id: string;
  user_id: string;
  agent_id: string;
  intent_id: string | null;
  mandate_status: 'DRAFT' | 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'CANCELLED';
  mode: 'HUMAN_PRESENT' | 'AUTONOMOUS';
  version_id: string;
  version: number;
  version_status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED' | 'EXPIRED' | 'CANCELLED';
  valid_from: Date;
  valid_until: Date;
  canonical_payload: AuthorizationSpecification;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === '23505') return true;
  return 'cause' in error && isUniqueViolation(error.cause);
}

function assertFutureValidity(specification: AuthorizationSpecification): Date {
  const validUntil = new Date(specification.validUntil);
  if (validUntil.getTime() <= Date.now()) {
    throw new HttpError(400, 'MANDATE_VALIDITY_INVALID', 'Mandate validity must end in the future');
  }
  return validUntil;
}

export class MandateService {
  private readonly audit: AuditService;

  constructor(
    private readonly database: DatabaseClient,
    private readonly signer: MandateSigner,
    private readonly ap2TrustedIssuer?: Ap2CredentialIssuer,
    private readonly ap2AgentIssuer?: Ap2CredentialIssuer,
  ) {
    this.audit = new AuditService(database);
  }

  async createDraft(userId: string, intentId: string, mode: 'HUMAN_PRESENT' | 'AUTONOMOUS') {
    const [intent] = await this.database.db
      .select()
      .from(purchaseIntents)
      .where(and(eq(purchaseIntents.id, intentId), eq(purchaseIntents.userId, userId)))
      .limit(1);

    if (!intent) throw new HttpError(404, 'PURCHASE_INTENT_NOT_FOUND', 'Purchase intent not found');
    const parsed = authorizationSpecificationSchema.safeParse(intent.authorizationSpecification);
    if (!parsed.success) {
      throw new HttpError(409, 'SPECIFICATIONS_NOT_FINALIZED', 'Authorization specification is not finalized');
    }
    const specification = parsed.data;
    const draft = flightIntentDraftSchema.safeParse(intent.intentDraft);
    if (!draft.success || hashIntentDraft(draft.data) !== specification.intentDraftHash) {
      throw new HttpError(409, 'INTENT_MANDATE_MISMATCH', 'Mandate does not match the reviewed intent draft');
    }
    const compiled = compileSpecifications(draft.data).authorizationSpecification;
    if (canonicalize(compiled) !== canonicalize(specification)) {
      throw new HttpError(409, 'INTENT_MANDATE_MISMATCH', 'Mandate constraints differ from the reviewed intent');
    }
    const validUntil = assertFutureValidity(specification);

    try {
      const result = await this.database.db.transaction(async (transaction) => {
        const [mandate] = await transaction
          .insert(mandates)
          .values({
            userId,
            agentId: intent.agentId,
            intentId,
            status: 'DRAFT',
            mode,
            expiresAt: validUntil,
          })
          .returning();
        if (!mandate) throw new Error('Mandate insert did not return a row');

        const [version] = await transaction
          .insert(mandateVersions)
          .values({
            mandateId: mandate.id,
            version: 1,
            status: 'DRAFT',
            maxTotalMinor: BigInt(specification.spendConstraints.maxTotalMinor),
            currency: specification.spendConstraints.currency,
            validFrom: new Date(),
            validUntil,
            requiresFinalConfirmation: specification.requiresFinalConfirmation,
            maxUses: 1,
            budgetMinor: BigInt(specification.spendConstraints.maxTotalMinor),
            allowedMerchantsAny: specification.merchantConstraints.allowedMerchants === 'ANY',
            canonicalPayload: specification,
          })
          .returning();
        if (!version) throw new Error('Mandate version insert did not return a row');

        await transaction.insert(mandateProductConstraints).values({
          mandateVersionId: version.id,
          matchType: 'CATEGORY',
          categoryPrefix: specification.productConstraints.category,
          originIata: specification.productConstraints.originIata,
          destinationIata: specification.productConstraints.destinationIata,
          departureDate: specification.productConstraints.departureDate,
          maxQuantity: specification.productConstraints.quantity,
        });
        return { mandate, version };
      });
      await this.audit.append({
        eventType: 'MANDATE_DRAFTED', actorType: 'USER', actorId: userId, intentId,
        mandateId: result.mandate.id, mandateVersionId: result.version.id,
        payload: { version: result.version.version, mode, constraints: specification },
      });
      return this.serializeDraft(result.mandate, result.version);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, 'MANDATE_ALREADY_EXISTS', 'A mandate already exists for this purchase intent');
      }
      throw error;
    }
  }

  async createVersion(userId: string, mandateId: string, specification: AuthorizationSpecification) {
    const validUntil = assertFutureValidity(specification);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const mandateResult = await client.query<{
        id: string;
        status: string;
      }>('SELECT id, status FROM mandates WHERE id = $1 AND user_id = $2 FOR UPDATE', [mandateId, userId]);
      const mandate = mandateResult.rows[0];
      if (!mandate) throw new HttpError(404, 'MANDATE_NOT_FOUND', 'Mandate not found');
      if (mandate.status === 'REVOKED') throw new HttpError(409, 'MANDATE_REVOKED', 'Mandate is revoked');
      if (mandate.status === 'EXPIRED') throw new HttpError(409, 'MANDATE_EXPIRED', 'Mandate is expired');

      const versionResult = await client.query<{ next_version: number }>(
        'SELECT COALESCE(MAX(version), 0)::integer + 1 AS next_version FROM mandate_versions WHERE mandate_id = $1',
        [mandateId],
      );
      const nextVersion = versionResult.rows[0]!.next_version;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO mandate_versions (
          mandate_id, version, status, max_total_minor, currency, valid_from, valid_until,
          requires_final_confirmation, max_uses, budget_minor, allowed_merchants_any, canonical_payload
        ) VALUES ($1, $2, 'DRAFT', $3, $4, now(), $5, $6, 1, $3, true, $7)
        RETURNING id`,
        [
          mandateId,
          nextVersion,
          specification.spendConstraints.maxTotalMinor,
          specification.spendConstraints.currency,
          validUntil,
          specification.requiresFinalConfirmation,
          specification,
        ],
      );
      await client.query(
        `INSERT INTO mandate_product_constraints (
          mandate_version_id, match_type, category_prefix, origin_iata, destination_iata, departure_date, max_quantity
        ) VALUES ($1, 'CATEGORY', $2, $3, $4, $5, $6)`,
        [inserted.rows[0]!.id, specification.productConstraints.category,
          specification.productConstraints.originIata, specification.productConstraints.destinationIata,
          specification.productConstraints.departureDate, specification.productConstraints.quantity],
      );
      await client.query('COMMIT');
      const detail = await this.get(userId, mandateId);
      const created = detail.versions.find((entry) => entry.version === nextVersion)!;
      if (detail.mandate.intentId) await this.audit.append({
        eventType: 'MANDATE_VERSION_DRAFTED', actorType: 'USER', actorId: userId,
        intentId: detail.mandate.intentId, mandateId, mandateVersionId: created.id,
        payload: { version: nextVersion, constraints: specification },
      });
      return detail;
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async authorize(userId: string, mandateId: string, version?: number) {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const targetVersion = version ?? 1;
      const result = await client.query<AuthorizeRow>(
        `SELECT
          m.id AS mandate_id, m.user_id, m.agent_id, m.intent_id, m.status AS mandate_status, m.mode,
          mv.id AS version_id, mv.version, mv.status AS version_status,
          mv.valid_from, mv.valid_until, mv.canonical_payload
        FROM mandates m
        JOIN mandate_versions mv ON mv.mandate_id = m.id AND mv.version = $3
        WHERE m.id = $1 AND m.user_id = $2
        FOR UPDATE OF m, mv`,
        [mandateId, userId, targetVersion],
      );
      const row = result.rows[0];
      if (!row) throw new HttpError(404, 'MANDATE_VERSION_NOT_FOUND', 'Mandate version not found');
      if (row.mandate_status === 'REVOKED') throw new HttpError(409, 'MANDATE_REVOKED', 'Mandate is revoked');
      if (row.mandate_status === 'EXPIRED' || row.valid_until.getTime() <= Date.now()) {
        throw new HttpError(409, 'MANDATE_EXPIRED', 'Mandate is expired');
      }
      if (row.version_status !== 'DRAFT') {
        throw new HttpError(409, 'MANDATE_VERSION_NOT_DRAFT', 'Mandate version is not awaiting authorization');
      }

      const signedAt = new Date();
      const payload: Record<string, unknown> = {
        vct: 'com.nextwave.purchase-mandate.open.1',
        issuer: 'urn:nextwave:trusted-surface',
        subject: `urn:nextwave:user:${row.user_id}`,
        mandateId: row.mandate_id,
        version: row.version,
        mode: row.mode,
        authorizedAgent: { id: row.agent_id },
        constraints: row.canonical_payload,
        issuedAt: signedAt.toISOString(),
        validFrom: row.valid_from.toISOString(),
        validUntil: row.valid_until.toISOString(),
      };
      const evidence = await this.signer.sign(payload);
      if (!(await this.signer.verify(evidence.signedPayload, evidence.canonicalPayload))) {
        throw new HttpError(500, 'MANDATE_SIGNATURE_VERIFICATION_FAILED', 'Created mandate signature did not verify');
      }
      const ap2 = row.mode === 'AUTONOMOUS'
        ? await this.createAp2OpenMandates(row.canonical_payload, row.valid_until)
        : undefined;

      await client.query(
        "UPDATE mandate_versions SET status = 'SUPERSEDED' WHERE mandate_id = $1 AND status = 'ACTIVE'",
        [mandateId],
      );
      await client.query(
        `UPDATE mandate_versions SET
          status = 'ACTIVE', canonical_payload = $2, payload_hash = $3, signed_payload = $4,
          signature_algorithm = $5, signing_key_id = $6, signed_at = $7,
          ap2_open_checkout_payload = $8, ap2_open_checkout_credential = $9,
          ap2_open_checkout_hash = $10, ap2_open_payment_payload = $11,
          ap2_open_payment_credential = $12, ap2_open_payment_hash = $13
        WHERE id = $1`,
        [
          row.version_id,
          evidence.canonicalPayload,
          evidence.payloadHash,
          evidence.signedPayload,
          evidence.signatureAlgorithm,
          evidence.signingKeyId,
          signedAt,
          ap2?.checkout.content ?? null,
          ap2?.checkout.compact ?? null,
          ap2?.checkout.hash ?? null,
          ap2?.payment.content ?? null,
          ap2?.payment.compact ?? null,
          ap2?.payment.hash ?? null,
        ],
      );
      await client.query(
        "UPDATE mandates SET status = 'ACTIVE', current_version_id = $2, expires_at = $3 WHERE id = $1",
        [mandateId, row.version_id, row.valid_until],
      );
      if (row.intent_id) {
        await client.query("UPDATE purchase_intents SET status = 'MANDATE_AUTHORIZED' WHERE id = $1", [row.intent_id]);
      }
      await client.query('COMMIT');
      if (row.intent_id) await this.audit.append({
        eventType: 'MANDATE_AUTHORIZED', actorType: 'USER', actorId: userId,
        intentId: row.intent_id, mandateId, mandateVersionId: row.version_id,
        payload: {
          version: row.version, validUntil: row.valid_until.toISOString(),
          payloadHash: evidence.payloadHash.toString('base64url'), signingKeyId: evidence.signingKeyId,
          ...(ap2 ? {
            ap2OpenCheckoutHash: ap2.checkout.hash.toString('base64url'),
            ap2OpenPaymentHash: ap2.payment.hash.toString('base64url'),
          } : {}),
        },
      });
      return this.get(userId, mandateId);
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async revoke(userId: string, mandateId: string, reason?: string) {
    await this.expireOwned(userId, mandateId);
    const [mandate] = await this.database.db
      .select()
      .from(mandates)
      .where(and(eq(mandates.id, mandateId), eq(mandates.userId, userId)))
      .limit(1);
    if (!mandate) throw new HttpError(404, 'MANDATE_NOT_FOUND', 'Mandate not found');
    if (mandate.status === 'EXPIRED') throw new HttpError(409, 'MANDATE_EXPIRED', 'Mandate is expired');
    if (mandate.status !== 'REVOKED') {
      await this.database.db.insert(mandateRevocations).values({ mandateId, revokedByUserId: userId, reason });
      if (mandate.intentId) await this.audit.append({
        eventType: 'MANDATE_REVOKED', actorType: 'USER', actorId: userId,
        intentId: mandate.intentId, mandateId,
        ...(mandate.currentVersionId ? { mandateVersionId: mandate.currentVersionId } : {}),
        payload: { reason: reason ?? null },
      });
    }
    return this.get(userId, mandateId);
  }

  async list(userId: string) {
    await this.expireOwned(userId);
    const records = await this.database.db
      .select()
      .from(mandates)
      .where(eq(mandates.userId, userId))
      .orderBy(desc(mandates.createdAt));
    return records.map((record) => this.serializeMandate(record));
  }

  async get(userId: string, mandateId: string) {
    await this.expireOwned(userId, mandateId);
    const [mandate] = await this.database.db
      .select()
      .from(mandates)
      .where(and(eq(mandates.id, mandateId), eq(mandates.userId, userId)))
      .limit(1);
    if (!mandate) throw new HttpError(404, 'MANDATE_NOT_FOUND', 'Mandate not found');

    const versions = await this.database.db
      .select()
      .from(mandateVersions)
      .where(eq(mandateVersions.mandateId, mandateId))
      .orderBy(asc(mandateVersions.version));
    const revocations = await this.database.db
      .select()
      .from(mandateRevocations)
      .where(eq(mandateRevocations.mandateId, mandateId));

    return {
      mandate: this.serializeMandate(mandate),
      versions: await Promise.all(versions.map(async (record) => ({
        ...this.serializeVersion(record),
        signatureVerified: record.signedPayload && record.payloadHash
          ? await this.signer.verify(record.signedPayload, record.canonicalPayload as Record<string, unknown>)
          : null,
      }))),
      revocations,
    };
  }

  private async expireOwned(userId: string, mandateId?: string): Promise<void> {
    const parameters = mandateId ? [userId, mandateId] : [userId];
    const idClause = mandateId ? ' AND id = $2' : '';
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE mandate_versions SET status = 'EXPIRED'
         WHERE status = 'ACTIVE' AND mandate_id IN (
           SELECT id FROM mandates WHERE user_id = $1${idClause} AND status = 'ACTIVE' AND expires_at <= now()
         )`,
        parameters,
      );
      await client.query(
        `UPDATE mandates SET status = 'EXPIRED'
         WHERE user_id = $1${idClause} AND status = 'ACTIVE' AND expires_at <= now()`,
        parameters,
      );
      await client.query('COMMIT');
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private serializeDraft(mandate: typeof mandates.$inferSelect, version: typeof mandateVersions.$inferSelect) {
    return { mandate: this.serializeMandate(mandate), version: this.serializeVersion(version) };
  }

  private serializeMandate(record: typeof mandates.$inferSelect) {
    return record;
  }

  private serializeVersion(record: typeof mandateVersions.$inferSelect) {
    return {
      ...record,
      maxTotalMinor: record.maxTotalMinor.toString(),
      budgetMinor: record.budgetMinor?.toString() ?? null,
      payloadHash: record.payloadHash?.toString('base64url') ?? null,
      ap2OpenCheckoutHash: record.ap2OpenCheckoutHash?.toString('base64url') ?? null,
      ap2OpenPaymentHash: record.ap2OpenPaymentHash?.toString('base64url') ?? null,
    };
  }

  private async rollback(client: PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original transaction error.
    }
  }

  private async createAp2OpenMandates(
    specification: AuthorizationSpecification,
    validUntil: Date,
  ) {
    if (!this.ap2TrustedIssuer || !this.ap2AgentIssuer) {
      throw new HttpError(503, 'AP2_ISSUER_UNAVAILABLE', 'AP2 mandate issuer is not configured');
    }
    const iat = Math.floor(Date.now() / 1_000);
    const exp = Math.floor(validUntil.getTime() / 1_000);
    const cnf = { jwk: this.ap2AgentIssuer.publicJwk() };
    const checkoutContent = ap2OpenCheckoutMandateSchema.parse({
      vct: 'mandate.checkout.open.1',
      constraints: [{
        type: 'com.nextwave.checkout.flight.1',
        category: specification.productConstraints.category,
        origin_iata: specification.productConstraints.originIata,
        destination_iata: specification.productConstraints.destinationIata,
        departure_date: specification.productConstraints.departureDate,
        quantity: specification.productConstraints.quantity,
      }],
      cnf, iat, exp,
    });
    const checkout = await this.ap2TrustedIssuer.issueDelegation(checkoutContent, validUntil);
    const max = BigInt(specification.spendConstraints.maxTotalMinor);
    if (max > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new HttpError(422, 'AP2_AMOUNT_UNSUPPORTED', 'Mandate amount exceeds AP2 numeric limits');
    }
    const paymentContent = ap2OpenPaymentMandateSchema.parse({
      vct: 'mandate.payment.open.1',
      constraints: [
        { type: 'payment.amount_range', currency: specification.spendConstraints.currency,
          min: 0, max: Number(max) },
        { type: 'payment.agent_recurrence', frequency: 'ON_DEMAND', max_occurrences: 1 },
        { type: 'payment.execution_date', not_after: validUntil.toISOString() },
        { type: 'payment.reference', conditional_transaction_id: ap2CredentialHash(checkout.compact) },
      ],
      cnf, iat, exp,
    });
    const payment = await this.ap2TrustedIssuer.issueDelegation(paymentContent, validUntil);
    if (!(await this.ap2TrustedIssuer.verifyDelegation(checkout.compact, checkout.content))
      || !(await this.ap2TrustedIssuer.verifyDelegation(payment.compact, payment.content))) {
      throw new HttpError(500, 'AP2_CREDENTIAL_VERIFICATION_FAILED', 'Created AP2 mandate did not verify');
    }
    return { checkout, payment };
  }
}
