import type { DiscoveryContext, DiscoveryProvider, DiscoveredOffer } from './discovery-types.js';

export const AEROSUR_MERCHANT_ID = '10000000-0000-4000-8000-000000000002';
export const NUBEVIA_MERCHANT_ID = '10000000-0000-4000-8000-000000000003';

interface CatalogOffer {
  merchantProductId: string;
  productId: string;
  productName: string;
  priceMinor: string;
  departureTime: string;
  fareClass: string;
}

class MockFlightDiscoveryProvider implements DiscoveryProvider {
  constructor(
    readonly id: string,
    private readonly merchantId: string,
    private readonly sourceType: DiscoveredOffer['sourceType'],
    private readonly offers: readonly CatalogOffer[],
  ) {}

  async search(specification: Parameters<DiscoveryProvider['search']>[0], context: DiscoveryContext): Promise<DiscoveredOffer[]> {
    if (specification.category !== 'travel.flight'
      || specification.origin.iata !== 'MEX'
      || specification.destination.iata !== 'COR'
      || specification.departureDate !== '2026-09-15'
      || specification.passengers !== 1
      || specification.currency !== 'USD') return [];

    return this.offers.map((offer) => ({
      providerId: this.id,
      merchantId: this.merchantId,
      merchantProductId: offer.merchantProductId,
      productId: offer.productId,
      productName: offer.productName,
      description: `${offer.fareClass} fare returned through the ${this.sourceType} adapter.`,
      category: 'travel.flight',
      unitPriceMinor: offer.priceMinor,
      currency: 'USD',
      availability: 'IN_STOCK',
      departureTime: offer.departureTime,
      sourceType: this.sourceType,
      sourceReference: `${this.sourceType.toLowerCase()}://${this.id}/${offer.merchantProductId}`,
      observedAt: context.observedAt.toISOString(),
      confidence: 1,
      supportsAuthoritativeCheckout: true,
      attributes: {
        origin: 'MEX', destination: 'COR', passengers: 1,
        departureDate: '2026-09-15', departureTime: offer.departureTime,
        fareClass: offer.fareClass,
      },
    }));
  }
}

export class MockAeroSurDiscoveryProvider extends MockFlightDiscoveryProvider {
  constructor() {
    super('mock-aerosur-api', AEROSUR_MERCHANT_ID, 'MERCHANT_API', [{
      merchantProductId: 'AS-MEX-COR-118',
      productId: '20000000-0000-4000-8000-000000000003',
      productName: 'AeroSur Mexico City to Córdoba',
      priceMinor: '11800',
      departureTime: '2026-09-15T15:20:00Z',
      fareClass: 'Light economy',
    }]);
  }
}

export class MockNubeViaUcpDiscoveryProvider extends MockFlightDiscoveryProvider {
  constructor() {
    super('mock-nubevia-ucp', NUBEVIA_MERCHANT_ID, 'UCP', [{
      merchantProductId: 'NV-MEX-COR-145',
      productId: '20000000-0000-4000-8000-000000000004',
      productName: 'NubeVia Mexico City to Córdoba',
      priceMinor: '14500',
      departureTime: '2026-09-15T12:45:00Z',
      fareClass: 'UCP flexible economy',
    }]);
  }
}
