import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import argon2 from 'argon2';

import { createDatabaseClient } from '../database/client.js';
import { compileSpecifications, hashIntentDraft, type FlightIntentDraft } from '../modules/purchase-intents/flight-intent-draft.js';
import { Es256MandateSigner } from '../modules/mandates/mandate-signer.js';
import { MandateService } from '../modules/mandates/mandate-service.js';
import { Ap2CredentialIssuer } from '../modules/mandates/ap2-credential.js';

const databaseUrl = process.env.DATABASE_URL;
const password = process.env.DEMO_ACCOUNT_PASSWORD;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!password || password.length < 12) throw new Error('DEMO_ACCOUNT_PASSWORD must be at least 12 characters');
const demoPassword = password;
const mandateSigningPrivateJwk = process.env.MANDATE_SIGNING_PRIVATE_JWK
  ?? await readFile('/app/runtime-secrets/mandate-signing.jwk', 'utf8').catch(() => undefined);
const agentSigningPrivateJwk = process.env.AGENT_SIGNING_PRIVATE_JWK
  ?? await readFile('/app/runtime-secrets/agent-signing.jwk', 'utf8').catch(() => undefined);
const demoUserId = '30000000-0000-4000-8000-000000000001';
const demoAgentId = '31000000-0000-4000-8000-000000000001';
const demoIntentId = '32000000-0000-4000-8000-000000000001';

const database = createDatabaseClient(databaseUrl);
const client = await database.pool.connect();
try {
  if (process.env.DEMO_RESET_IF_EMPTY === 'true') {
    const existing = await client.query<{ exists: boolean }>('SELECT EXISTS (SELECT 1 FROM users) AS exists');
    if (existing.rows[0]?.exists) {
      await ensureDefaultDemoPurchase();
      process.stdout.write('Demo accounts already exist; default comparison mandate is ready.\n');
      process.exitCode = 0;
    } else {
      await reset();
    }
  } else {
    await reset();
  }
} finally {
  client.release();
  await database.pool.end();
}

