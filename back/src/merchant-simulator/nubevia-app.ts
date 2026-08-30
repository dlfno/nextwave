import { createHash, randomUUID } from 'node:crypto';

import express, { type Express } from 'express';
import { compactVerify, decodeProtectedHeader, importJWK, type JWK } from 'jose';
import { z } from 'zod';

import { Es256CheckoutSigner } from '../modules/commerce/checkout-signer.js';
import { NUBEVIA_MERCHANT_ID } from '../modules/discovery/mock-multi-merchant-providers.js';
import {
  ap2CheckoutReceiptSchema, ap2CredentialHash, ap2TransactionAuthorizationSchema,
} from '../modules/mandates/ap2-credential.js';
import { searchSpecificationSchema } from '../modules/purchase-intents/specifications.js';

const UCP_VERSION = '2026-04-08';
const PRODUCT_ID = '20000000-0000-4000-8000-000000000004';
const MERCHANT_PRODUCT_ID = 'NV-MEX-COR-145';
const DISCOVERY_PRICE_MINOR = '14500';
const LIVE_PRICE_MINOR = 14_200;
const DEPARTURE_TIME = '2026-09-15T12:45:00Z';

const offerReferenceSchema = z.object({
  offerId: z.uuid(), merchantId: z.literal(NUBEVIA_MERCHANT_ID),
  merchantProductId: z.literal(MERCHANT_PRODUCT_ID), productId: z.uuid().nullable(),
  productName: z.string().min(1), category: z.literal('travel.flight'),
  discoveredUnitPriceMinor: z.string().regex(/^\d+$/), currency: z.literal('USD'),
}).strict();

const checkoutCreateSchema = z.object({
  line_items: z.array(z.object({
    item: z.object({ id: z.literal(MERCHANT_PRODUCT_ID) }).passthrough(), quantity: z.literal(1),
  }).passthrough()).length(1),
}).passthrough();

const checkoutCompleteSchema = z.object({
  payment: z.object({ instruments: z.array(z.object({
    id: z.string().min(1), handler_id: z.string().min(1), type: z.string().min(1),
    selected: z.literal(true), display: z.object({ description: z.string() }).optional(),
    credential: z.object({ type: z.string().min(1), token: z.string().min(1) }).passthrough(),
  }).passthrough()).length(1) }).strict(),
  ap2: z.object({ checkout_mandate: z.string().min(1) }).strict(),
}).strict();

interface StoredCheckout {
  readonly merchantOrderId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly signedPayload: string;
  readonly expiresAt: string;
  completedAt?: string;
  checkoutReceipt?: Awaited<ReturnType<Es256CheckoutSigner['signReceipt']>>;
}

export interface NubeViaSimulatorOptions {
  readonly privateJwk: JWK;
  readonly keyId?: string;
  readonly platformKeys?: readonly JWK[];
  readonly platformProfileUrl?: string;
  readonly fetchFn?: typeof fetch;
}

