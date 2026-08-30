import { z } from 'zod';

import { HttpError } from '../../shared/http-error.js';
import type { SearchSpecification } from '../purchase-intents/specifications.js';
import type {
  DiscoveredOffer,
  DiscoveryContext,
  DiscoveryProvider,
} from './discovery-types.js';

export const DUFFEL_MERCHANT_ID = '10000000-0000-4000-8000-000000000004';

const DUFFEL_API_URL = 'https://api.duffel.com';
const iataCode = z.string().regex(/^[A-Z]{3}$/);
const carrierSchema = z
  .object({
    name: z.string().min(1),
    iata_code: z.string().nullable().optional(),
  })
  .passthrough();
const placeSchema = z
  .object({
    iata_code: iataCode,
    time_zone: z.string().min(1).nullable().optional(),
  })
  .passthrough();
const segmentSchema = z
  .object({
    departing_at: z.string().min(1),
    arriving_at: z.string().min(1),
    origin: placeSchema,
    destination: placeSchema,
    operating_carrier: carrierSchema,
    marketing_carrier: carrierSchema.optional(),
    marketing_carrier_flight_number: z.string().min(1).nullable().optional(),
  })
  .passthrough();
const sliceSchema = z
  .object({
    duration: z.string().min(1).nullable().optional(),
    segments: z.array(segmentSchema).min(1),
  })
  .passthrough();
const offerSchema = z
  .object({
    id: z.string().startsWith('off_'),
    live_mode: z.boolean(),
    expires_at: z.string().min(1),
    total_amount: z.string().regex(/^\d+(?:\.\d+)?$/),
    total_currency: z.string().regex(/^[A-Z]{3}$/),
    owner: carrierSchema,
    slices: z.array(sliceSchema).min(1),
  })
  .passthrough();
const offerRequestResponseSchema = z
  .object({
    data: z
      .object({ id: z.string().startsWith('orq_'), live_mode: z.boolean() })
      .passthrough(),
  })
  .passthrough();
const offerListResponseSchema = z
  .object({
    data: z.array(offerSchema),
  })
  .passthrough();
