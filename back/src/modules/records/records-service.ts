import { createHash, randomUUID } from 'node:crypto';

import { and, desc, eq, sql } from 'drizzle-orm';
import { canonicalize } from 'json-canonicalize';

import type { DatabaseClient } from '../../database/client.js';
import {
  disputeEvidence,
  disputes,
  checkoutSessions,
  mandateVersions,
  merchants,
  orderItems,
  orders,
  purchaseAttempts,
  purchaseIntents,
  receipts,
  transactions,
} from '../../database/schema.js';
import { HttpError } from '../../shared/http-error.js';
import { AuditService } from '../audit/audit-service.js';

const MERCHANT_EVENT_TYPES = new Set([
  'MANDATE_AUTHORIZED', 'CHECKOUT_CREATED', 'MANDATE_EVALUATED',
  'HUMAN_APPROVAL_GRANTED', 'HUMAN_APPROVAL_DENIED', 'PAYMENT_AUTHORIZATION_CREATED',
  'PAYMENT_CREDENTIAL_ISSUED', 'PAYMENT_SUCCEEDED', 'ORDER_AND_RECEIPT_CREATED',
]);

export class RecordsService {
  private readonly audit: AuditService;

  constructor(private readonly database: DatabaseClient) {
    this.audit = new AuditService(database);
  }

  async listTransactions(userId: string) {
    const rows = await this.database.db.select({
      transaction: transactions,
      merchantName: merchants.name,
      productName: sql<string | null>`(
        SELECT ${orderItems.productName}
        FROM ${orderItems}
        WHERE ${orderItems.orderId} = ${orders.id}
        ORDER BY ${orderItems.id}
        LIMIT 1
      )`,
      mandateVersion: mandateVersions.version,
    })
      .from(transactions)
      .innerJoin(purchaseAttempts, eq(purchaseAttempts.id, transactions.attemptId))
      .innerJoin(purchaseIntents, eq(purchaseIntents.id, purchaseAttempts.intentId))
      .innerJoin(checkoutSessions, eq(checkoutSessions.attemptId, purchaseAttempts.id))
      .innerJoin(merchants, eq(merchants.id, checkoutSessions.merchantId))
      .innerJoin(mandateVersions, eq(mandateVersions.id, purchaseAttempts.mandateVersionId))
      .leftJoin(orders, eq(orders.transactionId, transactions.id))
      .where(eq(purchaseIntents.userId, userId)).orderBy(desc(transactions.createdAt));
    return rows.map(({ transaction, ...context }) => ({ ...this.transaction(transaction), ...context }));
  }

  async transactionDetail(userId: string, transactionId: string) {
    const owned = await this.ownedTransaction(userId, transactionId);
    const [order] = await this.database.db.select().from(orders)
      .where(eq(orders.transactionId, transactionId)).limit(1);
    const items = order ? await this.database.db.select().from(orderItems).where(eq(orderItems.orderId, order.id)) : [];
    const transactionReceipts = await this.database.db.select().from(receipts)
      .where(eq(receipts.transactionId, transactionId));
    const receipt = transactionReceipts.find((entry) => entry.receiptType === 'ORDER');
    return {
      transaction: this.transaction(owned.transaction),
      order: order ? { ...this.total(order), items: items.map((item) => ({
        ...this.total(item), unitPriceMinor: item.unitPriceMinor.toString(),
      })) } : null,
      receipt: receipt ? this.receipt(receipt) : null,
      protocolReceipts: transactionReceipts.filter((entry) => entry.receiptType !== 'ORDER')
        .map((entry) => this.receipt(entry)),
    };
  }

  async receiptForUser(userId: string, transactionId: string) {
    await this.ownedTransaction(userId, transactionId);
    const [receipt] = await this.database.db.select().from(receipts)
      .where(and(eq(receipts.transactionId, transactionId), eq(receipts.receiptType, 'ORDER'))).limit(1);
    if (!receipt) throw new HttpError(404, 'RECEIPT_NOT_FOUND', 'Receipt not found');
    return this.receipt(receipt);
  }