export async function createNubeViaSimulator(options: NubeViaSimulatorOptions): Promise<Express> {
  const keyId = options.keyId ?? 'nubevia-checkout-1';
  const signer = await Es256CheckoutSigner.create(options.privateJwk, keyId);
  const checkouts = new Map<string, StoredCheckout>();
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.get('/health', (_request, response) => response.json({ status: 'ok', merchant: 'NubeVia' }));
  app.get('/.well-known/jwks.json', (_request, response) => response.json({ keys: [signer.publicJwk()] }));
  app.get('/.well-known/ucp', (_request, response) => response.json(businessProfile(signer.publicJwk())));

  // Discovery is merchant-specific. UCP becomes authoritative at checkout.
  app.post('/merchant/v1/search', (request, response) => {
    const input = z.object({ specification: searchSpecificationSchema, observedAt: z.iso.datetime() })
      .strict().parse(request.body);
    const spec = input.specification;
    const matches = spec.origin.iata === 'MEX' && spec.destination.iata === 'COR'
      && spec.departureDate === '2026-09-15' && spec.passengers === 1 && spec.currency === 'USD';
    response.json({ offers: matches ? [{
      merchantProductId: MERCHANT_PRODUCT_ID, productId: PRODUCT_ID,
      productName: 'NubeVia Mexico City to Córdoba',
      description: 'Flexible economy fare discovered through the NubeVia merchant catalog.',
      category: 'travel.flight', unitPriceMinor: DISCOVERY_PRICE_MINOR, currency: 'USD',
      availability: 'IN_STOCK', departureTime: DEPARTURE_TIME,
      attributes: { origin: 'MEX', destination: 'COR', passengers: 1,
        departureDate: '2026-09-15', departureTime: DEPARTURE_TIME, fareClass: 'Flexible economy' },
    }] : [] });
  });

  app.post('/merchant/v1/quotes', (request, response) => {
    const input = z.object({ offer: offerReferenceSchema, currentTime: z.iso.datetime() })
      .strict().parse(request.body);
    const observedAt = new Date(input.currentTime);
    const expiresAt = new Date(observedAt.getTime() + 5 * 60 * 1000);
    const providerQuoteId = `nv-quote-${randomUUID()}`;
    const lineItem = {
      merchantProductId: MERCHANT_PRODUCT_ID, productId: input.offer.productId,
      productName: 'NubeVia Mexico City to Córdoba', category: 'travel.flight' as const,
      originIata: 'MEX' as const, destinationIata: 'COR' as const,
      departureDate: '2026-09-15' as const, quantity: 1,
      unitPriceMinor: LIVE_PRICE_MINOR.toString(), totalMinor: LIVE_PRICE_MINOR.toString(),
      currency: 'USD' as const,
    };
    const payload = {
      merchantId: NUBEVIA_MERCHANT_ID, providerQuoteId, offerId: input.offer.offerId,
      totalMinor: LIVE_PRICE_MINOR.toString(), currency: 'USD', observedAt: observedAt.toISOString(),
      expiresAt: expiresAt.toISOString(), lineItems: [lineItem],
    };
    response.json({ ...payload, payload });
  });

  app.post('/checkout-sessions', async (request, response) => {
    const input = checkoutCreateSchema.parse(request.body);
    const providerCheckoutId = `nv-checkout-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const baseCheckout = {
      ucp: { version: UCP_VERSION, status: 'success' }, id: providerCheckoutId,
      line_items: [{ id: `li-${randomUUID()}`, item: {
        id: MERCHANT_PRODUCT_ID, title: 'NubeVia Mexico City to Córdoba', price: LIVE_PRICE_MINOR,
      }, quantity: input.line_items[0]!.quantity,
      totals: [{ type: 'subtotal', amount: LIVE_PRICE_MINOR }, { type: 'total', amount: LIVE_PRICE_MINOR }] }],
      status: 'ready_for_complete', currency: 'USD',
      totals: [{ type: 'subtotal', amount: LIVE_PRICE_MINOR }, { type: 'total', amount: LIVE_PRICE_MINOR }],
      links: [
        { type: 'terms_of_service', url: 'https://nubevia.example/terms' },
        { type: 'privacy_policy', url: 'https://nubevia.example/privacy' },
      ], expires_at: expiresAt,
    };
    const merchantAuthorization = await signer.signDetached(baseCheckout);
    const payload = { ...baseCheckout, ap2: { merchant_authorization: merchantAuthorization } };
    const signature = await signer.sign(payload);
    checkouts.set(providerCheckoutId, {
      merchantOrderId: `NV-ORDER-${randomUUID()}`, payload: signature.payload,
      signedPayload: signature.signedPayload, expiresAt,
    });
    response.status(201).json({ payload: signature.payload,
      payloadHash: signature.payloadHash.toString('base64url'), signedPayload: signature.signedPayload });
  });

  app.post('/checkout-sessions/:providerCheckoutId/complete', async (request, response) => {
    const input = checkoutCompleteSchema.parse(request.body);
    const providerCheckoutId = request.params['providerCheckoutId']!;
    const checkout = checkouts.get(providerCheckoutId);
    if (!checkout) {
      response.status(404).json(ucpError('checkout_not_found', 'Checkout does not exist'));
      return;
    }
    if (checkout.completedAt) {
      response.json(completedCheckout(checkout));
      return;
    }
    if (new Date(checkout.expiresAt) <= new Date()) {
      response.status(409).json(ucpError('checkout_expired', 'Checkout expired'));
      return;
    }
    const paymentToken = input.payment.instruments[0]!.credential.token;
    if (paymentToken !== input.ap2.checkout_mandate) {
      response.status(400).json(ucpError('mandate_scope_mismatch', 'Payment and checkout mandates differ'));
      return;
    }
    const verified = await verifyMandate(input.ap2.checkout_mandate, checkout, await platformKeys(options));
    if (!verified.ok) {
      response.status(400).json(ucpError(verified.code, 'AP2 checkout mandate verification failed'));
      return;
    }
    checkout.completedAt = new Date().toISOString();
    checkout.checkoutReceipt = await signer.signReceipt(ap2CheckoutReceiptSchema.parse({
      status: 'Success', iss: 'urn:nubevia:merchant',
      iat: Math.floor(new Date(checkout.completedAt).getTime() / 1_000),
      reference: ap2CredentialHash(input.ap2.checkout_mandate), order_id: checkout.merchantOrderId,
    }));
    response.json(completedCheckout(checkout));
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) {
      response.status(400).json(ucpError('invalid_request', 'Invalid UCP request', error.issues));
      return;
    }
    response.status(500).json(ucpError('internal_error', 'NubeVia could not process the request'));
  });
  return app;
}

function businessProfile(publicJwk: Readonly<Record<string, unknown>>) {
  return { ucp: { version: UCP_VERSION, services: {
    'dev.ucp.shopping': [{ version: UCP_VERSION, transport: 'rest', endpoint: 'http://nubevia:3100' }],
  }, capabilities: {
    'dev.ucp.shopping.checkout': [{ version: UCP_VERSION,
      spec: `https://ucp.dev/${UCP_VERSION}/specification/shopping/checkout`,
      schema: `https://ucp.dev/${UCP_VERSION}/schemas/shopping/checkout.json` }],
    'dev.ucp.common.payment.ap2_mandate': [{ version: UCP_VERSION,
      spec: `https://ucp.dev/${UCP_VERSION}/specification/payment/extensions/ap2-mandates`,
      schema: `https://ucp.dev/${UCP_VERSION}/schemas/common/payment_ap2_mandate.json`,
      extends: 'dev.ucp.shopping.checkout', config: { vp_formats_supported: { 'dc+sd-jwt': {} } } }],
  }, payment_handlers: {} }, keys: [publicJwk] };
}

