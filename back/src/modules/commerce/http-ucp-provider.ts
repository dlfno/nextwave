import { canonicalize } from 'json-canonicalize';
import { compactVerify, importJWK, type JWK } from 'jose';
import { z } from 'zod';

import { HttpError } from '../../shared/http-error.js';
import { discoveredOfferSchema, type DiscoveryContext, type DiscoveryProvider } from '../discovery/discovery-types.js';
import { NUBEVIA_MERCHANT_ID } from '../discovery/mock-multi-merchant-providers.js';
import type { SearchSpecification } from '../purchase-intents/specifications.js';
import type {
  AuthoritativeQuote,
  CommerceOfferReference,
  CommerceProvider,
  CompleteCheckoutRequest,
  CreateCheckoutRequest,
  SignedCheckout,
} from './commerce-types.js';

const lineItemSchema = z.object({
  merchantProductId: z.string().min(1),
  productId: z.uuid().nullable(),
  productName: z.string().min(1),
  category: z.string().min(1),
  originIata: z.string().regex(/^[A-Z]{3}$/),
  destinationIata: z.string().regex(/^[A-Z]{3}$/),
  departureDate: z.iso.date(),
  quantity: z.number().int().positive(),
  unitPriceMinor: z.string().regex(/^\d+$/),
  totalMinor: z.string().regex(/^\d+$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict();

const searchResponseSchema = z.object({
  ucpVersion: z.string().min(1),
  offers: z.array(discoveredOfferSchema.omit({
    providerId: true,
    merchantId: true,
    sourceType: true,
    sourceReference: true,
    observedAt: true,
    confidence: true,
    supportsAuthoritativeCheckout: true,
  })),
}).strict();

const quoteResponseSchema = z.object({
  ucpVersion: z.string().min(1),
  providerQuoteId: z.string().min(1),
  offerId: z.uuid(),
  merchantId: z.literal(NUBEVIA_MERCHANT_ID),
  totalMinor: z.string().regex(/^\d+$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  lineItems: z.array(lineItemSchema).min(1),
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  payload: z.record(z.string(), z.unknown()),
}).strict();

const checkoutResponseSchema = z.object({
  providerCheckoutId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  payloadHash: z.string().min(1),
  signedPayload: z.string().min(1),
  expiresAt: z.iso.datetime(),
}).strict();

const completionResponseSchema = z.object({
  merchantOrderId: z.string().min(1),
  completedAt: z.iso.datetime(),
}).strict();

const jwksSchema = z.object({
  keys: z.array(z.object({
    kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string(),
    kid: z.string(), alg: z.literal('ES256'), use: z.literal('sig'),
  }).passthrough()).min(1),
}).strict();

type ImportedKey = Awaited<ReturnType<typeof importJWK>>;

class UcpHttpClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs: number) {}

  async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return this.request(path, undefined, schema);
  }

  async post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    return this.request(path, body, schema);
  }

  private async request<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    try {
      const init: RequestInit = body === undefined
        ? { method: 'GET', signal: AbortSignal.timeout(this.timeoutMs) }
        : { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) };
      const response = await fetch(`${this.baseUrl}${path}`, init);
      if (!response.ok) {
        throw new HttpError(response.status >= 500 ? 503 : 502, 'UCP_MERCHANT_REJECTED',
          `NubeVia returned HTTP ${response.status}`);
      }
      return schema.parse(await response.json());
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof z.ZodError) {
        throw new HttpError(502, 'UCP_INVALID_RESPONSE', 'NubeVia returned an invalid UCP response', {
          issues: error.issues,
        });
      }
      throw new HttpError(503, 'UCP_MERCHANT_UNAVAILABLE', 'NubeVia UCP merchant is unavailable');
    }
  }
}

export class HttpUcpDiscoveryProvider implements DiscoveryProvider {
  readonly id = 'http-nubevia-ucp';
  private readonly client: UcpHttpClient;

  constructor(baseUrl: string, timeoutMs = 2_500) {
    this.client = new UcpHttpClient(baseUrl.replace(/\/$/, ''), timeoutMs);
  }