  async humanAudit(userId: string, transactionId: string) {
    const owned = await this.ownedTransaction(userId, transactionId);
    return this.auditProjection(owned.intentId, () => true);
  }

  async merchantVerification(attemptId: string) {
    const [attempt] = await this.database.db.select().from(purchaseAttempts)
      .where(eq(purchaseAttempts.id, attemptId)).limit(1);
    if (!attempt) throw new HttpError(404, 'PURCHASE_ATTEMPT_NOT_FOUND', 'Purchase attempt not found');
    return this.auditProjection(attempt.intentId, (event) => MERCHANT_EVENT_TYPES.has(event.eventType));
  }

  async auditorEvidence(transactionId: string) {
    const facts = await this.reconstruct(transactionId);
    const intentId = (facts.intent as { id?: string } | undefined)?.id;
    if (!intentId) throw new HttpError(500, 'EVIDENCE_RECONSTRUCTION_INVALID', 'Evidence is missing its purchase intent');
    const projection = await this.auditProjection(intentId, () => true);
    return { facts, ...projection };
  }

  async openDispute(userId: string, transactionId: string, reasonCode: string, statement?: string) {
    const owned = await this.ownedTransaction(userId, transactionId);
    const bundle = await this.reconstruct(transactionId);
    const chain = await this.audit.verifyChain(owned.intentId);
    const bundleHash = createHash('sha256').update(canonicalize(bundle), 'utf8').digest();
    const disputeId = randomUUID();
    const [dispute] = await this.database.db.transaction(async (transaction) => {
      const inserted = await transaction.insert(disputes).values({
        id: disputeId,
        transactionId,
        openedByUserId: userId,
        status: 'EVIDENCE_ASSEMBLED',
        reasonCode,
        statement,
      }).returning();
      await transaction.insert(disputeEvidence).values({
        disputeId,
        bundle,
        bundleHash,
        verificationResult: chain,
      });
      return inserted;
    });
    await this.audit.append({
      eventType: 'DISPUTE_OPENED', actorType: 'USER', actorId: userId,
      intentId: owned.intentId, attemptId: owned.attemptId, transactionId,
      correlationId: owned.correlationId,
      payload: { disputeId, reasonCode, bundleHash: bundleHash.toString('base64url') },
    });
    return { dispute, evidence: { bundle, bundleHash: bundleHash.toString('base64url'), verificationResult: chain } };
  }

  async getDispute(userId: string, role: string, disputeId: string) {
    const [record] = await this.database.db.select({ dispute: disputes, evidence: disputeEvidence })
      .from(disputes).innerJoin(disputeEvidence, eq(disputeEvidence.disputeId, disputes.id))
      .where(and(eq(disputes.id, disputeId),
        ...(role === 'AUDITOR' || role === 'ADMIN' ? [] : [eq(disputes.openedByUserId, userId)]))).limit(1);
    if (!record) throw new HttpError(404, 'DISPUTE_NOT_FOUND', 'Dispute not found');
    return {
      dispute: record.dispute,
      evidence: { ...record.evidence, bundleHash: record.evidence.bundleHash.toString('base64url') },
    };
  }

  async resolveDispute(
    auditorId: string,
    disputeId: string,
    status: 'RESOLVED_USER' | 'RESOLVED_MERCHANT' | 'CLOSED',
    summary: string,
  ) {
    const [updated] = await this.database.db.update(disputes).set({
      status, resolutionSummary: summary, resolvedAt: new Date(),
    }).where(eq(disputes.id, disputeId)).returning();
    if (!updated) throw new HttpError(404, 'DISPUTE_NOT_FOUND', 'Dispute not found');
    const owned = await this.ownedTransactionById(updated.transactionId);
    await this.audit.append({
      eventType: 'DISPUTE_RESOLVED', actorType: 'AUDITOR', actorId: auditorId,
      intentId: owned.intentId, attemptId: owned.attemptId, transactionId: updated.transactionId,
      correlationId: owned.correlationId, payload: { disputeId, status, summary },
    });
    return updated;
  }

