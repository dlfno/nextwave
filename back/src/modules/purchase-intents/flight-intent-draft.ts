import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { ConversationMessage } from './purchasing-agent-provider.js';
import type { Specifications } from './specifications.js';

const iataCode = z.string().regex(/^[A-Z]{3}$/);
const currencyCode = z.string().regex(/^[A-Z]{3}$/);
const sourceIndex = z.number().int().nonnegative().nullable();

export const flightIntentDraftSchema = z.object({
  origin: z.object({ city: z.string().min(1), iata: iataCode }).strict().nullable(),
  destination: z.object({ city: z.string().min(1), country: z.string().min(1), iata: iataCode }).strict().nullable(),
  departureDate: z.iso.date().nullable(),
  passengers: z.number().int().positive().max(9).nullable(),
  maxTotalMinor: z.string().regex(/^\d+$/).nullable(),
  currency: currencyCode.nullable(),
  validUntil: z.iso.datetime().nullable(),
  requiresFinalConfirmation: z.boolean().nullable(),
  sources: z.object({
    origin: sourceIndex,
    destination: sourceIndex,
    departureDate: sourceIndex,
    passengers: sourceIndex,
    maxTotalMinor: sourceIndex,
    currency: sourceIndex,
    validUntil: sourceIndex,
    requiresFinalConfirmation: sourceIndex,
  }).strict(),
}).strict();

export type FlightIntentDraft = z.infer<typeof flightIntentDraftSchema>;
export type FlightIntentField = Exclude<keyof FlightIntentDraft, 'sources'>;

export const FLIGHT_INTENT_FIELDS: readonly FlightIntentField[] = [
  'origin', 'destination', 'departureDate', 'passengers', 'maxTotalMinor', 'currency',
  'validUntil', 'requiresFinalConfirmation',
];

const AIRPORTS = new Map([
  ['MEX', { city: 'Mexico City', country: 'Mexico' }],
  ['LAX', { city: 'Los Angeles', country: 'United States' }],
  ['COR', { city: 'Córdoba', country: 'Argentina' }],
  ['ODB', { city: 'Córdoba', country: 'Spain' }],
]);

export function validateDraftSources(draft: FlightIntentDraft, messages: ConversationMessage[]): FlightIntentDraft {
  for (const field of FLIGHT_INTENT_FIELDS) {
    const value = draft[field];
    const index = draft.sources[field];
    if (value === null) {
      // Clearing stale provenance is safe: an empty field grants no authority.
      draft.sources[field] = null;
      continue;
    }
    if (index === null || messages[index]?.role !== 'USER') {
      throw new Error(`Field ${field} is not backed by a user message`);
    }
  }

  if (draft.origin && !AIRPORTS.has(draft.origin.iata)) throw new Error('Unknown origin airport');
  if (draft.destination && !AIRPORTS.has(draft.destination.iata)) throw new Error('Unknown destination airport');
  if (draft.origin) draft.origin.city = AIRPORTS.get(draft.origin.iata)!.city;
  if (draft.destination) {
    const airport = AIRPORTS.get(draft.destination.iata)!;
    draft.destination.city = airport.city;
    draft.destination.country = airport.country;
  }
  return draft;
}

export function missingDraftFields(draft: FlightIntentDraft): FlightIntentField[] {
  return FLIGHT_INTENT_FIELDS.filter((field) => draft[field] === null);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

export function hashIntentDraft(draft: FlightIntentDraft): string {
  return createHash('sha256').update(canonicalize(draft)).digest('hex');
}

export function compileSpecifications(draft: FlightIntentDraft): Specifications {
  const missing = missingDraftFields(draft);
  if (missing.length) throw new Error(`Incomplete intent draft: ${missing.join(', ')}`);
  const draftHash = hashIntentDraft(draft);
  return {
    searchSpecification: {
      query: `${draft.origin!.city} to ${draft.destination!.city} flight`,
      category: 'travel.flight',
      origin: draft.origin!,
      destination: draft.destination!,
      departureDate: draft.departureDate!,
      passengers: draft.passengers!,
      currency: draft.currency!,
      rankingPreferences: ['lowest_total_price', 'departure_time'],
    },
    authorizationSpecification: {
      intentDraftHash: draftHash,
      productConstraints: {
        category: 'travel.flight',
        originIata: draft.origin!.iata,
        destinationIata: draft.destination!.iata,
        departureDate: draft.departureDate!,
        quantity: draft.passengers!,
      },
      spendConstraints: { maxTotalMinor: draft.maxTotalMinor!, currency: draft.currency! },
      merchantConstraints: { allowedMerchants: 'ANY' },
      validUntil: draft.validUntil!,
      requiresFinalConfirmation: draft.requiresFinalConfirmation!,
    },
  };
}
