import { eq } from 'drizzle-orm';
import pino from 'pino';
import request, { type Response } from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { createDatabaseClient, type DatabaseClient } from '../src/database/client.js';
import { merchants, products, purchaseIntents } from '../src/database/schema.js';
import { AEROSUR_MERCHANT_ID, NUBEVIA_MERCHANT_ID } from '../src/modules/discovery/mock-multi-merchant-providers.js';
import { VUELAYA_MERCHANT_ID } from '../src/modules/discovery/mock-vuelaya-provider.js';

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

function readCookie(response: Response, name: string): string {
  const values = response.headers['set-cookie'];
  const cookies = Array.isArray(values) ? values : values ? [values] : [];
  const cookie = cookies.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Response did not set ${name}`);
  return cookie.split(';', 1)[0]!.slice(name.length + 1);
}

describe.skipIf(!databaseUrl)('discovery API', () => {
  let database: DatabaseClient;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
    app = createApp({ config: testConfig, database, logger: pino({ level: 'silent' }) });
  });

  beforeEach(async () => {
    await database.pool.query('TRUNCATE TABLE users CASCADE');
    await database.db.insert(merchants).values([
      { id: VUELAYA_MERCHANT_ID, slug: 'vuela-ya', name: 'VuelaYa', status: 'ACTIVE' },
      { id: AEROSUR_MERCHANT_ID, slug: 'aerosur', name: 'AeroSur', status: 'ACTIVE' },
      { id: NUBEVIA_MERCHANT_ID, slug: 'nubevia', name: 'NubeVia', status: 'ACTIVE' },
    ]).onConflictDoUpdate({ target: merchants.id, set: { status: 'ACTIVE' } });
    await database.db.insert(products).values([
      {
        id: '20000000-0000-4000-8000-000000000001',
        canonicalName: 'Mexico City to Córdoba flight',
        category: 'travel.flight',
      },
      {
        id: '20000000-0000-4000-8000-000000000002',
        canonicalName: 'Mexico City to Córdoba premium flight',
        category: 'travel.flight',
      },
      {
        id: '20000000-0000-4000-8000-000000000003',
        canonicalName: 'AeroSur Mexico City to Córdoba flight',
        category: 'travel.flight',
      },
      {
        id: '20000000-0000-4000-8000-000000000004',
        canonicalName: 'NubeVia Mexico City to Córdoba flight',
        category: 'travel.flight',
      },
    ]).onConflictDoNothing();
  });

  async function preparedUser(email: string, authorized = true) {
    const client = request.agent(app);
    const registration = await client.post('/api/v1/auth/register').set('Origin', frontendOrigin)
      .send({ email, password: 'correct-horse-battery', displayName: 'Marta' }).expect(201);
    const csrfToken = readCookie(registration, 'nextwave_csrf');
    const agent = await client.post('/api/v1/agents').set('Origin', frontendOrigin)
      .set('X-CSRF-Token', csrfToken).send({ name: 'Purchasing Agent' }).expect(201);
    const intent = await client.post('/api/v1/purchase-intents').set('Origin', frontendOrigin)
      .set('X-CSRF-Token', csrfToken).send({
        agentId: agent.body.agent.id,
        originalRequest: 'Buy a Mexico City to Córdoba flight below $150.',
      }).expect(201);
    await database.db.update(purchaseIntents).set({
      status: authorized ? 'MANDATE_AUTHORIZED' : 'READY_FOR_MANDATE',
      searchSpecification: {
        query: 'Mexico City to Córdoba flight',
        category: 'travel.flight',
        origin: { city: 'Mexico City', iata: 'MEX' },
        destination: { city: 'Córdoba', country: 'Argentina', iata: 'COR' },
        departureDate: '2026-09-15',
        passengers: 1,
        currency: 'USD',
        rankingPreferences: ['lowest_total_price', 'departure_time'],
      },
      authorizationSpecification: {
        intentDraftHash: 'a'.repeat(64),
        productConstraints: {
          category: 'travel.flight',
          originIata: 'MEX',
          destinationIata: 'COR',
          departureDate: '2026-09-15',
          quantity: 1,
        },
        spendConstraints: { maxTotalMinor: '15000', currency: 'USD' },
        merchantConstraints: { allowedMerchants: 'ANY' },
        validUntil: '2026-09-30T23:59:59.000Z',
        requiresFinalConfirmation: true,
      },
    }).where(eq(purchaseIntents.id, intent.body.intent.id));
    return { client, csrfToken, intentId: intent.body.intent.id as string };
  }

  it('persists a completed run and exposes ranked non-authoritative offers', async () => {
    const user = await preparedUser('marta@example.com');
    const created = await user.client
      .post(`/api/v1/purchase-intents/${user.intentId}/discovery-runs`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken).expect(201);

    expect(created.body.run).toMatchObject({
      status: 'COMPLETED',
      providerIds: ['mock-vuelaya', 'mock-aerosur-api', 'mock-nubevia-ucp'],
    });
    expect(created.body.offers.map((offer: Record<string, unknown>) => ({
      rank: offer.rank,
      price: offer.unitPriceMinor,
      authoritative: offer.authoritative,
    }))).toEqual([
      { rank: 1, price: '11800', authoritative: false },
      { rank: 2, price: '13000', authoritative: false },
      { rank: 3, price: '14500', authoritative: false },
      { rank: 4, price: '30000', authoritative: false },
    ]);

    await user.client.get(`/api/v1/discovery-runs/${created.body.run.id}`).expect(200)
      .expect(({ body }) => expect(body.run.status).toBe('COMPLETED'));
    await user.client.get(`/api/v1/discovery-runs/${created.body.run.id}/offers`).expect(200)
      .expect(({ body }) => expect(body.offers.map((offer: { rank: number; unitPriceMinor: string }) => ({
        rank: offer.rank,
        price: offer.unitPriceMinor,
      }))).toEqual([
        { rank: 1, price: '11800' },
        { rank: 2, price: '13000' },
        { rank: 3, price: '14500' },
        { rank: 4, price: '30000' },
      ]));
  });

  it('requires an authorized mandate before discovery', async () => {
    const user = await preparedUser('not-authorized@example.com', false);

    await user.client.post(`/api/v1/purchase-intents/${user.intentId}/discovery-runs`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('MANDATE_AUTHORIZATION_REQUIRED'));
  });

  it('does not expose another user’s discovery run', async () => {
    const marta = await preparedUser('marta@example.com');
    const other = await preparedUser('other@example.com');
    const created = await marta.client.post(`/api/v1/purchase-intents/${marta.intentId}/discovery-runs`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', marta.csrfToken).expect(201);

    await other.client.get(`/api/v1/discovery-runs/${created.body.run.id}`).expect(404);
    await other.client.get(`/api/v1/discovery-runs/${created.body.run.id}/offers`).expect(404);
  });
});