const errorResponseSchema = z
  .object({
    errors: z
      .array(z.object({ code: z.string().optional() }).passthrough())
      .optional(),
    meta: z
      .object({ request_id: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

interface DuffelFlightProviderOptions {
  readonly accessToken: string;
  readonly supplierTimeoutMs?: number;
  readonly searchTimeoutMs?: number;
  readonly maxOffers?: number;
  readonly fetchFn?: typeof fetch;
}

export class DuffelFlightDiscoveryProvider implements DiscoveryProvider {
  readonly id = 'duffel-flights';
  readonly providerTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly supplierTimeoutMs: number;
  private readonly maxOffers: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: DuffelFlightProviderOptions) {
    this.supplierTimeoutMs = options.supplierTimeoutMs ?? 10_000;
    this.requestTimeoutMs = options.searchTimeoutMs ?? 15_000;
    this.providerTimeoutMs = this.requestTimeoutMs + 1_000;
    this.maxOffers = options.maxOffers ?? 20;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async search(
    specification: SearchSpecification,
    context: DiscoveryContext,
  ): Promise<DiscoveredOffer[]> {
    if (specification.category !== 'travel.flight') return [];
    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    const offerRequest = await this.request(
      '/air/offer_requests',
      offerRequestResponseSchema,
      {
        method: 'POST',
        query: {
          return_offers: 'false',
          supplier_timeout: String(this.supplierTimeoutMs),
        },
        body: {
          data: {
            cabin_class: 'economy',
            slices: [
              {
                origin: specification.origin.iata,
                destination: specification.destination.iata,
                departure_date: specification.departureDate,
              },
            ],
            passengers: Array.from(
              { length: specification.passengers },
              () => ({ type: 'adult' }),
            ),
          },
        },
        ...(context.correlationId
          ? { correlationId: context.correlationId }
          : {}),
        signal,
      },
    );
    const result = await this.request('/air/offers', offerListResponseSchema, {
      method: 'GET',
      query: {
        offer_request_id: offerRequest.data.id,
        sort: 'total_amount',
        limit: String(this.maxOffers),
      },
      ...(context.correlationId
        ? { correlationId: context.correlationId }
        : {}),
      signal,
    });
    return result.data.flatMap((offer) =>
      this.normalizeOffer(offer, offerRequest.data.id, specification, context),
    );
  }

  private normalizeOffer(
    offer: z.infer<typeof offerSchema>,
    offerRequestId: string,
    specification: SearchSpecification,
    context: DiscoveryContext,
  ): DiscoveredOffer[] {
    const firstSlice = offer.slices[0]!;
    const firstSegment = firstSlice.segments[0]!;
    const lastSegment = firstSlice.segments.at(-1)!;
    const expiresAt = new Date(offer.expires_at);
    if (
      Number.isNaN(expiresAt.getTime()) ||
      expiresAt <= context.observedAt ||
      firstSegment.departing_at.slice(0, 10) !== specification.departureDate
    )
      return [];

    const operatingCarriers = unique(
      firstSlice.segments.map((segment) => segment.operating_carrier.name),
    );
    const operatingCarrierCodes = unique(
      firstSlice.segments.flatMap((segment) =>
        segment.operating_carrier.iata_code
          ? [segment.operating_carrier.iata_code]
          : [],
      ),
    );
    const flightNumbers = unique(
      firstSlice.segments.flatMap((segment) =>
        segment.marketing_carrier_flight_number
          ? [segment.marketing_carrier_flight_number]
          : [],
      ),
    );
    const departureTime = zonedLocalToIso(
      firstSegment.departing_at,
      firstSegment.origin.time_zone,
    );
    const arrivalTime = zonedLocalToIso(
      lastSegment.arriving_at,
      lastSegment.destination.time_zone,
    );
    const stops = Math.max(0, firstSlice.segments.length - 1);
    const stopLabel =
      stops === 0 ? 'Nonstop' : `${stops} stop${stops === 1 ? '' : 's'}`;

    return [
      {
        providerId: this.id,
        merchantId: DUFFEL_MERCHANT_ID,
        merchantProductId: offer.id,
        productName: `${operatingCarriers.join(' + ')} ${specification.origin.iata} → ${specification.destination.iata}`,
        description: [stopLabel, firstSlice.duration, flightNumbers.join(', ')]
          .filter(Boolean)
          .join(' · '),
        category: 'travel.flight',
        unitPriceMinor: decimalToMinorUnits(
          offer.total_amount,
          offer.total_currency,
        ),
        currency: offer.total_currency,
        availability: 'IN_STOCK',
        ...(departureTime ? { departureTime } : {}),
        sourceType: 'MERCHANT_API',
        sourceReference: `duffel://offers/${offer.id}`,
        observedAt: context.observedAt.toISOString(),
        confidence: 1,
        supportsAuthoritativeCheckout: false,
        attributes: {
          origin: specification.origin.iata,
          destination: specification.destination.iata,
          departureDate: specification.departureDate,
          passengers: specification.passengers,
          priceBasis: 'TOTAL_FOR_ALL_PASSENGERS',
          liveMode: offer.live_mode,
          offerExpiresAt: expiresAt.toISOString(),
          offerRequestId,
          ownerName: offer.owner.name,
          operatingCarriers,
          operatingCarrierCodes,
          flightNumbers,
          stops,
          duration: firstSlice.duration ?? null,
          departureLocal: firstSegment.departing_at,
          departureTimeZone: firstSegment.origin.time_zone ?? null,
          arrivalLocal: lastSegment.arriving_at,
          arrivalTimeZone: lastSegment.destination.time_zone ?? null,
          ...(arrivalTime ? { arrivalTime } : {}),
        },
      },
    ];
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    request: {
      readonly method: 'GET' | 'POST';
      readonly query: Readonly<Record<string, string>>;
      readonly body?: unknown;
      readonly correlationId?: string;
      readonly signal: AbortSignal;
    },
  ): Promise<T> {
    const url = new URL(path, DUFFEL_API_URL);
    for (const [name, value] of Object.entries(request.query))
      url.searchParams.set(name, value);
    try {
      const response = await this.fetchFn(url, {
        method: request.method,
        headers: {
          accept: 'application/json',
          'accept-encoding': 'gzip',
          authorization: `Bearer ${this.options.accessToken}`,
          'duffel-version': 'v2',
          ...(request.body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
          ...(request.correlationId
            ? { 'x-client-correlation-id': request.correlationId }
            : {}),
        },
        ...(request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
        signal: request.signal,
      });
      if (!response.ok) throw await this.upstreamError(response);
      return schema.parse(await response.json());
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new HttpError(
          502,
          'DUFFEL_INVALID_RESPONSE',
          'Duffel returned an invalid response',
        );
      }
      throw new HttpError(
        503,
        'DUFFEL_UNAVAILABLE',
        'Duffel flight search is unavailable',
      );
    }
  }

  private async upstreamError(response: Response): Promise<HttpError> {
    const parsed = errorResponseSchema.safeParse(
      await response.json().catch(() => undefined),
    );
    const requestId =
      response.headers.get('x-request-id') ?? parsed.data?.meta?.request_id;
    const upstreamCode = parsed.data?.errors?.[0]?.code;
    const code =
      response.status === 401 || response.status === 403
        ? 'DUFFEL_AUTH_FAILED'
        : response.status === 429
          ? 'DUFFEL_RATE_LIMITED'
          : response.status >= 500
            ? 'DUFFEL_UNAVAILABLE'
            : 'DUFFEL_REQUEST_REJECTED';
    return new HttpError(
      code === 'DUFFEL_UNAVAILABLE' ? 503 : 502,
      code,
      'Duffel rejected the flight search request',
      {
        ...(requestId ? { requestId } : {}),
        ...(upstreamCode ? { upstreamCode } : {}),
      },
    );
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function decimalToMinorUnits(amount: string, currency: string): string {
  let exponent: number;
  try {
    exponent =
      new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    throw new HttpError(
      502,
      'DUFFEL_INVALID_RESPONSE',
      'Duffel returned an unsupported currency',
    );
  }
  const [whole, fraction = ''] = amount.split('.');
  if (!whole || fraction.length > exponent) {
    throw new HttpError(
      502,
      'DUFFEL_INVALID_RESPONSE',
      'Duffel returned an invalid currency amount',
    );
  }
  return `${whole}${fraction.padEnd(exponent, '0')}`.replace(/^0+(?=\d)/, '');
}

function zonedLocalToIso(
  localDateTime: string,
  timeZone: string | null | undefined,
): string | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(
      localDateTime,
    );
  if (!match || !timeZone) return undefined;
  const values = match.slice(1, 7).map(Number);
  const localAsUtc = Date.UTC(
    values[0]!,
    values[1]! - 1,
    values[2]!,
    values[3]!,
    values[4]!,
    values[5]!,
    Number((match[7] ?? '').padEnd(3, '0')),
  );
  try {
    let instant = localAsUtc;
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(instant));
      const part = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((value) => value.type === type)?.value);
      const represented = Date.UTC(
        part('year'),
        part('month') - 1,
        part('day'),
        part('hour'),
        part('minute'),
        part('second'),
      );
      instant = localAsUtc - (represented - instant);
    }
    return new Date(instant).toISOString();
  } catch {
    return undefined;
  }
}
