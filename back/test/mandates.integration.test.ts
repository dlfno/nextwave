import { exportJWK, generateKeyPair } from 'jose';
import pino from 'pino';
import request, { type Response } from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { createDatabaseClient, type DatabaseClient } from '../src/database/client.js';
import { Es256MandateSigner } from '../src/modules/mandates/mandate-signer.js';
import { Ap2CredentialIssuer } from '../src/modules/mandates/ap2-credential.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const frontendOrigin = 'http://localhost:4200';
const testConfig: AppConfig = {
  port: 3000,
  databaseUrl: databaseUrl ?? 'postgresql://unused',
  frontendOrigin,
  sessionTtlHours: 12,
  cookieSecure: false,
  nodeEnv: 'test',
};

interface TestUser {
  client: ReturnType<typeof request.agent>;
  csrfToken: string;
  userId: string;
  agentId: string;
}

function readCookie(response: Response, name: string): string {
  const setCookies = response.headers['set-cookie'];
  const values = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : [];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Response did not set ${name}`);
  return cookie.split(';', 1)[0]!.slice(name.length + 1);
}

function isoDate(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

describe.skipIf(!databaseUrl)('mandate lifecycle', () => {
  let database: DatabaseClient;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    const trusted = await generateKeyPair('ES256', { extractable: true });
    const agent = await generateKeyPair('ES256', { extractable: true });
    const trustedJwk = await exportJWK(trusted.privateKey);
    const signer = await Es256MandateSigner.create(trustedJwk, 'test-trusted-surface-key');
    const ap2TrustedIssuer = await Ap2CredentialIssuer.create(
      trustedJwk, 'test-trusted-surface-key', 'urn:test:trusted-agent-provider',
    );
    const ap2AgentIssuer = await Ap2CredentialIssuer.create(
      await exportJWK(agent.privateKey), 'test-agent-key', 'urn:test:shopping-agent',
    );
    app = createApp({
      config: testConfig, database, logger: pino({ level: 'silent' }), mandateSigner: signer,
      ap2TrustedIssuer, ap2AgentIssuer,
    });
  });

  beforeEach(async () => {
    await database.pool.query('TRUNCATE TABLE users CASCADE');
  });

  async function createUser(email: string): Promise<TestUser> {
    const client = request.agent(app);
    const registration = await client
      .post('/api/v1/auth/register')
      .set('Origin', frontendOrigin)
      .send({ email, password: 'correct-horse-battery', displayName: 'Marta' })
      .expect(201);
    const csrfToken = readCookie(registration, 'nextwave_csrf');
    const agent = await client
      .post('/api/v1/agents')
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'Marta Purchasing Agent' })
      .expect(201);
    return {
      client,
      csrfToken,
      userId: registration.body.user.id as string,
      agentId: agent.body.agent.id as string,
    };
  }

  async function createFinalizedIntent(user: TestUser): Promise<string> {
    const created = await user.client
      .post('/api/v1/purchase-intents')
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .send({
        agentId: user.agentId,
        originalRequest: 'Buy me a flight to Córdoba if it costs less than $150.',
      })
      .expect(201);
    const intentId = created.body.intent.id as string;
    await user.client
      .post(`/api/v1/purchase-intents/${intentId}/messages`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .send({
        content: `Depart from Mexico City (MEX) to Córdoba, Argentina (COR), departing ${isoDate(30)}, one passenger, USD, valid until ${isoDate(7)}. No final confirmation.`,
      })
      .expect(201);
    await user.client
      .post(`/api/v1/purchase-intents/${intentId}/finalize-specifications`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .expect(200);
    return intentId;
  }

  async function createDraft(user: TestUser): Promise<string> {
    const intentId = await createFinalizedIntent(user);
    const draft = await user.client
      .post(`/api/v1/purchase-intents/${intentId}/mandates/draft`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .send({ mode: 'AUTONOMOUS' })
      .expect(201);
    return draft.body.mandate.id as string;
  }

  async function authorize(user: TestUser, mandateId: string) {
    return user.client
      .post(`/api/v1/mandates/${mandateId}/authorize`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .expect(200);
  }

  it('drafts normalized constraints and authorizes signed evidence after recent authentication', async () => {
    const user = await createUser('marta@example.com');
    const mandateId = await createDraft(user);
    const draft = await user.client.get(`/api/v1/mandates/${mandateId}`).expect(200);

    expect(draft.body.mandate).toMatchObject({ status: 'DRAFT', mode: 'AUTONOMOUS' });
    expect(draft.body.versions[0]).toMatchObject({
      version: 1,
      status: 'DRAFT',
      maxTotalMinor: '15000',
      currency: 'USD',
      signatureVerified: null,
    });

    await database.pool.query(
      "UPDATE sessions SET reauthenticated_at = now() - interval '10 minutes' WHERE user_id = $1",
      [user.userId],
    );
    await user.client
      .post(`/api/v1/mandates/${mandateId}/authorize`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .expect(403)
      .expect(({ body }) => expect(body.error.code).toBe('REAUTHENTICATION_REQUIRED'));

    await user.client
      .post('/api/v1/auth/reauthenticate')
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .send({ password: 'correct-horse-battery' })
      .expect(200);

    const active = await authorize(user, mandateId);
    expect(active.body.mandate.status).toBe('ACTIVE');
    expect(active.body.versions[0]).toMatchObject({
      version: 1,
      status: 'ACTIVE',
      signatureAlgorithm: 'ES256',
      signingKeyId: 'test-trusted-surface-key',
      signatureVerified: true,
    });
    expect(active.body.versions[0].signedPayload.split('.')).toHaveLength(3);
    expect(active.body.versions[0].canonicalPayload).toMatchObject({
      vct: 'com.nextwave.purchase-mandate.open.1',
      authorizedAgent: { id: user.agentId },
    });
    expect(active.body.versions[0].ap2OpenCheckoutPayload).toMatchObject({
      vct: 'mandate.checkout.open.1',
      cnf: { jwk: { kid: 'test-agent-key', kty: 'EC', crv: 'P-256' } },
    });
    expect(active.body.versions[0].ap2OpenPaymentPayload).toMatchObject({
      vct: 'mandate.payment.open.1',
      constraints: expect.arrayContaining([
        { type: 'payment.amount_range', currency: 'USD', min: 0, max: 15000 },
      ]),
    });
    expect(active.body.versions[0].ap2OpenCheckoutCredential.split('~')).toHaveLength(3);
  });

  it('keeps the active version until a replacement is authorized, then supersedes it atomically', async () => {
    const user = await createUser('marta@example.com');
    const mandateId = await createDraft(user);
    const firstActive = await authorize(user, mandateId);
    const firstSignedPayload = firstActive.body.versions[0].signedPayload as string;

    const replacementSpecification = {
      ...firstActive.body.versions[0].canonicalPayload.constraints,
      spendConstraints: { maxTotalMinor: '12000', currency: 'USD' },
      validUntil: `${isoDate(8)}T23:59:59Z`,
    };
    const drafted = await user.client
      .post(`/api/v1/mandates/${mandateId}/versions`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .send({ authorizationSpecification: replacementSpecification })
      .expect(201);

    expect(drafted.body.versions.map((version: { status: string }) => version.status)).toEqual(['ACTIVE', 'DRAFT']);

    const replaced = await user.client
      .post(`/api/v1/mandates/${mandateId}/versions/2/authorize`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .expect(200);

    expect(replaced.body.versions[0]).toMatchObject({ version: 1, status: 'SUPERSEDED' });
    expect(replaced.body.versions[0].signedPayload).toBe(firstSignedPayload);
    expect(replaced.body.versions[1]).toMatchObject({
      version: 2,
      status: 'ACTIVE',
      maxTotalMinor: '12000',
      signatureVerified: true,
    });
    expect(replaced.body.mandate.currentVersionId).toBe(replaced.body.versions[1].id);
  });

  it('revokes the mandate family immediately and idempotently', async () => {
    const user = await createUser('marta@example.com');
    const mandateId = await createDraft(user);
    await authorize(user, mandateId);

    const revoked = await user.client
      .post(`/api/v1/mandates/${mandateId}/revoke`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .send({ reason: 'No longer needed' })
      .expect(200);
    expect(revoked.body.mandate.status).toBe('REVOKED');
    expect(revoked.body.versions[0].status).toBe('REVOKED');
    expect(revoked.body.revocations).toHaveLength(1);

    const repeated = await user.client
      .post(`/api/v1/mandates/${mandateId}/revoke`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .send({ reason: 'Repeated click' })
      .expect(200);
    expect(repeated.body.revocations).toHaveLength(1);

    await user.client
      .post(`/api/v1/mandates/${mandateId}/versions`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .send({ authorizationSpecification: revoked.body.versions[0].canonicalPayload.constraints })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('MANDATE_REVOKED'));
  });

  it('derives expiration from authoritative database time on the next read', async () => {
    const user = await createUser('marta@example.com');
    const mandateId = await createDraft(user);
    await authorize(user, mandateId);

    await database.pool.query(
      "UPDATE mandates SET created_at = now() - interval '1 day', expires_at = now() - interval '1 second' WHERE id = $1",
      [mandateId],
    );
    const expired = await user.client.get(`/api/v1/mandates/${mandateId}`).expect(200);
    expect(expired.body.mandate.status).toBe('EXPIRED');
    expect(expired.body.versions[0].status).toBe('EXPIRED');
    expect(expired.body.versions[0].signatureVerified).toBe(true);
  });

  it('hides mandates from other users and prevents duplicate families for one intent', async () => {
    const marta = await createUser('marta@example.com');
    const intentId = await createFinalizedIntent(marta);
    const draft = await marta.client
      .post(`/api/v1/purchase-intents/${intentId}/mandates/draft`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', marta.csrfToken)
      .send({ mode: 'AUTONOMOUS' })
      .expect(201);

    await marta.client
      .post(`/api/v1/purchase-intents/${intentId}/mandates/draft`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', marta.csrfToken)
      .send({ mode: 'AUTONOMOUS' })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('MANDATE_ALREADY_EXISTS'));

    const other = await createUser('other@example.com');
    await other.client.get(`/api/v1/mandates/${draft.body.mandate.id}`).expect(404);
    await other.client
      .post(`/api/v1/mandates/${draft.body.mandate.id}/revoke`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', other.csrfToken)
      .send({ reason: 'Not mine' })
      .expect(404);
  });
});
