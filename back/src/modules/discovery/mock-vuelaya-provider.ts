import type { DiscoveryContext, DiscoveryProvider, DiscoveredOffer } from './discovery-types.js';

export const VUELAYA_MERCHANT_ID = '10000000-0000-4000-8000-000000000001';

export class MockVuelaYaDiscoveryProvider implements DiscoveryProvider {
  readonly id = 'mock-vuelaya';

  async search(specification: Parameters<DiscoveryProvider['search']>[0], context: DiscoveryContext): Promise<DiscoveredOffer[]> {
    if (
      specification.category !== 'travel.flight'
      || specification.origin.iata !== 'MEX'
      || specification.destination.iata !== 'COR'
      || specification.departureDate !== '2026-09-15'
      || specification.passengers !== 1
      || specification.currency !== 'USD'
    ) return [];

    return [
      this.offer('VY-MEX-COR-130', '20000000-0000-4000-8000-000000000001',
        'Mexico City to Córdoba flight', '13000', '2026-09-15T14:00:00Z', 'ECONOMY', context),
      this.offer('VY-MEX-COR-300', '20000000-0000-4000-8000-000000000002',
        'Mexico City to Córdoba premium flight', '30000', '2026-09-15T16:00:00Z', 'PREMIUM', context),
    ];
  }

  private offer(
    merchantProductId: string,
    productId: string,
    productName: string,
    unitPriceMinor: string,
    departureTime: string,
    fareClass: string,
    context: DiscoveryContext,
  ): DiscoveredOffer {
    return {
      providerId: this.id,
      merchantId: VUELAYA_MERCHANT_ID,
      merchantProductId,
      productId,
      productName,
      description: `Fictional ${fareClass.toLowerCase()} VuelaYa flight for the hackathon demo.`,
      category: 'travel.flight',
      unitPriceMinor,
      currency: 'USD',
      availability: 'IN_STOCK',
      departureTime,
      sourceType: 'MOCK',
      sourceReference: `mock://vuela-ya/catalog/${merchantProductId}`,
      observedAt: context.observedAt.toISOString(),
      confidence: 1,
      supportsAuthoritativeCheckout: true,
      attributes: {
        origin: 'MEX',
        destination: 'COR',
        passengers: 1,
        departureDate: departureTime.slice(0, 10),
        departureTime,
        fareClass,
      },
    };
  }
}
