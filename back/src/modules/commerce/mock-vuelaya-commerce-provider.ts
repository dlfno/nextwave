import { randomUUID } from 'node:crypto';

import { HttpError } from '../../shared/http-error.js';
import { VUELAYA_MERCHANT_ID } from '../discovery/mock-vuelaya-provider.js';
import { AEROSUR_MERCHANT_ID, NUBEVIA_MERCHANT_ID } from '../discovery/mock-multi-merchant-providers.js';
import type { CheckoutSigner } from './checkout-signer.js';
import type {
  AuthoritativeQuote,
  CommerceOfferReference,
  CommerceProvider,
  CompleteCheckoutRequest,
  CreateCheckoutRequest,
  SignedCheckout,
} from './commerce-types.js';

interface MockCatalogEntry {
  readonly priceMinor: bigint;
  readonly productName: string;
  readonly category: string;
  readonly originIata: string;
  readonly destinationIata: string;
  readonly departureDate: string;
}

const VUELAYA_CATALOG: Readonly<Record<string, MockCatalogEntry>> = {
  'VY-MEX-COR-130': { priceMinor: 13_000n, productName: 'VuelaYa Mexico City to Córdoba flight', category: 'travel.flight', originIata: 'MEX', destinationIata: 'COR', departureDate: '2026-09-15' },
  'VY-MEX-COR-300': { priceMinor: 30_000n, productName: 'VuelaYa premium Mexico City to Córdoba flight', category: 'travel.flight', originIata: 'MEX', destinationIata: 'COR', departureDate: '2026-09-15' },
};

interface MockCommerceOptions {
  readonly id: string;
  readonly merchantId: string;
  readonly orderPrefix: string;
  readonly catalog: Readonly<Record<string, MockCatalogEntry>>;
}

function isCommerceOptions(value: MockCommerceOptions | Readonly<Record<string, bigint>>): value is MockCommerceOptions {
  return typeof value.merchantId === 'string' && typeof value.id === 'string' && 'catalog' in value;
}

export class MockVuelaYaCommerceProvider implements CommerceProvider {
  readonly id: string;
  readonly merchantId: string;
  private readonly options: MockCommerceOptions;

  constructor(
    private readonly signer: CheckoutSigner,
    optionsOrPrices: MockCommerceOptions | Readonly<Record<string, bigint>> = {
      id: 'mock-vuelaya-commerce', merchantId: VUELAYA_MERCHANT_ID,
      orderPrefix: 'VY', catalog: VUELAYA_CATALOG,
    },
  ) {
    const options: MockCommerceOptions = isCommerceOptions(optionsOrPrices) ? optionsOrPrices : {
      id: 'mock-vuelaya-commerce', merchantId: VUELAYA_MERCHANT_ID, orderPrefix: 'VY',
      catalog: Object.fromEntries(Object.entries(VUELAYA_CATALOG).map(([id, entry]) => [
        id, { ...entry, priceMinor: optionsOrPrices[id] ?? entry.priceMinor },
      ])),
    };
    this.options = options;
    this.id = options.id;
    this.merchantId = options.merchantId;
  }

  async getLiveQuote(offer: CommerceOfferReference, currentTime: Date): Promise<AuthoritativeQuote> {
    if (offer.merchantId !== this.merchantId) {
      throw new HttpError(400, 'COMMERCE_MERCHANT_MISMATCH', 'Offer belongs to another merchant');
    }
    const catalogEntry = this.options.catalog[offer.merchantProductId];
    if (catalogEntry === undefined) {
      throw new HttpError(409, 'OFFER_NO_LONGER_AVAILABLE', 'The selected offer is no longer available');
    }
    const providerQuoteId = `vy-quote-${randomUUID()}`;
    const expiresAt = new Date(currentTime.getTime() + 5 * 60 * 1000);
    const lineItem = {
      merchantProductId: offer.merchantProductId,
      productId: offer.productId,
      productName: catalogEntry.productName,
      category: catalogEntry.category,
      originIata: catalogEntry.originIata,
      destinationIata: catalogEntry.destinationIata,
      departureDate: catalogEntry.departureDate,
      quantity: 1,
      unitPriceMinor: catalogEntry.priceMinor,
      totalMinor: catalogEntry.priceMinor,
      currency: offer.currency,
    };
    const payload = {
      ucpVersion: '2026-01-23',
      merchantId: this.merchantId,
      providerQuoteId,
      offerId: offer.offerId,
      totalMinor: catalogEntry.priceMinor.toString(),
      currency: offer.currency,
      observedAt: currentTime.toISOString(),
      expiresAt: expiresAt.toISOString(),
      lineItems: [{ ...lineItem, unitPriceMinor: catalogEntry.priceMinor.toString(), totalMinor: catalogEntry.priceMinor.toString() }],
    };
    return {
      providerQuoteId,
      offerId: offer.offerId,
      merchantId: this.merchantId,
      totalMinor: catalogEntry.priceMinor,
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

  async completeCheckout(request: CompleteCheckoutRequest) {
    if (request.merchantId !== this.merchantId || request.amountMinor < 0n
      || request.currency !== 'USD' || !request.credentialReference || !request.ap2CheckoutMandate) {
      throw new HttpError(409, 'MERCHANT_PAYMENT_REJECTED', 'Merchant rejected the payment scope');
    }
    return { merchantOrderId: `${this.options.orderPrefix}-ORDER-${randomUUID()}`, completedAt: new Date() };
  }
}

export class MockAeroSurCommerceProvider extends MockVuelaYaCommerceProvider {
  constructor(signer: CheckoutSigner) {
    super(signer, {
      id: 'mock-aerosur-commerce', merchantId: AEROSUR_MERCHANT_ID, orderPrefix: 'AS',
      catalog: {
        'AS-MEX-COR-118': { priceMinor: 12_500n, productName: 'AeroSur Mexico City to Córdoba', category: 'travel.flight', originIata: 'MEX', destinationIata: 'COR', departureDate: '2026-09-15' },
      },
    });
  }
}

export class MockNubeViaCommerceProvider extends MockVuelaYaCommerceProvider {
  constructor(signer: CheckoutSigner) {
    super(signer, {
      id: 'mock-nubevia-ucp-commerce', merchantId: NUBEVIA_MERCHANT_ID, orderPrefix: 'NV',
      catalog: {
        'NV-MEX-COR-145': { priceMinor: 14_200n, productName: 'NubeVia Mexico City to Córdoba', category: 'travel.flight', originIata: 'MEX', destinationIata: 'COR', departureDate: '2026-09-15' },
      },
    });
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

  async completeCheckout(): Promise<never> {
    throw new HttpError(503, 'COMMERCE_PROVIDER_UNAVAILABLE', 'Commerce provider is not configured');
  }
}
