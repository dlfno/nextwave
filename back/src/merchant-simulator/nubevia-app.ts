import { randomUUID } from 'node:crypto';

import express, { type Express } from 'express';
import type { JWK } from 'jose';
import { z } from 'zod';

import { Es256CheckoutSigner } from '../modules/commerce/checkout-signer.js';
import { NUBEVIA_MERCHANT_ID } from '../modules/discovery/mock-multi-merchant-providers.js';
import { searchSpecificationSchema } from '../modules/purchase-intents/specifications.js';

const PRODUCT_ID = '20000000-0000-4000-8000-000000000004';
const MERCHANT_PRODUCT_ID = 'NV-MEX-COR-145';
const DISCOVERY_PRICE_MINOR = '14500';
const LIVE_PRICE_MINOR = '14200';
const DEPARTURE_TIME = '2026-09-15T12:45:00Z';

const offerReferenceSchema = z.object({
  offerId: z.uuid(), merchantId: z.literal(NUBEVIA_MERCHANT_ID),
  merchantProductId: z.literal(MERCHANT_PRODUCT_ID), productId: z.uuid().nullable(),
  productName: z.string().min(1), category: z.literal('travel.flight'),
  discoveredUnitPriceMinor: z.string().regex(/^\d+$/), currency: z.literal('USD'),
}).strict();

const quoteLineItemSchema = z.object({
  merchantProductId: z.literal(MERCHANT_PRODUCT_ID), productId: z.uuid().nullable(),
  productName: z.string().min(1), category: z.literal('travel.flight'),
  originIata: z.literal('MEX'), destinationIata: z.literal('COR'),
  departureDate: z.literal('2026-09-15'), quantity: z.number().int().positive(),
  unitPriceMinor: z.literal(LIVE_PRICE_MINOR), totalMinor: z.literal(LIVE_PRICE_MINOR),
  currency: z.literal('USD'),
}).strict();

const checkoutRequestSchema = z.object({
  attemptId: z.uuid(), quoteId: z.uuid(), mandateId: z.uuid(), mandateVersionId: z.uuid(),
  currentTime: z.iso.datetime(),
  quote: z.object({
    providerQuoteId: z.string().min(1), offerId: z.uuid(),
    merchantId: z.literal(NUBEVIA_MERCHANT_ID), totalMinor: z.literal(LIVE_PRICE_MINOR),
    currency: z.literal('USD'), lineItems: z.array(quoteLineItemSchema).length(1),
    observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
    payload: z.record(z.string(), z.unknown()),
  }).strict(),
}).strict();

const completionRequestSchema = z.object({
  providerCheckoutId: z.string().min(1), checkoutId: z.uuid(),
  merchantId: z.literal(NUBEVIA_MERCHANT_ID), amountMinor: z.literal(LIVE_PRICE_MINOR),
  currency: z.literal('USD'), credentialProvider: z.string().min(1),
  credentialReference: z.string().min(1),
}).strict();

interface StoredCheckout { readonly merchantOrderId: string; completedAt?: string }

export interface NubeViaSimulatorOptions { readonly privateJwk: JWK; readonly keyId?: string }

