import pino from 'pino';
import request, { type Response } from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { createDatabaseClient, type DatabaseClient } from '../src/database/client.js';
import type {
  ClarificationResult,
  ConversationMessage,
  PurchasingAgentProvider,
} from '../src/modules/purchase-intents/purchasing-agent-provider.js';

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
  agentId: string;
}

function readCookie(response: Response, name: string): string {
  const setCookies = response.headers['set-cookie'];
  const values = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : [];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Response did not set ${name}`);
  return cookie.split(';', 1)[0]!.slice(name.length + 1);
}

describe.skipIf(!databaseUrl)('purchase intent conversation and specifications', () => {
  let database: DatabaseClient;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
    app = createApp({ config: testConfig, database, logger: pino({ level: 'silent' }) });
  });

  beforeEach(async () => {
    await database.pool.query('TRUNCATE TABLE users CASCADE');
  });

  async function createUser(email: string, targetApp = app): Promise<TestUser> {
    const client = request.agent(targetApp);
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
      .send({ name: 'Purchasing Agent' })
      .expect(201);
    return { client, csrfToken, agentId: agent.body.agent.id as string };
  }

  async function createFlightIntent(user: TestUser) {
    return user.client
      .post('/api/v1/purchase-intents')
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .send({
        agentId: user.agentId,
        originalRequest: 'Buy me a flight to Córdoba if it costs less than $150.',
      })
      .expect(201);
  }

  it('creates an intent and asks for missing, ambiguous purchase facts', async () => {
    const user = await createUser('marta@example.com');
    const created = await createFlightIntent(user);

    expect(created.body.intent.status).toBe('CLARIFYING');
    expect(created.body.messages).toHaveLength(2);
    expect(created.body.messages[1].structuredPayload.missingFields).toEqual(
      expect.arrayContaining(['origin', 'destination', 'departureDate', 'passengers', 'currency', 'validUntil']),
    );
    expect(created.body.messages[1].structuredPayload.missingFields).not.toContain('maxTotal');
  });

  it('refuses to finalize an incomplete conversation', async () => {
    const user = await createUser('marta@example.com');
    const created = await createFlightIntent(user);

    await user.client
      .post(`/api/v1/purchase-intents/${created.body.intent.id}/finalize-specifications`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .expect(409)
      .expect(({ body }) => {
        expect(body.error.code).toBe('CLARIFICATION_REQUIRED');
        expect(body.error.details.missingFields).toContain('origin');
      });
  });

  it('finalizes separate search and authorization specifications after clarification', async () => {
    const user = await createUser('marta@example.com');
    const created = await createFlightIntent(user);
    const intentId = created.body.intent.id as string;

    const clarified = await user.client
      .post(`/api/v1/purchase-intents/${intentId}/messages`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .send({
        content: 'Depart from Mexico City (MEX) to Córdoba, Argentina (COR), departing 2026-09-15, one passenger, USD, valid until 2026-09-05. No final confirmation.',
      })
      .expect(201);

    expect(clarified.body).toMatchObject({ status: 'READY_FOR_MANDATE', ready: true });

    const finalized = await user.client
      .post(`/api/v1/purchase-intents/${intentId}/finalize-specifications`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .expect(200);

    expect(finalized.body.searchSpecification).toMatchObject({
      category: 'travel.flight',
      origin: { iata: 'MEX' },
      destination: { iata: 'COR', country: 'Argentina' },
      departureDate: '2026-09-15',
      passengers: 1,
    });
    expect(finalized.body.authorizationSpecification).toEqual({
      intentDraftHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      productConstraints: {
        category: 'travel.flight',
        originIata: 'MEX',
        destinationIata: 'COR',
        departureDate: '2026-09-15',
        quantity: 1,
      },
      spendConstraints: { maxTotalMinor: '15000', currency: 'USD' },
      merchantConstraints: { allowedMerchants: 'ANY' },
      validUntil: '2026-09-05T23:59:59Z',
      requiresFinalConfirmation: false,
    });

    const detail = await user.client.get(`/api/v1/purchase-intents/${intentId}`).expect(200);
    expect(detail.body.messages).toHaveLength(4);
    expect(detail.body.intent.searchSpecification).toEqual(finalized.body.searchSpecification);
    expect(detail.body.intent.authorizationSpecification).toEqual(finalized.body.authorizationSpecification);

    const list = await user.client.get('/api/v1/purchase-intents').expect(200);
    expect(list.body.intents).toHaveLength(1);
    expect(list.body.intents[0]).toMatchObject({ id: intentId, status: 'READY_FOR_MANDATE' });

    await user.client
      .post(`/api/v1/purchase-intents/${intentId}/messages`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .send({ content: 'Change it after finalization.' })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('INTENT_ALREADY_FINALIZED'));
  });

  it('does not reveal or modify another user’s intents or agents', async () => {
    const marta = await createUser('marta@example.com');
    const other = await createUser('other@example.com');
    const created = await createFlightIntent(marta);

    await other.client.get(`/api/v1/purchase-intents/${created.body.intent.id}`).expect(404);
    await other.client
      .post(`/api/v1/purchase-intents/${created.body.intent.id}/messages`)
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', other.csrfToken)
      .send({ content: 'Attempted cross-user update.' })
      .expect(404);

    await other.client
      .post('/api/v1/purchase-intents')
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', other.csrfToken)
      .send({ agentId: marta.agentId, originalRequest: 'Use another user agent.' })
      .expect(404);
  });

  it('rejects provider output that does not match the specification schemas', async () => {
    const invalidProvider: PurchasingAgentProvider = {
      async analyze(_messages: ConversationMessage[]): Promise<ClarificationResult> {
        return { ready: true, missingFields: [], message: 'Ready.' };
      },
    };
    const invalidApp = createApp({
      config: testConfig,
      database,
      logger: pino({ level: 'silent' }),
      agentProvider: invalidProvider,
    });
    const user = await createUser('invalid-provider@example.com', invalidApp);
    await user.client
      .post('/api/v1/purchase-intents')
      .set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken)
      .send({ agentId: user.agentId, originalRequest: 'A complete request according to the provider.' })
      .expect(502)
      .expect(({ body }) => expect(body.error.code).toBe('AGENT_OUTPUT_INVALID'));
  });

  it('does not finalize a complete-looking draft while the provider reports a violation', async () => {
    const flaggedProvider: PurchasingAgentProvider = {
      async analyze(): Promise<ClarificationResult> {
        return {
          ready: false,
          missingFields: ['validUntil'],
          message: 'The expiration must be corrected.',
          draft: {
            origin: { city: 'Mexico City', iata: 'MEX' },
            destination: { city: 'Córdoba', country: 'Argentina', iata: 'COR' },
            departureDate: '2026-09-15', passengers: 1, maxTotalMinor: '15000', currency: 'USD',
            validUntil: '2027-09-15T23:59:59Z', requiresFinalConfirmation: true,
            sources: { origin: 0, destination: 0, departureDate: 0, passengers: 0, maxTotalMinor: 0, currency: 0, validUntil: 0, requiresFinalConfirmation: 0 },
          },
          metadata: {
            ambiguous: [], defaultsApplied: [], superseded: [],
            flags: {
              injectionAttempts: [],
              violations: [{ key: 'validUntil', reason: 'Expiration exceeds 30 days' }],
              outOfCatalog: [],
            },
          },
        };
      },
    };
    const flaggedApp = createApp({
      config: testConfig, database, logger: pino({ level: 'silent' }), agentProvider: flaggedProvider,
    });
    const user = await createUser('flagged-provider@example.com', flaggedApp);
    const created = await user.client.post('/api/v1/purchase-intents').set('Origin', frontendOrigin)
      .set('X-CSRF-Token', user.csrfToken).send({
        agentId: user.agentId,
        originalRequest: 'Buy one MEX to COR flight under USD 150 with a one-year mandate.',
      }).expect(201);
    expect(created.body.intent.status).toBe('CLARIFYING');
    expect(created.body.messages[1].structuredPayload.flags.violations).toHaveLength(1);
    await user.client.post(`/api/v1/purchase-intents/${created.body.intent.id}/finalize-specifications`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('CLARIFICATION_REQUIRED'));
  });
});