  async search(specification: SearchSpecification, context: DiscoveryContext) {
    const result = await this.client.post('/ucp/v1/search', {
      specification,
      observedAt: context.observedAt.toISOString(),
    }, searchResponseSchema);
    return result.offers.map((offer) => ({
      ...offer,
      providerId: this.id,
      merchantId: NUBEVIA_MERCHANT_ID,
      sourceType: 'UCP' as const,
      sourceReference: `ucp://nubevia/${offer.merchantProductId}`,
      observedAt: context.observedAt.toISOString(),
      confidence: 1,
      supportsAuthoritativeCheckout: true,
    }));
  }
}

export class HttpUcpCommerceProvider implements CommerceProvider {
  readonly id = 'http-nubevia-ucp-commerce';
  readonly merchantId = NUBEVIA_MERCHANT_ID;
  private readonly client: UcpHttpClient;
  private publicKey?: ImportedKey;

  constructor(baseUrl: string, timeoutMs = 2_500) {
    this.client = new UcpHttpClient(baseUrl.replace(/\/$/, ''), timeoutMs);
  }

  async getLiveQuote(offer: CommerceOfferReference, currentTime: Date): Promise<AuthoritativeQuote> {
    if (offer.merchantId !== this.merchantId) {
      throw new HttpError(400, 'COMMERCE_MERCHANT_MISMATCH', 'Offer belongs to another merchant');
    }
    const quote = await this.client.post('/ucp/v1/quotes', {
      offer: { ...offer, discoveredUnitPriceMinor: offer.discoveredUnitPriceMinor.toString() },
      currentTime: currentTime.toISOString(),
    }, quoteResponseSchema);
    return {
      providerQuoteId: quote.providerQuoteId,
      offerId: quote.offerId,
      merchantId: quote.merchantId,
      totalMinor: BigInt(quote.totalMinor),
      currency: quote.currency,
      lineItems: quote.lineItems.map((item) => ({
        ...item,
        unitPriceMinor: BigInt(item.unitPriceMinor),
        totalMinor: BigInt(item.totalMinor),
      })),
      observedAt: new Date(quote.observedAt),
      expiresAt: new Date(quote.expiresAt),
      payload: quote.payload,
    };
  }

  async createCheckout(request: CreateCheckoutRequest): Promise<SignedCheckout> {
    const checkout = await this.client.post('/ucp/v1/checkouts', {
      ...request,
      currentTime: request.currentTime.toISOString(),
      quote: {
        ...request.quote,
        totalMinor: request.quote.totalMinor.toString(),
        observedAt: request.quote.observedAt.toISOString(),
        expiresAt: request.quote.expiresAt.toISOString(),
        lineItems: request.quote.lineItems.map((item) => ({
          ...item,
          unitPriceMinor: item.unitPriceMinor.toString(),
          totalMinor: item.totalMinor.toString(),
        })),
      },
    }, checkoutResponseSchema);
    return {
      ...checkout,
      payloadHash: Buffer.from(checkout.payloadHash, 'base64url'),
      expiresAt: new Date(checkout.expiresAt),
    };
  }

  async verifyCheckout(checkout: SignedCheckout): Promise<boolean> {
    try {
      const verified = await compactVerify(checkout.signedPayload, await this.verificationKey(), {
        algorithms: ['ES256'],
      });
      return verified.protectedHeader.typ === 'application/nextwave-checkout+jws'
        && Buffer.from(verified.payload).equals(Buffer.from(canonicalize(checkout.payload), 'utf8'));
    } catch {
      return false;
    }
  }

  async completeCheckout(request: CompleteCheckoutRequest) {
    const result = await this.client.post(`/ucp/v1/checkouts/${encodeURIComponent(request.providerCheckoutId)}/complete`, {
      ...request,
      amountMinor: request.amountMinor.toString(),
    }, completionResponseSchema);
    return { ...result, completedAt: new Date(result.completedAt) };
  }

  private async verificationKey(): Promise<ImportedKey> {
    if (this.publicKey) return this.publicKey;
    const jwks = await this.client.get('/.well-known/jwks.json', jwksSchema);
    this.publicKey = await importJWK(jwks.keys[0] as JWK, 'ES256');
    return this.publicKey;
  }
}
