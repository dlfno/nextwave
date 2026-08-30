import type { AddressInfo } from 'node:net';

import { exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNubeViaSimulator } from '../src/merchant-simulator/nubevia-app.js';
import {
  HttpUcpCommerceProvider,
  HttpUcpDiscoveryProvider,
} from '../src/modules/commerce/http-ucp-provider.js';
import { NUBEVIA_MERCHANT_ID } from '../src/modules/discovery/mock-multi-merchant-providers.js';
import type { SearchSpecification } from '../src/modules/purchase-intents/specifications.js';

const OFFER_ID = '30000000-0000-4000-8000-000000000001';
const ATTEMPT_ID = '40000000-0000-4000-8000-000000000001';
const QUOTE_ID = '50000000-0000-4000-8000-000000000001';
const MANDATE_ID = '60000000-0000-4000-8000-000000000001';
const MANDATE_VERSION_ID = '70000000-0000-4000-8000-000000000001';

const specification: SearchSpecification = {
  query: 'flight from Mexico City to Córdoba', category: 'travel.flight',
  origin: { city: 'Mexico City', iata: 'MEX' },
  destination: { city: 'Córdoba', country: 'Argentina', iata: 'COR' },
  departureDate: '2026-09-15', passengers: 1, currency: 'USD',
  rankingPreferences: ['lowest_total_price'],
};

describe('HTTP UCP NubeVia adapters', () => {
  let server: ReturnType<Awaited<ReturnType<typeof createNubeViaSimulator>>['listen']>;
  let baseUrl: string;

  beforeEach(async () => {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const app = await createNubeViaSimulator({ privateJwk: await exportJWK(privateKey) });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it('discovers, refreshes, signs, verifies, and completes an authoritative checkout', async () => {
    const discovery = new HttpUcpDiscoveryProvider(baseUrl);
    const commerce = new HttpUcpCommerceProvider(baseUrl);
    const offers = await discovery.search(specification, { observedAt: new Date('2026-08-30T18:00:00Z') });

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      providerId: 'http-nubevia-ucp', merchantId: NUBEVIA_MERCHANT_ID,
      merchantProductId: 'NV-MEX-COR-145', unitPriceMinor: '14500', sourceType: 'UCP',
    });

    const offer = offers[0];
    if (!offer) throw new Error('Expected a NubeVia offer');
    const quote = await commerce.getLiveQuote({
      offerId: OFFER_ID, merchantId: offer.merchantId,
      merchantProductId: offer.merchantProductId, productId: offer.productId ?? null,
      productName: offer.productName, category: offer.category,
      discoveredUnitPriceMinor: BigInt(offer.unitPriceMinor), currency: offer.currency,
    }, new Date('2026-08-30T18:00:00Z'));
    expect(quote.totalMinor).toBe(14_200n);

    const checkout = await commerce.createCheckout({
      attemptId: ATTEMPT_ID, quoteId: QUOTE_ID, mandateId: MANDATE_ID,
      mandateVersionId: MANDATE_VERSION_ID, quote,
      currentTime: new Date('2026-08-30T18:00:01Z'),
    });
    expect(await commerce.verifyCheckout(checkout)).toBe(true);
    expect(await commerce.verifyCheckout({ ...checkout, payload: { ...checkout.payload, totalMinor: '1' } }))
      .toBe(false);

    const completed = await commerce.completeCheckout({
      providerCheckoutId: checkout.providerCheckoutId,
      checkoutId: '80000000-0000-4000-8000-000000000001', merchantId: NUBEVIA_MERCHANT_ID,
      amountMinor: 14_200n, currency: 'USD', credentialProvider: 'mock',
      credentialReference: 'mock-credential-reference',
    });
    expect(completed.merchantOrderId).toMatch(/^NV-ORDER-/);
  });

  it('reports an unavailable merchant without falling back to untrusted data', async () => {
    const unavailable = new HttpUcpDiscoveryProvider('http://127.0.0.1:1', 50);
    await expect(unavailable.search(specification, { observedAt: new Date() }))
      .rejects.toMatchObject({ status: 503, code: 'UCP_MERCHANT_UNAVAILABLE' });
  });
});
