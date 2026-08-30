import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair } from 'jose';
import pino from 'pino';
import request, { type Response } from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { createDatabaseClient, type DatabaseClient } from '../src/database/client.js';
import {
  checkoutSessions,
  mandates,
  mandateVersions,
  merchants,
  products,
  purchaseIntents,
} from '../src/database/schema.js';
import { Es256CheckoutSigner, type CheckoutSigner } from '../src/modules/commerce/checkout-signer.js';
import type { CommerceProvider } from '../src/modules/commerce/commerce-types.js';
import { MockVuelaYaCommerceProvider } from '../src/modules/commerce/mock-vuelaya-commerce-provider.js';
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

describe.skipIf(!databaseUrl)('authoritative checkout API', () => {
  let database: DatabaseClient;
  let signer: CheckoutSigner;

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    signer = await Es256CheckoutSigner.create(await exportJWK(privateKey), 'vuela-ya-test-key');
  });

  beforeEach(async () => {
    await database.pool.query('TRUNCATE TABLE users CASCADE');
    await database.db.insert(merchants).values({
      id: VUELAYA_MERCHANT_ID, slug: 'vuela-ya', name: 'VuelaYa', status: 'ACTIVE',
    }).onConflictDoUpdate({ target: merchants.id, set: { status: 'ACTIVE' } });
    await database.db.insert(products).values([
      { id: '20000000-0000-4000-8000-000000000001', canonicalName: 'MEX to COR', category: 'travel.flight' },
      { id: '20000000-0000-4000-8000-000000000002', canonicalName: 'MEX to COR premium', category: 'travel.flight' },
    ]).onConflictDoNothing();
  });

  async function prepare(provider: CommerceProvider, email: string) {
    const app = createApp({
      config: testConfig,
      database,
      logger: pino({ level: 'silent' }),
      commerceProviders: [provider],
    });
    const client = request.agent(app);
    const registration = await client.post('/api/v1/auth/register').set('Origin', frontendOrigin)
      .send({ email, password: 'correct-horse-battery', displayName: 'Marta' }).expect(201);
    const csrfToken = readCookie(registration, 'nextwave_csrf');
    const agent = await client.post('/api/v1/agents').set('Origin', frontendOrigin)
      .set('X-CSRF-Token', csrfToken).send({ name: 'Purchasing Agent' }).expect(201);
    const intent = await client.post('/api/v1/purchase-intents').set('Origin', frontendOrigin)
      .set('X-CSRF-Token', csrfToken).send({
        agentId: agent.body.agent.id,
        originalRequest: 'Buy a MEX to COR flight below $150.',
      }).expect(201);
    const intentId = intent.body.intent.id as string;
    await database.db.update(purchaseIntents).set({
      status: 'MANDATE_AUTHORIZED',
      searchSpecification: {
        query: 'MEX to COR flight', category: 'travel.flight',
        origin: { city: 'Mexico City', iata: 'MEX' },
        destination: { city: 'Córdoba', country: 'Argentina', iata: 'COR' },
        departureDate: '2026-09-15', passengers: 1, currency: 'USD',
        rankingPreferences: ['lowest_total_price'],
      },
    }).where(eq(purchaseIntents.id, intentId));
    const discovery = await client.post(`/api/v1/purchase-intents/${intentId}/discovery-runs`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', csrfToken).expect(201);

    const [mandate] = await database.db.insert(mandates).values({
      userId: registration.body.user.id,
      agentId: agent.body.agent.id,
      intentId,
      status: 'ACTIVE',
      mode: 'AUTONOMOUS',
      expiresAt: new Date('2030-12-31T23:59:59Z'),
    }).returning();
    const [version] = await database.db.insert(mandateVersions).values({
      mandateId: mandate!.id,
      version: 1,
      status: 'ACTIVE',
      maxTotalMinor: 15_000n,
      currency: 'USD',
      validFrom: new Date('2026-01-01T00:00:00Z'),
      validUntil: new Date('2030-12-31T23:59:59Z'),
      canonicalPayload: {},
      payloadHash: Buffer.from('signed'),
      signedPayload: 'test-mandate-signature',
      signatureAlgorithm: 'ES256',
      signingKeyId: 'test-key',
      signedAt: new Date(),
      allowedMerchantsAny: true,
    }).returning();
    await database.db.update(mandates).set({ currentVersionId: version!.id })
      .where(eq(mandates.id, mandate!.id));
    return { client, csrfToken, intentId, offerId: discovery.body.offers[0].id as string };
  }

  it('creates and retrieves a valid authoritative signed checkout', async () => {
    const user = await prepare(new MockVuelaYaCommerceProvider(signer), 'happy@example.com');
    const created = await user.client.post(`/api/v1/purchase-intents/${user.intentId}/select-offer`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ offerId: user.offerId }).expect(201);

    expect(created.body).toMatchObject({
      attempt: { status: 'QUOTED' },
      quote: { totalMinor: '13000' },
      verification: { signatureValid: true, hashValid: true, expired: false, replayed: false, valid: true },
      priceDriftMinor: '0',
    });
    await user.client.get(`/api/v1/purchase-attempts/${created.body.attempt.id}`).expect(200)
      .expect(({ body }) => expect(body.verification.valid).toBe(true));
  });

  it('uses the live merchant price and reports drift from discovery', async () => {
    const provider = new MockVuelaYaCommerceProvider(signer, {
      'VY-MEX-COR-130': 14_000n,
      'VY-MEX-COR-300': 30_000n,
    });
    const user = await prepare(provider, 'drift@example.com');
    const created = await user.client.post(`/api/v1/purchase-intents/${user.intentId}/purchase-attempts`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ offerId: user.offerId }).expect(201);

    expect(created.body.quote.totalMinor).toBe('14000');
    expect(created.body.priceDriftMinor).toBe('1000');
  });

  it('rejects a checkout payload tampered after merchant signing', async () => {
    const base = new MockVuelaYaCommerceProvider(signer);
    const tampered: CommerceProvider = {
      id: base.id,
      merchantId: base.merchantId,
      getLiveQuote: (offer, now) => base.getLiveQuote(offer, now),
      async createCheckout(request) {
        const checkout = await base.createCheckout(request);
        return { ...checkout, payload: { ...checkout.payload, totalMinor: '30000' } };
      },
      verifyCheckout: (checkout) => base.verifyCheckout(checkout),
    };
    const user = await prepare(tampered, 'tamper@example.com');

    await user.client.post(`/api/v1/purchase-intents/${user.intentId}/select-offer`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ offerId: user.offerId }).expect(502)
      .expect(({ body }) => expect(body.error.code).toBe('CHECKOUT_SIGNATURE_INVALID'));
  });

  it('rejects expired quotes and validly signed but mismatched checkouts', async () => {
    const base = new MockVuelaYaCommerceProvider(signer);
    const expired: CommerceProvider = {
      id: base.id,
      merchantId: base.merchantId,
      async getLiveQuote(offer, now) {
        const quote = await base.getLiveQuote(offer, now);
        return { ...quote, expiresAt: now };
      },
      createCheckout: (request) => base.createCheckout(request),
      verifyCheckout: (checkout) => base.verifyCheckout(checkout),
    };
    const expiredUser = await prepare(expired, 'expired@example.com');
    await expiredUser.client.post(`/api/v1/purchase-intents/${expiredUser.intentId}/select-offer`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', expiredUser.csrfToken)
      .send({ offerId: expiredUser.offerId }).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('QUOTE_EXPIRED'));

    const mismatched: CommerceProvider = {
      id: base.id,
      merchantId: base.merchantId,
      getLiveQuote: (offer, now) => base.getLiveQuote(offer, now),
      async createCheckout(request) {
        const checkout = await base.createCheckout(request);
        const payload = { ...checkout.payload, quoteId: '00000000-0000-4000-8000-000000000099' };
        const signature = await signer.sign(payload);
        return { ...checkout, ...signature };
      },
      verifyCheckout: (checkout) => base.verifyCheckout(checkout),
    };
    const mismatchUser = await prepare(mismatched, 'mismatch@example.com');
    await mismatchUser.client.post(`/api/v1/purchase-intents/${mismatchUser.intentId}/select-offer`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', mismatchUser.csrfToken)
      .send({ offerId: mismatchUser.offerId }).expect(502)
      .expect(({ body }) => expect(body.error.code).toBe('CHECKOUT_BINDING_MISMATCH'));
  });

  it('detects stored checkout tampering and prevents replayed merchant checkout IDs', async () => {
    const base = new MockVuelaYaCommerceProvider(signer);
    const replaying: CommerceProvider = {
      id: base.id,
      merchantId: base.merchantId,
      getLiveQuote: (offer, now) => base.getLiveQuote(offer, now),
      async createCheckout(request) {
        const checkout = await base.createCheckout(request);
        const payload = { ...checkout.payload, providerCheckoutId: 'replayed-checkout-id' };
        const signature = await signer.sign(payload);
        return { ...checkout, providerCheckoutId: 'replayed-checkout-id', ...signature };
      },
      verifyCheckout: (checkout) => base.verifyCheckout(checkout),
    };
    const user = await prepare(replaying, 'replay@example.com');
    const first = await user.client.post(`/api/v1/purchase-intents/${user.intentId}/select-offer`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ offerId: user.offerId }).expect(201);
    await database.db.update(checkoutSessions).set({ signedCheckout: 'tampered' })
      .where(eq(checkoutSessions.attemptId, first.body.attempt.id));
    await user.client.get(`/api/v1/purchase-attempts/${first.body.attempt.id}`).expect(200)
      .expect(({ body }) => expect(body.verification.valid).toBe(false));

    await user.client.post(`/api/v1/purchase-intents/${user.intentId}/select-offer`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ offerId: user.offerId }).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('CHECKOUT_REPLAYED'));
  });
});