async function platformKeys(options: NubeViaSimulatorOptions): Promise<readonly JWK[]> {
  if (options.platformKeys?.length) return options.platformKeys;
  if (!options.platformProfileUrl) return [];
  const response = await (options.fetchFn ?? fetch)(options.platformProfileUrl, {
    signal: AbortSignal.timeout(2_500),
  });
  if (!response.ok) return [];
  return z.object({ keys: z.array(z.record(z.string(), z.unknown())) }).passthrough()
    .parse(await response.json()).keys as JWK[];
}

async function verifyMandate(
  compact: string, checkout: StoredCheckout, keys: readonly JWK[],
): Promise<{ ok: true } | { ok: false; code: string }> {
  try {
    const [issuerJwt, disclosure, terminator] = compact.split('~');
    if (!issuerJwt || !disclosure || terminator !== '') return { ok: false, code: 'mandate_invalid_signature' };
    const header = decodeProtectedHeader(issuerJwt);
    const key = keys.find((candidate) => candidate.kid === header.kid);
    if (!key) return { ok: false, code: 'agent_missing_key' };
    const verified = await compactVerify(issuerJwt, await importJWK(key, 'ES256'), { algorithms: ['ES256'] });
    const issuerPayload = z.object({
      exp: z.number().int(), delegate_payload: z.array(z.object({ '...': z.string() })).length(1),
      _sd_alg: z.literal('sha-256'),
    }).passthrough().parse(JSON.parse(Buffer.from(verified.payload).toString('utf8')));
    if (issuerPayload.exp <= Math.floor(Date.now() / 1_000)) return { ok: false, code: 'mandate_expired' };
    if (issuerPayload.delegate_payload[0]?.['...']
      !== createHash('sha256').update(disclosure, 'ascii').digest('base64url')) {
      return { ok: false, code: 'mandate_invalid_signature' };
    }
    const [, content] = z.tuple([z.string(), z.record(z.string(), z.unknown())])
      .parse(JSON.parse(Buffer.from(disclosure, 'base64url').toString('utf8')));
    const authorization = ap2TransactionAuthorizationSchema.parse(content);
    const [checkoutMandate, paymentMandate] = authorization.delegate_payload;
    const expectedHash = createHash('sha256').update(checkout.signedPayload, 'utf8').digest('base64url');
    if (checkoutMandate.checkout_jwt !== checkout.signedPayload
      || checkoutMandate.checkout_hash !== expectedHash
      || paymentMandate.transaction_id !== expectedHash
      || paymentMandate.payment_amount.amount !== LIVE_PRICE_MINOR
      || paymentMandate.payment_amount.currency !== 'USD'
      || paymentMandate.payee.id !== NUBEVIA_MERCHANT_ID) {
      return { ok: false, code: 'mandate_scope_mismatch' };
    }
    return { ok: true };
  } catch {
    return { ok: false, code: 'mandate_invalid_signature' };
  }
}

function completedCheckout(checkout: StoredCheckout) {
  return { ...checkout.payload, status: 'completed', order: {
    id: checkout.merchantOrderId, permalink_url: `https://nubevia.example/orders/${checkout.merchantOrderId}`,
  }, completed_at: checkout.completedAt, ap2_receipt: checkout.checkoutReceipt && {
    payload: checkout.checkoutReceipt.payload,
    signed_payload: checkout.checkoutReceipt.signedPayload,
    payload_hash: checkout.checkoutReceipt.payloadHash.toString('base64url'),
  } };
}

function ucpError(code: string, message: string, details?: unknown) {
  return { ucp: { version: UCP_VERSION, status: 'error' }, messages: [{ type: 'error', code, message, details }] };
}

export { NUBEVIA_MERCHANT_ID, PRODUCT_ID as NUBEVIA_PRODUCT_ID };
