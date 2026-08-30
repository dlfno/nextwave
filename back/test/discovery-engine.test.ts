import { describe, expect, it } from 'vitest';

import { DiscoveryEngine } from '../src/modules/discovery/discovery-engine.js';
import { MockVuelaYaDiscoveryProvider } from '../src/modules/discovery/mock-vuelaya-provider.js';
import { MockAeroSurDiscoveryProvider, MockNubeViaUcpDiscoveryProvider } from '../src/modules/discovery/mock-multi-merchant-providers.js';
import type { DiscoveredOffer, DiscoveryProvider } from '../src/modules/discovery/discovery-types.js';
import type { SearchSpecification } from '../src/modules/purchase-intents/specifications.js';

const specification: SearchSpecification = {
  query: 'Mexico City to Córdoba flight',
  category: 'travel.flight',
  origin: { city: 'Mexico City', iata: 'MEX' },
  destination: { city: 'Córdoba', country: 'Argentina', iata: 'COR' },
  departureDate: '2026-09-15',
  passengers: 1,
  currency: 'USD',
  rankingPreferences: ['lowest_total_price', 'departure_time'],
};
const context = { observedAt: new Date('2026-08-29T12:00:00.000Z') };

describe('DiscoveryEngine', () => {
  it('normalizes and ranks the $130 VuelaYa offer before the $300 offer', async () => {
    const engine = new DiscoveryEngine([new MockVuelaYaDiscoveryProvider()]);

    const offers = await engine.discover(specification, context);

    expect(offers.map((offer) => [offer.rank, offer.unitPriceMinor])).toEqual([
      [1, '13000'],
      [2, '30000'],
    ]);
    expect(offers.every((offer) => offer.authoritative === false)).toBe(true);
    expect(offers.every((offer) => offer.supportsAuthoritativeCheckout)).toBe(true);
  });

  it('ranks normalized offers across merchant API, mock, and UCP providers', async () => {
    const engine = new DiscoveryEngine([
      new MockVuelaYaDiscoveryProvider(),
      new MockAeroSurDiscoveryProvider(),
      new MockNubeViaUcpDiscoveryProvider(),
    ]);

    const result = await engine.discoverWithOutcomes(specification, context);

    expect(result.offers.map((offer) => [offer.rank, offer.providerId, offer.unitPriceMinor])).toEqual([
      [1, 'mock-aerosur-api', '11800'],
      [2, 'mock-vuelaya', '13000'],
      [3, 'mock-nubevia-ucp', '14500'],
      [4, 'mock-vuelaya', '30000'],
    ]);
    expect(result.outcomes.every((outcome) => outcome.status === 'SUCCEEDED')).toBe(true);
  });

  it('returns healthy merchant results when another provider times out', async () => {
    const stalled: DiscoveryProvider = {
      id: 'stalled-provider',
      search: () => new Promise(() => undefined),
    };
    const engine = new DiscoveryEngine([stalled, new MockAeroSurDiscoveryProvider()], 10);

    const result = await engine.discoverWithOutcomes(specification, context);

    expect(result.offers.map((offer) => offer.providerId)).toEqual(['mock-aerosur-api']);
    expect(result.outcomes).toEqual([
      { providerId: 'stalled-provider', status: 'TIMED_OUT', offerCount: 0 },
      { providerId: 'mock-aerosur-api', status: 'SUCCEEDED', offerCount: 1 },
    ]);
  });

  it('returns no invented offer when the mock catalog does not match the search', async () => {
    const engine = new DiscoveryEngine([new MockVuelaYaDiscoveryProvider()]);

    const offers = await engine.discover({
      ...specification,
      destination: { city: 'Madrid', country: 'Spain', iata: 'MAD' },
    }, context);

    expect(offers).toEqual([]);
  });

  it('filters unavailable and wrong-currency provider results', async () => {
    const base = (availability: DiscoveredOffer['availability'], currency: string): DiscoveredOffer => ({
      providerId: 'test-provider',
      merchantId: '10000000-0000-4000-8000-000000000001',
      merchantProductId: `${availability}-${currency}`,
      productName: 'Test flight',
      category: 'travel.flight',
      unitPriceMinor: '10000',
      currency,
      availability,
      sourceType: 'MOCK',
      sourceReference: 'mock://test',
      observedAt: context.observedAt.toISOString(),
      confidence: 1,
      supportsAuthoritativeCheckout: true,
      attributes: {},
    });
    const provider: DiscoveryProvider = {
      id: 'test-provider',
      async search() {
        return [base('IN_STOCK', 'USD'), base('OUT_OF_STOCK', 'USD'), base('IN_STOCK', 'MXN')];
      },
    };

    const offers = await new DiscoveryEngine([provider]).discover(specification, context);

    expect(offers).toHaveLength(1);
    expect(offers[0]?.currency).toBe('USD');
  });

  it('fails closed when a provider returns a malformed normalized offer', async () => {
    const provider: DiscoveryProvider = {
      id: 'malformed-provider',
      async search() {
        return [{ approved: true }] as unknown as DiscoveredOffer[];
      },
    };

    await expect(new DiscoveryEngine([provider]).discover(specification, context)).rejects.toThrow();
  });
});