async function reset(): Promise<void> {
  const passwordHash = await argon2.hash(demoPassword, { type: argon2.argon2id });
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE users CASCADE');
    await client.query(`INSERT INTO users (id, email, password_hash, display_name, role) VALUES
      ('30000000-0000-4000-8000-000000000001', 'marta@nextwave.demo', $1, 'Marta Pérez', 'HUMAN'),
      ('30000000-0000-4000-8000-000000000002', 'merchant@nextwave.demo', $1, 'VuelaYa Operator', 'MERCHANT_OPERATOR'),
      ('30000000-0000-4000-8000-000000000003', 'auditor@nextwave.demo', $1, 'Independent Auditor', 'AUDITOR')`, [passwordHash]);
    await ensureDemoMerchantOperator();
    await client.query(`INSERT INTO agents (id, owner_user_id, name, status, current_key_id) VALUES
      ('31000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001',
       'Marta purchasing agent', 'ACTIVE', 'demo-agent-key-1')`);
    await client.query('COMMIT');
    await ensureDefaultDemoPurchase();
    process.stdout.write('Demo state reset: 3 accounts, 1 purchasing agent, and 1 active comparison mandate.\n');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function ensureDefaultDemoPurchase(): Promise<void> {
  const account = await client.query('SELECT 1 FROM users WHERE id = $1', [demoUserId]);
  if (!account.rowCount) return;
  await ensureDemoMerchantOperator();
  const draft: FlightIntentDraft = {
    origin: { city: 'Mexico City', iata: 'MEX' },
    destination: { city: 'Córdoba', country: 'Argentina', iata: 'COR' },
    departureDate: '2026-09-15',
    passengers: 1,
    maxTotalMinor: '15000',
    currency: 'USD',
    validUntil: '2026-09-30T23:59:59.000Z',
    requiresFinalConfirmation: true,
    sources: {
      origin: 0,
      destination: 0,
      departureDate: 0,
      passengers: 0,
      maxTotalMinor: 0,
      currency: 0,
      validUntil: 0,
      requiresFinalConfirmation: 0,
    },
  };
  const specifications = compileSpecifications(draft);
  if (!mandateSigningPrivateJwk) {
    throw new Error('MANDATE_SIGNING_PRIVATE_JWK or the persisted Docker signing key is required');
  }
  if (!agentSigningPrivateJwk) {
    throw new Error('AGENT_SIGNING_PRIVATE_JWK or the persisted Docker agent key is required');
  }
  const trustedJwk = JSON.parse(mandateSigningPrivateJwk) as Record<string, unknown>;
  const agentJwk = JSON.parse(agentSigningPrivateJwk) as Record<string, unknown>;
  const signer = await Es256MandateSigner.create(
    trustedJwk,
    process.env.MANDATE_SIGNING_KEY_ID ?? 'nextwave-mandate-1',
  );
  const ap2TrustedIssuer = await Ap2CredentialIssuer.create(
    trustedJwk,
    process.env.MANDATE_SIGNING_KEY_ID ?? 'nextwave-mandate-1',
    'urn:nextwave:trusted-agent-provider',
  );
  const ap2AgentIssuer = await Ap2CredentialIssuer.create(
    agentJwk,
    process.env.AGENT_SIGNING_KEY_ID ?? 'nextwave-shopping-agent-1',
    'urn:nextwave:shopping-agent',
  );
  const mandateService = new MandateService(database, signer, ap2TrustedIssuer, ap2AgentIssuer);
  const existing = await client.query<{
    mandate_id: string;
    mandate_status: string;
    version: number;
    signed_payload: string | null;
    ap2_open_checkout_credential: string | null;
    ap2_open_payment_credential: string | null;
    canonical_payload: Record<string, unknown>;
  }>(
    `SELECT m.id AS mandate_id, m.status AS mandate_status, mv.version, mv.signed_payload,
       mv.ap2_open_checkout_credential, mv.ap2_open_payment_credential, mv.canonical_payload
     FROM purchase_intents pi
     LEFT JOIN mandates m ON m.intent_id = pi.id
     LEFT JOIN mandate_versions mv ON mv.id = m.current_version_id
     WHERE pi.id = $1`,
    [demoIntentId],
  );
  if (existing.rowCount) {
    const current = existing.rows[0];
    if (current?.mandate_status === 'REVOKED' || current?.mandate_status === 'EXPIRED') return;
    if (current?.signed_payload && current.ap2_open_checkout_credential
      && current.ap2_open_payment_credential
      && await signer.verify(current.signed_payload, current.canonical_payload)) return;
    if (!current?.mandate_id) throw new Error('Default demo intent exists without its mandate');
    const rotated = await mandateService.createVersion(
      demoUserId,
      current.mandate_id,
      specifications.authorizationSpecification,
    );
    const nextVersion = Math.max(...rotated.versions.map((version) => version.version));
    await mandateService.authorize(demoUserId, current.mandate_id, nextVersion);
    return;
  }

  const request = 'Buy one MEX to COR flight on September 15, 2026 under USD 150 with final approval.';
  await client.query(
    `INSERT INTO purchase_intents (
      id, user_id, agent_id, status, original_request, client_context, intent_draft,
      intent_draft_hash, search_specification, authorization_specification
    ) VALUES ($1, $2, $3, 'READY_FOR_MANDATE', $4, $5, $6, $7, $8, $9)`,
    [
      demoIntentId,
      demoUserId,
      demoAgentId,
      request,
      { timeZone: 'America/Mexico_City', locale: 'en-US', observedAt: new Date().toISOString() },
      draft,
      hashIntentDraft(draft),
      specifications.searchSpecification,
      specifications.authorizationSpecification,
    ],
  );
  await client.query(
    `INSERT INTO intent_messages (intent_id, role, content, structured_payload, sequence) VALUES
      ($1, 'USER', $2, NULL, 0),
      ($1, 'AGENT', $3, $4, 1)`,
    [
      demoIntentId,
      request,
      'Everything is ready. Your default demo mandate can now compare merchants safely.',
      { type: 'SPECIFICATIONS_READY', missingFields: [] },
    ],
  );

  const created = await mandateService.createDraft(demoUserId, demoIntentId, 'AUTONOMOUS');
  await mandateService.authorize(demoUserId, created.mandate.id);
}

async function ensureDemoMerchantOperator(): Promise<void> {
  await client.query(`INSERT INTO merchant_operator_assignments (merchant_id, user_id)
    SELECT '10000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002'
    WHERE EXISTS (SELECT 1 FROM merchants WHERE id = '10000000-0000-4000-8000-000000000001')
    ON CONFLICT (merchant_id, user_id) DO NOTHING`);
}
