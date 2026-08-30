import type { SearchSpecification } from '../purchase-intents/specifications.js';
import { discoveredOfferSchema, type DiscoveryContext, type DiscoveryProvider, type RankedOffer } from './discovery-types.js';

function departureMillis(offer: { departureTime?: string | undefined }): number {
  return offer.departureTime === undefined ? Number.MAX_SAFE_INTEGER : Date.parse(offer.departureTime);
}

export class DiscoveryEngine {
  constructor(private readonly providers: readonly DiscoveryProvider[]) {}

  get providerIds(): string[] {
    return this.providers.map((provider) => provider.id);
  }

  async discover(specification: SearchSpecification, context: DiscoveryContext): Promise<RankedOffer[]> {
    const providerResults = await Promise.all(
      this.providers.map((provider) => provider.search(specification, context)),
    );
    const offers = providerResults
      .flat()
      .map((offer) => discoveredOfferSchema.parse(offer))
      .filter((offer) => offer.availability !== 'OUT_OF_STOCK' && offer.currency === specification.currency);

    offers.sort((left, right) => {
      for (const preference of specification.rankingPreferences) {
        const comparison = preference === 'lowest_total_price'
          ? BigInt(left.unitPriceMinor) < BigInt(right.unitPriceMinor) ? -1
            : BigInt(left.unitPriceMinor) > BigInt(right.unitPriceMinor) ? 1 : 0
          : departureMillis(left) - departureMillis(right);
        if (comparison !== 0) return comparison;
      }
      return left.merchantProductId.localeCompare(right.merchantProductId);
    });

    return offers.map((offer, index) => ({ ...offer, rank: index + 1, authoritative: false }));
  }
}