export async function createNubeViaSimulator(options: NubeViaSimulatorOptions): Promise<Express> {
  const keyId = options.keyId ?? 'nubevia-checkout-1';
  const signer = await Es256CheckoutSigner.create(options.privateJwk, keyId);
  const publicJwk: JWK = { ...options.privateJwk, kid: keyId, alg: 'ES256', use: 'sig' };
  delete publicJwk.d;
  const checkouts = new Map<string, StoredCheckout>();
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.get('/health', (_request, response) => response.json({ status: 'ok', merchant: 'NubeVia' }));
  app.get('/.well-known/jwks.json', (_request, response) => response.json({ keys: [publicJwk] }));

  app.post('/ucp/v1/search', (request, response) => {
    const input = z.object({ specification: searchSpecificationSchema, observedAt: z.iso.datetime() })
      .strict().parse(request.body);
    const spec = input.specification;
    const matches = spec.origin.iata === 'MEX' && spec.destination.iata === 'COR'
      && spec.departureDate === '2026-09-15' && spec.passengers === 1 && spec.currency === 'USD';
    response.json({
      ucpVersion: '2026-01-23',
      offers: matches ? [{
        merchantProductId: MERCHANT_PRODUCT_ID, productId: PRODUCT_ID,
        productName: 'NubeVia Mexico City to Córdoba',
        description: 'Flexible economy fare returned by the NubeVia UCP merchant.',
        category: 'travel.flight', unitPriceMinor: DISCOVERY_PRICE_MINOR, currency: 'USD',
        availability: 'IN_STOCK', departureTime: DEPARTURE_TIME,
        attributes: { origin: 'MEX', destination: 'COR', passengers: 1,
          departureDate: '2026-09-15', departureTime: DEPARTURE_TIME,
          fareClass: 'UCP flexible economy' },
      }] : [],
    });
  });

  app.post('/ucp/v1/quotes', (request, response) => {
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
      unitPriceMinor: LIVE_PRICE_MINOR, totalMinor: LIVE_PRICE_MINOR, currency: 'USD' as const,
    };
    const payload = {
      ucpVersion: '2026-01-23', merchantId: NUBEVIA_MERCHANT_ID, providerQuoteId,
      offerId: input.offer.offerId, totalMinor: LIVE_PRICE_MINOR, currency: 'USD',
      observedAt: observedAt.toISOString(), expiresAt: expiresAt.toISOString(), lineItems: [lineItem],
    };
    response.json({ ...payload, payload });
  });

  app.post('/ucp/v1/checkouts', async (request, response) => {
    const input = checkoutRequestSchema.parse(request.body);
    if (new Date(input.quote.expiresAt) <= new Date(input.currentTime)) {
      response.status(409).json({ code: 'QUOTE_EXPIRED', message: 'The authoritative quote expired' });
      return;
    }
    const providerCheckoutId = `nv-checkout-${randomUUID()}`;
    const payload = {
      vct: 'dev.ucp.shopping.checkout.1', providerCheckoutId,
      attemptId: input.attemptId, quoteId: input.quoteId,
      providerQuoteId: input.quote.providerQuoteId, merchantId: NUBEVIA_MERCHANT_ID,
      offerId: input.quote.offerId, mandateId: input.mandateId,
      mandateVersionId: input.mandateVersionId, totalMinor: LIVE_PRICE_MINOR,
      currency: 'USD', lineItems: input.quote.lineItems,
      createdAt: input.currentTime, expiresAt: input.quote.expiresAt,
    };
    const signature = await signer.sign(payload);
    checkouts.set(providerCheckoutId, { merchantOrderId: `NV-ORDER-${randomUUID()}` });
    response.status(201).json({ providerCheckoutId, payload: signature.payload,
      payloadHash: signature.payloadHash.toString('base64url'),
      signedPayload: signature.signedPayload, expiresAt: input.quote.expiresAt });
  });

  app.post('/ucp/v1/checkouts/:providerCheckoutId/complete', (request, response) => {
    const input = completionRequestSchema.parse(request.body);
    if (input.providerCheckoutId !== request.params['providerCheckoutId']) {
      response.status(409).json({ code: 'CHECKOUT_BINDING_MISMATCH', message: 'Checkout binding mismatch' });
      return;
    }
    const checkout = checkouts.get(input.providerCheckoutId);
    if (!checkout) {
      response.status(404).json({ code: 'CHECKOUT_NOT_FOUND', message: 'Checkout does not exist' });
      return;
    }
    checkout.completedAt ??= new Date().toISOString();
    response.json({ merchantOrderId: checkout.merchantOrderId, completedAt: checkout.completedAt });
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) {
      response.status(400).json({ code: 'INVALID_UCP_REQUEST', message: 'Invalid UCP request', issues: error.issues });
      return;
    }
    response.status(500).json({ code: 'NUBEVIA_INTERNAL_ERROR', message: 'NubeVia could not process the request' });
  });
  return app;
}

export { NUBEVIA_MERCHANT_ID, PRODUCT_ID as NUBEVIA_PRODUCT_ID };
