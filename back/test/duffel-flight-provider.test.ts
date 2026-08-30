import { describe, expect, it, vi } from 'vitest';

import { DuffelFlightDiscoveryProvider } from '../src/modules/discovery/duffel-flight-provider.js';
import { HttpError } from '../src/shared/http-error.js';
import type { SearchSpecification } from '../src/modules/purchase-intents/specifications.js';

const specification: SearchSpecification = {
  query: 'Mexico City to Córdoba flight',
  category: 'travel.flight',
  origin: { city: 'Mexico City', iata: 'MEX' },
  destination: { city: 'Córdoba', country: 'Argentina', iata: 'COR' },
  departureDate: '2026-09-15',
  passengers: 2,
  currency: 'USD',
  rankingPreferences: ['lowest_total_price', 'departure_time'],
};
const context = {
  observedAt: new Date('2026-08-30T12:00:00.000Z'),
  correlationId: '30000000-0000-4000-8000-000000000001',
};

function offer(liveMode = true) {
  return {
    id: 'off_live_offer',
    live_mode: liveMode,
    expires_at: '2026-08-30T12:30:00.000Z',
    total_amount: '145.20',
    total_currency: 'USD',
    owner: { name: 'Aeroméxico', iata_code: 'AM' },
    slices: [
      {
        duration: 'PT12H30M',
        segments: [
          {
            departing_at: '2026-09-15T12:00:00',
            arriving_at: '2026-09-15T14:00:00',
            origin: { iata_code: 'MEX', time_zone: 'America/Mexico_City' },
            destination: { iata_code: 'IAH', time_zone: 'America/Chicago' },
            operating_carrier: { name: 'Aeroméxico', iata_code: 'AM' },
            marketing_carrier: { name: 'Aeroméxico', iata_code: 'AM' },
            marketing_carrier_flight_number: 'AM472',
          },
          {
            departing_at: '2026-09-15T16:00:00',
            arriving_at: '2026-09-16T06:30:00',
            origin: { iata_code: 'IAH', time_zone: 'America/Chicago' },
            destination: {
              iata_code: 'COR',
              time_zone: 'America/Argentina/Cordoba',
            },
            operating_carrier: { name: 'United Airlines', iata_code: 'UA' },
            marketing_carrier: { name: 'United Airlines', iata_code: 'UA' },
            marketing_carrier_flight_number: 'UA819',
          },
        ],
      },
    ],
  };
}

function successfulFetch(liveMode = true) {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { id: 'orq_live_search', live_mode: liveMode },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [offer(liveMode)] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
}

describe('DuffelFlightDiscoveryProvider', () => {
  it('searches server-side and normalizes the total price and carrier itinerary', async () => {
    const fetchFn = successfulFetch();
    const provider = new DuffelFlightDiscoveryProvider({
      accessToken: 'duffel_live_secret',
      fetchFn,
    });

    const offers = await provider.search(specification, context);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [searchUrl, searchInit] = fetchFn.mock.calls[0]!;
    expect(String(searchUrl)).toContain(
      '/air/offer_requests?return_offers=false&supplier_timeout=10000',
    );
    expect(searchInit?.headers).toMatchObject({
      authorization: 'Bearer duffel_live_secret',
      'duffel-version': 'v2',
      'x-client-correlation-id': context.correlationId,
    });
    expect(JSON.parse(String(searchInit?.body))).toEqual({
      data: {
        cabin_class: 'economy',
        slices: [
          { origin: 'MEX', destination: 'COR', departure_date: '2026-09-15' },
        ],
        passengers: [{ type: 'adult' }, { type: 'adult' }],
      },
    });
    expect(String(fetchFn.mock.calls[1]![0])).toContain(
      '/air/offers?offer_request_id=orq_live_search&sort=total_amount&limit=20',
    );
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      providerId: 'duffel-flights',
      merchantProductId: 'off_live_offer',
      unitPriceMinor: '14520',
      currency: 'USD',
      departureTime: '2026-09-15T18:00:00.000Z',
      sourceType: 'MERCHANT_API',
      supportsAuthoritativeCheckout: false,
      attributes: {
        passengers: 2,
        priceBasis: 'TOTAL_FOR_ALL_PASSENGERS',
        liveMode: true,
        operatingCarriers: ['Aeroméxico', 'United Airlines'],
        flightNumbers: ['AM472', 'UA819'],
        stops: 1,
      },
    });
  });

  it('preserves sandbox mode instead of presenting test prices as live', async () => {
    const provider = new DuffelFlightDiscoveryProvider({
      accessToken: 'duffel_test_secret',
      fetchFn: successfulFetch(false),
    });

    const offers = await provider.search(specification, context);

    expect(offers[0]?.attributes.liveMode).toBe(false);
  });

  it('returns no stale offer after its provider expiration', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { id: 'orq_live_search', live_mode: true },
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ ...offer(), expires_at: '2026-08-30T11:59:59.000Z' }],
          }),
          { status: 200 },
        ),
      );
    const provider = new DuffelFlightDiscoveryProvider({
      accessToken: 'secret',
      fetchFn,
    });

    await expect(provider.search(specification, context)).resolves.toEqual([]);
  });

  it('returns a safe authentication failure without exposing the token', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          errors: [{ code: 'access_token_not_found' }],
          meta: { request_id: 'duffel-request-1' },
        }),
        { status: 401 },
      ),
    );
    const provider = new DuffelFlightDiscoveryProvider({
      accessToken: 'never-log-this',
      fetchFn,
    });

    const failure = await provider
      .search(specification, context)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HttpError);
    expect(failure).toMatchObject({ code: 'DUFFEL_AUTH_FAILED' });
    expect(JSON.stringify(failure)).not.toContain('never-log-this');
  });

  it('fails closed when Duffel returns a malformed offer payload', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { id: 'orq_live_search', live_mode: true },
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ approved: true }] }), {
          status: 200,
        }),
      );
    const provider = new DuffelFlightDiscoveryProvider({
      accessToken: 'secret',
      fetchFn,
    });

    await expect(provider.search(specification, context)).rejects.toMatchObject(
      {
        code: 'DUFFEL_INVALID_RESPONSE',
      },
    );
  });
});
