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
  humanApprovals,
  mandateEvaluations,
  mandateProductConstraints,
  mandateRevocations,
  mandates,
  mandateVersions,
  merchants,
  products,
  purchaseIntents,
  paymentCredentials,
  receipts,
  transactions,
  users,
} from '../src/database/schema.js';
import { Es256CheckoutSigner, type CheckoutSigner } from '../src/modules/commerce/checkout-signer.js';
import type { CommerceProvider } from '../src/modules/commerce/commerce-types.js';
import { MockVuelaYaCommerceProvider } from '../src/modules/commerce/mock-vuelaya-commerce-provider.js';
import { VUELAYA_MERCHANT_ID } from '../src/modules/discovery/mock-vuelaya-provider.js';
import { Es256MandateSigner, type MandateSigner } from '../src/modules/mandates/mandate-signer.js';
import { approvalPayload } from '../src/modules/authorization/approval-evidence.js';
import { Ap2CredentialIssuer } from '../src/modules/mandates/ap2-credential.js';
import { MockPaymentCredentialProvider } from '../src/modules/payments/mock-payment-credential-provider.js';

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
  let mandateSigner: MandateSigner;
  let ap2TrustedIssuer: Ap2CredentialIssuer;
  let ap2AgentIssuer: Ap2CredentialIssuer;

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    signer = await Es256CheckoutSigner.create(await exportJWK(privateKey), 'vuela-ya-test-key');
    const mandateKeys = await generateKeyPair('ES256', { extractable: true });
    const trustedJwk = await exportJWK(mandateKeys.privateKey);
    mandateSigner = await Es256MandateSigner.create(trustedJwk, 'trusted-surface-test-key');
    ap2TrustedIssuer = await Ap2CredentialIssuer.create(
      trustedJwk, 'trusted-surface-test-key', 'urn:test:trusted-agent-provider',
    );
    const agentKeys = await generateKeyPair('ES256', { extractable: true });
    ap2AgentIssuer = await Ap2CredentialIssuer.create(
      await exportJWK(agentKeys.privateKey), 'shopping-agent-test-key', 'urn:test:shopping-agent',
    );
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
      mandateSigner,
      ap2TrustedIssuer,
      ap2AgentIssuer,
      paymentCredentialProvider: new MockPaymentCredentialProvider(signer),
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
        validUntil: '2030-12-31T23:59:59.000Z',
        requiresFinalConfirmation: true,
      },
    }).where(eq(purchaseIntents.id, intentId));
    const discovery = await client.post(`/api/v1/purchase-intents/${intentId}/discovery-runs`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', csrfToken).expect(201);
    const standardOffer = discovery.body.offers.find(
      (offer: { merchantProductId: string }) => offer.merchantProductId === 'VY-MEX-COR-130',
    );
    const expensiveOffer = discovery.body.offers.find(
      (offer: { merchantProductId: string }) => offer.merchantProductId === 'VY-MEX-COR-300',
    );
    if (!standardOffer || !expensiveOffer) throw new Error('VuelaYa integration offers are missing');

    const [mandate] = await database.db.insert(mandates).values({
      userId: registration.body.user.id,
      agentId: agent.body.agent.id,
      intentId,
      status: 'ACTIVE',
      mode: 'AUTONOMOUS',
      expiresAt: new Date('2030-12-31T23:59:59Z'),
    }).returning();
    const mandateEvidence = await mandateSigner.sign({});
    const [version] = await database.db.insert(mandateVersions).values({
      mandateId: mandate!.id,
      version: 1,
      status: 'ACTIVE',
      maxTotalMinor: 15_000n,
      currency: 'USD',
      validFrom: new Date('2026-01-01T00:00:00Z'),
      validUntil: new Date('2030-12-31T23:59:59Z'),
      requiresFinalConfirmation: true,
      canonicalPayload: {},
      payloadHash: mandateEvidence.payloadHash,
      signedPayload: mandateEvidence.signedPayload,
      signatureAlgorithm: mandateEvidence.signatureAlgorithm,
      signingKeyId: mandateEvidence.signingKeyId,
      signedAt: new Date(),
      allowedMerchantsAny: true,
    }).returning();
    await database.db.update(mandates).set({ currentVersionId: version!.id })
      .where(eq(mandates.id, mandate!.id));
    await database.db.insert(mandateProductConstraints).values({
      mandateVersionId: version!.id,
      matchType: 'CATEGORY',
      categoryPrefix: 'travel.flight',
      maxQuantity: 1,
    });
    return {
      client, csrfToken, intentId,
      userId: registration.body.user.id as string,
      mandateId: mandate!.id,
      offerId: standardOffer.id as string,
      expensiveOfferId: expensiveOffer.id as string,
    };
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
      completeCheckout: (checkout) => base.completeCheckout(checkout),
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
      completeCheckout: (checkout) => base.completeCheckout(checkout),
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
      completeCheckout: (checkout) => base.completeCheckout(checkout),
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
      completeCheckout: (checkout) => base.completeCheckout(checkout),
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

  it('pauses for checkout-bound approval and allows only after approval', async () => {
    const user = await prepare(new MockVuelaYaCommerceProvider(signer), 'approval@example.com');
    const attempt = await user.client.post(`/api/v1/purchase-intents/${user.intentId}/select-offer`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ offerId: user.offerId }).expect(201);
    const attemptId = attempt.body.attempt.id as string;

    await user.client.post(`/api/v1/purchase-attempts/${attemptId}/evaluate`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken).expect(200)
      .expect(({ body }) => expect(body.decision).toMatchObject({
        decision: 'REQUIRE_HUMAN_APPROVAL', reasonCode: 'HUMAN_APPROVAL_REQUIRED',
      }));
    const approved = await user.client.post(`/api/v1/purchase-attempts/${attemptId}/approval`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ decision: 'APPROVED' }).expect(201);
    expect(approved.body.decision).toMatchObject({
      decision: 'ALLOW', reasonCode: 'ALL_CONSTRAINTS_SATISFIED',
    });
    expect(approved.body.approval.checkoutHash).toBe(attempt.body.checkout.checkoutHash);

    const evaluations = await database.db.select().from(mandateEvaluations)
      .where(eq(mandateEvaluations.attemptId, attemptId));
    const approvals = await database.db.select().from(humanApprovals)
      .where(eq(humanApprovals.attemptId, attemptId));
    expect(evaluations.map((entry) => entry.decision)).toEqual([
      'REQUIRE_HUMAN_APPROVAL', 'REQUIRE_HUMAN_APPROVAL', 'ALLOW',
    ]);
    expect(approvals).toHaveLength(1);
  });

  it('does not let approval override an over-limit checkout', async () => {
    const user = await prepare(new MockVuelaYaCommerceProvider(signer), 'over-limit@example.com');
    const attempt = await user.client.post(`/api/v1/purchase-intents/${user.intentId}/select-offer`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ offerId: user.expensiveOfferId }).expect(201);
    const attemptId = attempt.body.attempt.id as string;

    await user.client.post(`/api/v1/purchase-attempts/${attemptId}/evaluate`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken).expect(200)
      .expect(({ body }) => expect(body.decision).toMatchObject({
        decision: 'DENY', reasonCode: 'AMOUNT_EXCEEDS_MANDATE',
      }));
    await user.client.post(`/api/v1/purchase-attempts/${attemptId}/approval`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ decision: 'APPROVED' }).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('AMOUNT_EXCEEDS_MANDATE'));
  });

  it('denies immediately when the mandate is revoked after approval', async () => {
    const user = await prepare(new MockVuelaYaCommerceProvider(signer), 'revoked-after-approval@example.com');
    const attempt = await user.client.post(`/api/v1/purchase-intents/${user.intentId}/select-offer`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ offerId: user.offerId }).expect(201);
    const attemptId = attempt.body.attempt.id as string;
    await user.client.post(`/api/v1/purchase-attempts/${attemptId}/approval`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ decision: 'APPROVED' }).expect(201);

    await database.db.insert(mandateRevocations).values({
      mandateId: user.mandateId,
      revokedByUserId: user.userId,
      reason: 'Trial by fire',
    });
    await user.client.post(`/api/v1/purchase-attempts/${attemptId}/evaluate`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken).expect(200)
      .expect(({ body }) => expect(body.decision).toMatchObject({
        decision: 'DENY', reasonCode: 'MANDATE_REVOKED',
      }));
  });

  it('rejects signed approval evidence after it expires', async () => {
    const user = await prepare(new MockVuelaYaCommerceProvider(signer), 'expired-approval@example.com');
    const attempt = await user.client.post(`/api/v1/purchase-intents/${user.intentId}/select-offer`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ offerId: user.offerId }).expect(201);
    const attemptId = attempt.body.attempt.id as string;
    await user.client.post(`/api/v1/purchase-attempts/${attemptId}/approval`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ decision: 'APPROVED' }).expect(201);
    const [approval] = await database.db.select().from(humanApprovals)
      .where(eq(humanApprovals.attemptId, attemptId));
    const decidedAt = new Date(Date.now() - 10 * 60 * 1000);
    const expiresAt = new Date(Date.now() - 5 * 60 * 1000);
    const evidence = await mandateSigner.sign(approvalPayload({
      approvalId: approval!.id,
      attemptId,
      userId: user.userId,
      mandateVersionId: approval!.mandateVersionId,
      checkoutId: approval!.checkoutId,
      checkoutHash: approval!.checkoutHash.toString('base64url'),
      decision: 'APPROVED',
      decidedAt,
      expiresAt,
    }));
    await database.db.update(humanApprovals).set({
      decidedAt, expiresAt, signedEvidence: evidence.signedPayload,
    }).where(eq(humanApprovals.id, approval!.id));

    await user.client.post(`/api/v1/purchase-attempts/${attemptId}/evaluate`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken).expect(200)
      .expect(({ body }) => expect(body.decision).toMatchObject({
        decision: 'DENY', reasonCode: 'HUMAN_APPROVAL_EXPIRED',
      }));
  });

  it('rejects signed approval evidence for a different mandate version', async () => {
    const user = await prepare(new MockVuelaYaCommerceProvider(signer), 'mismatched-approval@example.com');
    const attempt = await user.client.post(`/api/v1/purchase-intents/${user.intentId}/select-offer`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ offerId: user.offerId }).expect(201);
    const attemptId = attempt.body.attempt.id as string;
    await user.client.post(`/api/v1/purchase-attempts/${attemptId}/approval`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ decision: 'APPROVED' }).expect(201);
    const [otherVersion] = await database.db.insert(mandateVersions).values({
      mandateId: user.mandateId,
      version: 2,
      status: 'DRAFT',
      maxTotalMinor: 15_000n,
      currency: 'USD',
      validFrom: new Date('2026-01-01T00:00:00Z'),
      validUntil: new Date('2030-12-31T23:59:59Z'),
      canonicalPayload: {},
      allowedMerchantsAny: true,
    }).returning();
    const [approval] = await database.db.select().from(humanApprovals)
      .where(eq(humanApprovals.attemptId, attemptId));
    const evidence = await mandateSigner.sign(approvalPayload({
      approvalId: approval!.id,
      attemptId,
      userId: user.userId,
      mandateVersionId: otherVersion!.id,
      checkoutId: approval!.checkoutId,
      checkoutHash: approval!.checkoutHash.toString('base64url'),
      decision: 'APPROVED',
      decidedAt: approval!.decidedAt,
      expiresAt: approval!.expiresAt,
    }));
    await database.db.update(humanApprovals).set({
      mandateVersionId: otherVersion!.id,
      signedEvidence: evidence.signedPayload,
    }).where(eq(humanApprovals.id, approval!.id));

    await user.client.post(`/api/v1/purchase-attempts/${attemptId}/evaluate`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken).expect(200)
      .expect(({ body }) => expect(body.decision).toMatchObject({
        decision: 'DENY', reasonCode: 'HUMAN_APPROVAL_MISMATCH',
      }));
  });

  it('executes payment once and returns the same order on retry without exposing the token', async () => {
    const user = await prepare(new MockVuelaYaCommerceProvider(signer), 'payment@example.com');
    const attempt = await user.client.post(`/api/v1/purchase-intents/${user.intentId}/select-offer`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ offerId: user.offerId }).expect(201);
    const attemptId = attempt.body.attempt.id as string;
    await user.client.post(`/api/v1/purchase-attempts/${attemptId}/approval`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ decision: 'APPROVED' }).expect(201);

    const executed = await user.client.post(`/api/v1/purchase-attempts/${attemptId}/execute`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken).expect(200);
    expect(executed.body).toMatchObject({
      transaction: { status: 'SUCCEEDED', amountMinor: '13000' },
      order: { status: 'CONFIRMED', totalMinor: '13000' },
      credential: {
        status: 'CONSUMED',
        merchantId: VUELAYA_MERCHANT_ID,
        checkoutId: attempt.body.checkout.id,
        maxAmountMinor: '13000',
        currency: 'USD',
      },
    });
    expect(executed.body.credential).not.toHaveProperty('secret');
    expect(executed.body.credential).not.toHaveProperty('tokenHash');
    expect(executed.body.receipt.rawPayload.checkoutHash).toBe(attempt.body.checkout.checkoutHash);

    const retried = await user.client.post(`/api/v1/purchase-attempts/${attemptId}/execute`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken).expect(200);
    expect(retried.body.transaction.id).toBe(executed.body.transaction.id);
    expect(retried.body.order.id).toBe(executed.body.order.id);
    expect(await database.db.select().from(paymentCredentials)).toHaveLength(1);
    expect(await database.db.select().from(transactions)).toHaveLength(1);
    expect(await database.db.select().from(receipts)).toHaveLength(3);

    const transactionId = executed.body.transaction.id as string;
    await user.client.get('/api/v1/transactions').expect(200)
      .expect(({ body }) => expect(body.transactions).toHaveLength(1));
    await user.client.get(`/api/v1/transactions/${transactionId}`).expect(200)
      .expect(({ body }) => expect(body.order.id).toBe(executed.body.order.id));
    await user.client.get(`/api/v1/transactions/${transactionId}/receipt`).expect(200)
      .expect(({ body }) => expect(body.receipt.id).toBe(executed.body.receipt.id));
    const audit = await user.client.get(`/api/v1/transactions/${transactionId}/audit`).expect(200);
    expect(audit.body.integrity).toMatchObject({ valid: true });
    expect(audit.body.events.map((event: { eventType: string }) => event.eventType)).toEqual(
      expect.arrayContaining([
        'PURCHASE_INTENT_CREATED', 'DISCOVERY_COMPLETED', 'CHECKOUT_CREATED',
        'MANDATE_EVALUATED', 'HUMAN_APPROVAL_GRANTED', 'PAYMENT_SUCCEEDED',
        'ORDER_AND_RECEIPT_CREATED',
      ]),
    );
    expect(JSON.stringify(audit.body)).not.toContain('tokenHash');
    expect(JSON.stringify(audit.body)).not.toContain('secret');

    await database.db.update(users).set({ role: 'MERCHANT_OPERATOR' }).where(eq(users.id, user.userId));
    const merchant = await user.client.get(`/api/v1/merchant/verifications/${attemptId}`).expect(200);
    expect(merchant.body.integrity.valid).toBe(true);
    expect(merchant.body.events.some((event: { eventType: string }) =>
      event.eventType === 'MANDATE_EVALUATED')).toBe(true);

    await database.db.update(users).set({ role: 'HUMAN' }).where(eq(users.id, user.userId));
    const disputed = await user.client.post(`/api/v1/transactions/${transactionId}/disputes`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ reasonCode: 'NOT_RECOGNIZED', statement: 'I want the evidence reviewed.' }).expect(201);
    expect(disputed.body.dispute.status).toBe('EVIDENCE_ASSEMBLED');
    expect(disputed.body.evidence.verificationResult.valid).toBe(true);
    expect(disputed.body.evidence.bundle.credentialMetadata).not.toHaveProperty('token_hash');
    await user.client.get(`/api/v1/disputes/${disputed.body.dispute.id}`).expect(200);

    await database.db.update(users).set({ role: 'AUDITOR' }).where(eq(users.id, user.userId));
    const evidence = await user.client.get(`/api/v1/auditor/transactions/${transactionId}/evidence`).expect(200);
    expect(evidence.body.integrity.valid).toBe(true);
    expect(evidence.body.integrity.eventCount).toBeGreaterThan(0);
    expect(evidence.body.events.some((event: { eventType: string }) => event.eventType === 'PAYMENT_SUCCEEDED')).toBe(true);
    expect(evidence.body.facts.receipt.id).toBe(executed.body.receipt.id);
    await user.client.post(`/api/v1/disputes/${disputed.body.dispute.id}/resolve`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', user.csrfToken)
      .send({ status: 'RESOLVED_MERCHANT', summary: 'Evidence shows authorized purchase.' }).expect(200)
      .expect(({ body }) => expect(body.dispute.status).toBe('RESOLVED_MERCHANT'));

    await expect(database.pool.query(
      "UPDATE audit_events SET event_type = 'TAMPERED' WHERE intent_id = $1",
      [user.intentId],
    )).rejects.toThrow(/append-only/);
  });

  it('does not issue a credential without approval or after live revocation', async () => {
    const provider = new MockVuelaYaCommerceProvider(signer);
    const missing = await prepare(provider, 'payment-missing-approval@example.com');
    const missingAttempt = await missing.client
      .post(`/api/v1/purchase-intents/${missing.intentId}/select-offer`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', missing.csrfToken)
      .send({ offerId: missing.offerId }).expect(201);
    await missing.client.post(`/api/v1/purchase-attempts/${missingAttempt.body.attempt.id}/execute`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', missing.csrfToken).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('HUMAN_APPROVAL_REQUIRED'));
    expect(await database.db.select().from(paymentCredentials)).toHaveLength(0);

    const revoked = await prepare(provider, 'payment-revoked@example.com');
    const revokedAttempt = await revoked.client
      .post(`/api/v1/purchase-intents/${revoked.intentId}/select-offer`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', revoked.csrfToken)
      .send({ offerId: revoked.offerId }).expect(201);
    await revoked.client.post(`/api/v1/purchase-attempts/${revokedAttempt.body.attempt.id}/approval`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', revoked.csrfToken)
      .send({ decision: 'APPROVED' }).expect(201);
    await database.db.insert(mandateRevocations).values({
      mandateId: revoked.mandateId,
      revokedByUserId: revoked.userId,
      reason: 'Revoke before payment',
    });
    await revoked.client.post(`/api/v1/purchase-attempts/${revokedAttempt.body.attempt.id}/execute`)
      .set('Origin', frontendOrigin).set('X-CSRF-Token', revoked.csrfToken).expect(409)
      .expect(({ body }) => expect(body.error.code).toBe('MANDATE_REVOKED'));
    expect(await database.db.select().from(paymentCredentials)).toHaveLength(0);
  });
});
