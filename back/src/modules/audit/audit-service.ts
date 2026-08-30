import { createHash, randomUUID } from 'node:crypto';

import { canonicalize } from 'json-canonicalize';

import type { DatabaseClient } from '../../database/client.js';

export type AuditActorType = 'USER' | 'AGENT' | 'MERCHANT' | 'SYSTEM' | 'PAYMENT_PROVIDER' | 'AUDITOR';

export interface NewAuditEvent {
  readonly eventType: string;
  readonly actorType: AuditActorType;
  readonly actorId?: string;
  readonly intentId: string;
  readonly mandateId?: string;
  readonly mandateVersionId?: string;
  readonly attemptId?: string;
  readonly transactionId?: string;
  readonly correlationId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt?: Date;
}

interface AuditRow {
  id: string;
  event_version: number;
  event_type: string;
  occurred_at: Date;
  actor_type: AuditActorType;
  actor_id: string | null;
  intent_id: string;
  mandate_id: string | null;
  mandate_version_id: string | null;
  attempt_id: string | null;
  transaction_id: string | null;
  correlation_id: string;
  payload: Record<string, unknown>;
  previous_hash: Buffer | null;
  event_hash: Buffer;
}

export class AuditService {
  constructor(private readonly database: DatabaseClient) {}

  async append(event: NewAuditEvent) {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [event.intentId]);
      const previous = await client.query<{ event_hash: Buffer; occurred_at: Date }>(
        'SELECT event_hash, occurred_at FROM audit_events WHERE intent_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1',
        [event.intentId],
      );
      const id = randomUUID();
      const requestedTime = event.occurredAt ?? new Date();
      const previousTime = previous.rows[0]?.occurred_at.getTime() ?? 0;
      const occurredAt = new Date(Math.max(requestedTime.getTime(), previousTime + 1));
      const correlationId = event.correlationId ?? randomUUID();
      const previousHash = previous.rows[0]?.event_hash ?? null;
      const hashPayload = this.hashPayload({
        id,
        eventVersion: 1,
        eventType: event.eventType,
        occurredAt: occurredAt.toISOString(),
        actorType: event.actorType,
        actorId: event.actorId ?? null,
        intentId: event.intentId,
        mandateId: event.mandateId ?? null,
        mandateVersionId: event.mandateVersionId ?? null,
        attemptId: event.attemptId ?? null,
        transactionId: event.transactionId ?? null,
        correlationId,
        payload: event.payload,
        previousHash: previousHash?.toString('base64url') ?? null,
      });
      const eventHash = createHash('sha256').update(canonicalize(hashPayload), 'utf8').digest();
      const inserted = await client.query<AuditRow>(`INSERT INTO audit_events (
        id, event_version, event_type, occurred_at, actor_type, actor_id, intent_id,
        mandate_id, mandate_version_id, attempt_id, transaction_id, correlation_id,
        payload, previous_hash, event_hash
      ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *`, [
        id, event.eventType, occurredAt, event.actorType, event.actorId ?? null, event.intentId,
        event.mandateId ?? null, event.mandateVersionId ?? null, event.attemptId ?? null,
        event.transactionId ?? null, correlationId, event.payload, previousHash, eventHash,
      ]);
      await client.query('COMMIT');
      return this.serialize(inserted.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async list(intentId: string) {
    const result = await this.database.pool.query<AuditRow>(
      'SELECT * FROM audit_events WHERE intent_id = $1 ORDER BY occurred_at, id', [intentId],
    );
    return result.rows.map((row) => this.serialize(row));
  }

  async verifyChain(intentId: string) {
    const result = await this.database.pool.query<AuditRow>(
      'SELECT * FROM audit_events WHERE intent_id = $1 ORDER BY occurred_at, id', [intentId],
    );
    let previousHash: Buffer | null = null;
    for (const row of result.rows) {
      const priorHash = previousHash as Buffer | null;
      if (!(row.previous_hash === null && priorHash === null)
        && !(row.previous_hash && priorHash && row.previous_hash.equals(priorHash))) {
        return { valid: false, eventCount: result.rows.length, failedEventId: row.id };
      }
      const expected: Buffer = createHash('sha256').update(canonicalize(this.hashPayload({
        id: row.id,
        eventVersion: row.event_version,
        eventType: row.event_type,
        occurredAt: row.occurred_at.toISOString(),
        actorType: row.actor_type,
        actorId: row.actor_id,
        intentId: row.intent_id,
        mandateId: row.mandate_id,
        mandateVersionId: row.mandate_version_id,
        attemptId: row.attempt_id,
        transactionId: row.transaction_id,
        correlationId: row.correlation_id,
        payload: row.payload,
        previousHash: priorHash?.toString('base64url') ?? null,
      })), 'utf8').digest();
      if (!expected.equals(row.event_hash)) {
        return { valid: false, eventCount: result.rows.length, failedEventId: row.id };
      }
      previousHash = row.event_hash;
    }
    return { valid: true, eventCount: result.rows.length, failedEventId: null };
  }

  private hashPayload(value: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(canonicalize(value)) as Record<string, unknown>;
  }

  private serialize(row: AuditRow) {
    return {
      id: row.id,
      eventVersion: row.event_version,
      eventType: row.event_type,
      occurredAt: row.occurred_at,
      actorType: row.actor_type,
      actorId: row.actor_id,
      intentId: row.intent_id,
      mandateId: row.mandate_id,
      mandateVersionId: row.mandate_version_id,
      attemptId: row.attempt_id,
      transactionId: row.transaction_id,
      correlationId: row.correlation_id,
      payload: row.payload,
      previousHash: row.previous_hash?.toString('base64url') ?? null,
      eventHash: row.event_hash.toString('base64url'),
    };
  }
}