  private async auditProjection(intentId: string, include: (event: Awaited<ReturnType<AuditService['list']>>[number]) => boolean) {
    const [events, integrity] = await Promise.all([this.audit.list(intentId), this.audit.verifyChain(intentId)]);
    return { integrity, events: events.filter(include) };
  }

  private async reconstruct(transactionId: string): Promise<Record<string, unknown>> {
    const result = await this.database.pool.query<{ bundle: Record<string, unknown> }>(`SELECT jsonb_build_object(
      'transaction', to_jsonb(t), 'attempt', to_jsonb(pa), 'intent', to_jsonb(pi),
      'mandate', to_jsonb(m), 'mandateVersion', to_jsonb(mv), 'checkout', to_jsonb(cs),
      'paymentAuthorization', to_jsonb(pauth), 'credentialMetadata',
        (to_jsonb(pc) - 'token_hash'), 'order', to_jsonb(o),
      'receipt', (SELECT to_jsonb(r) FROM receipts r
        WHERE r.transaction_id = t.id AND r.receipt_type = 'ORDER' LIMIT 1),
      'receipts', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.receipt_type)
        FROM receipts r WHERE r.transaction_id = t.id), '[]'::jsonb),
      'evaluations', COALESCE((SELECT jsonb_agg(to_jsonb(me) ORDER BY me.evaluated_at)
        FROM mandate_evaluations me WHERE me.attempt_id = pa.id), '[]'::jsonb),
      'approval', (SELECT to_jsonb(ha) FROM human_approvals ha WHERE ha.attempt_id = pa.id LIMIT 1)
    ) AS bundle
    FROM transactions t
    JOIN purchase_attempts pa ON pa.id = t.attempt_id
    JOIN purchase_intents pi ON pi.id = pa.intent_id
    JOIN mandates m ON m.id = pa.mandate_id
    JOIN mandate_versions mv ON mv.id = pa.mandate_version_id
    JOIN checkout_sessions cs ON cs.attempt_id = pa.id
    LEFT JOIN payment_authorizations pauth ON pauth.attempt_id = pa.id
    LEFT JOIN payment_credentials pc ON pc.id = t.credential_id
    LEFT JOIN orders o ON o.transaction_id = t.id
    WHERE t.id = $1`, [transactionId]);
    if (!result.rows[0]) throw new HttpError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found');
    return result.rows[0].bundle;
  }

  private async ownedTransaction(userId: string, transactionId: string) {
    const [record] = await this.database.db.select({
      transaction: transactions,
      intentId: purchaseAttempts.intentId,
      attemptId: purchaseAttempts.id,
      correlationId: purchaseAttempts.correlationId,
    }).from(transactions).innerJoin(purchaseAttempts, eq(purchaseAttempts.id, transactions.attemptId))
      .innerJoin(purchaseIntents, eq(purchaseIntents.id, purchaseAttempts.intentId))
      .where(and(eq(transactions.id, transactionId), eq(purchaseIntents.userId, userId))).limit(1);
    if (!record) throw new HttpError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found');
    return record;
  }

  private async ownedTransactionById(transactionId: string) {
    const [record] = await this.database.db.select({
      intentId: purchaseAttempts.intentId,
      attemptId: purchaseAttempts.id,
      correlationId: purchaseAttempts.correlationId,
    }).from(transactions).innerJoin(purchaseAttempts, eq(purchaseAttempts.id, transactions.attemptId))
      .where(eq(transactions.id, transactionId)).limit(1);
    if (!record) throw new HttpError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found');
    return record;
  }

  private transaction(record: typeof transactions.$inferSelect) {
    return { ...record, amountMinor: record.amountMinor.toString() };
  }

  private total<T extends { totalMinor: bigint }>(record: T) {
    return { ...record, totalMinor: record.totalMinor.toString() };
  }

  private receipt(record: typeof receipts.$inferSelect) {
    return { ...record, payloadHash: record.payloadHash.toString('base64url') };
  }
}
