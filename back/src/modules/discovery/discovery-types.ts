import { z } from 'zod';

import type { SearchSpecification } from '../purchase-intents/specifications.js';

export const discoveredOfferSchema = z.object({
  providerId: z.string().min(1),
  merchantId: z.uuid(),
  merchantProductId: z.string().min(1),
  productId: z.uuid().optional(),
  productName: z.string().min(1),
  description: z.string().min(1).optional(),
  category: z.string().min(1),
  unitPriceMinor: z.string().regex(/^\d+$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  availability: z.enum(['IN_STOCK', 'LIMITED', 'OUT_OF_STOCK']),
  departureTime: z.iso.datetime().optional(),
  sourceType: z.enum(['UCP', 'MERCHANT_API', 'INTERNAL_CATALOG', 'WEB', 'MOCK']),
  sourceReference: z.string().min(1),
  observedAt: z.iso.datetime(),
  confidence: z.number().min(0).max(1),
  supportsAuthoritativeCheckout: z.boolean(),
  attributes: z.record(z.string(), z.unknown()).default({}),
}).strict();

export type DiscoveredOffer = z.infer<typeof discoveredOfferSchema>;

export interface DiscoveryContext {
  readonly observedAt: Date;
}

export interface DiscoveryProvider {
  readonly id: string;
  search(
    specification: SearchSpecification,
    context: DiscoveryContext,
  ): Promise<readonly DiscoveredOffer[]>;
}

export interface RankedOffer extends DiscoveredOffer {
  readonly rank: number;
  readonly authoritative: false;
}
