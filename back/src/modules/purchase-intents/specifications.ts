import { z } from 'zod';

const iataCode = z.string().regex(/^[A-Z]{3}$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
const minorAmount = z.string().regex(/^\d+$/);

export const searchSpecificationSchema = z.object({
  query: z.string().min(1).max(300),
  category: z.literal('travel.flight'),
  origin: z.object({ city: z.string().min(1), iata: iataCode }).strict(),
  destination: z.object({ city: z.string().min(1), country: z.string().min(1), iata: iataCode }).strict(),
  departureDate: z.iso.date(),
  passengers: z.number().int().positive().max(9),
  currency,
  rankingPreferences: z.array(z.enum(['lowest_total_price', 'departure_time'])).min(1),
}).strict();

export const authorizationSpecificationSchema = z.object({
  intentDraftHash: z.string().regex(/^[a-f0-9]{64}$/),
  productConstraints: z.object({
    category: z.literal('travel.flight'),
    originIata: iataCode,
    destinationIata: iataCode,
    departureDate: z.iso.date(),
    quantity: z.number().int().positive().max(9),
  }).strict(),
  spendConstraints: z.object({
    maxTotalMinor: minorAmount,
    currency,
  }).strict(),
  merchantConstraints: z.object({
    allowedMerchants: z.literal('ANY'),
  }).strict(),
  validUntil: z.iso.datetime(),
  requiresFinalConfirmation: z.boolean(),
}).strict();

export const specificationsSchema = z.object({
  searchSpecification: searchSpecificationSchema,
  authorizationSpecification: authorizationSpecificationSchema,
}).strict();

export type SearchSpecification = z.infer<typeof searchSpecificationSchema>;
export type AuthorizationSpecification = z.infer<typeof authorizationSpecificationSchema>;
export type Specifications = z.infer<typeof specificationsSchema>;
