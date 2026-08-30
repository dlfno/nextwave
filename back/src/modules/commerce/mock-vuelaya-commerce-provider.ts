import { randomUUID } from 'node:crypto';

import { HttpError } from '../../shared/http-error.js';
import { VUELAYA_MERCHANT_ID } from '../discovery/mock-vuelaya-provider.js';
import type { CheckoutSigner } from './checkout-signer.js';
import type {
  AuthoritativeQuote,
  CommerceOfferReference,
  CommerceProvider,
  CreateCheckoutRequest,
  SignedCheckout,
} from './commerce-types.js';

const PRODUCT_PRICES: Readonly<Record<string, bigint>> = {
  'VY-MEX-COR-130': 13_000n,
  'VY-MEX-COR-300': 30_000n,
};

export class MockVuelaYaCommerceProvider implements CommerceProvider {
  readonly id = 'mock-vuelaya-commerce';
  readonly merchantId = VUELAYA_MERCHANT_ID;

  constructor(
    private readonly signer: CheckoutSigner,
    private readonly livePrices: Readonly<Record<string, bigint>> = PRODUCT_PRICES,
  ) {}

  async getLiveQuote(offer: CommerceOfferReference, currentTime: Date): Promise<AuthoritativeQuote> {
    if (offer.merchantId !== this.merchantId) {
      throw new HttpError(400, 'COMMERCE_MERCHANT_MISMATCH', 'Offer belongs to another merchant');
    }
    const livePrice = this.livePrices[offer.merchantProductId];
    if (livePrice === undefined) {
      throw new HttpError(409, 'OFFER_NO_LONGER_AVAILABLE', 'The selected offer is no longer available');
    }
    const providerQuoteId = `vy-quote-${randomUUID()}`;
    const expiresAt = new Date(currentTime.getTime() + 5 * 60 * 1000);
    const lineItem = {
      merchantProductId: offer.merchantProductId,
      productId: offer.productId,
      productName: offer.productName,
      category: offer.category,
      quantity: 1,
      unitPriceMinor: livePrice,
      totalMinor: livePrice,
      currency: offer.currency,
    };
    const payload = {
      ucpVersion: '2026-01-23',
      merchantId: this.merchantId,
      providerQuoteId,
      offerId: offer.offerId,
      totalMinor: livePrice.toString(),
      currency: offer.currency,
      observedAt: currentTime.toISOString(),
      expiresAt: expiresAt.toISOString(),
      lineItems: [{ ...lineItem, unitPriceMinor: livePrice.toString(), totalMinor: livePrice.toString() }],
    };
    return {
      providerQuoteId,
      offerId: offer.offerId,
      merchantId: this.merchantId,
      totalMinor: livePrice,
      currency: offer.currency,
      lineItems: [lineItem],
      observedAt: currentTime,
      expiresAt,
      payload,
    };
  }

  async createCheckout(request: CreateCheckoutRequest): Promise<SignedCheckout> {
    const providerCheckoutId = `vy-checkout-${randomUUID()}`;
    const expiresAt = request.quote.expiresAt;
    const payload = {
      vct: 'dev.ucp.shopping.checkout.1',
      providerCheckoutId,
      attemptId: request.attemptId,
      quoteId: request.quoteId,
      providerQuoteId: request.quote.providerQuoteId,
      merchantId: this.merchantId,
      offerId: request.quote.offerId,
      mandateId: request.mandateId,
      mandateVersionId: request.mandateVersionId,
      totalMinor: request.quote.totalMinor.toString(),
      currency: request.quote.currency,
      lineItems: request.quote.lineItems.map((item) => ({
        ...item,
        unitPriceMinor: item.unitPriceMinor.toString(),
        totalMinor: item.totalMinor.toString(),
      })),
      createdAt: request.currentTime.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
    const signature = await this.signer.sign(payload);
    return { providerCheckoutId, expiresAt, ...signature };
  }

  async verifyCheckout(checkout: SignedCheckout): Promise<boolean> {
    return this.signer.verify(checkout.signedPayload, checkout.payload);
  }
}

export class UnavailableCommerceProvider implements CommerceProvider {
  readonly id = 'unavailable-commerce';
  readonly merchantId: string;

  constructor(merchantId: string) {
    this.merchantId = merchantId;
  }

  async getLiveQuote(): Promise<never> {
    throw new HttpError(503, 'COMMERCE_PROVIDER_UNAVAILABLE', 'Commerce provider is not configured');
  }

  async createCheckout(): Promise<never> {
    throw new HttpError(503, 'COMMERCE_PROVIDER_UNAVAILABLE', 'Commerce provider is not configured');
  }

  async verifyCheckout(): Promise<boolean> {
    return false;
  }
}
