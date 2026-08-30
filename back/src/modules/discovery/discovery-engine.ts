import type { SearchSpecification } from '../purchase-intents/specifications.js';
import { discoveredOfferSchema, type DiscoveryContext, type DiscoveryProvider, type RankedOffer } from './discovery-types.js';

function departureMillis(offer: { departureTime?: string | undefined }): number {
  return offer.departureTime === undefined ? Number.MAX_SAFE_INTEGER : Date.parse(offer.departureTime);
}

export class DiscoveryEngine {
  constructor(
    private readonly providers: readonly DiscoveryProvider[],
    private readonly providerTimeoutMs = 3_000,
  ) {}

  get providerIds(): string[] {
    return this.providers.map((provider) => provider.id);
  }

  async discover(specification: SearchSpecification, context: DiscoveryContext): Promise<RankedOffer[]> {
    return (await this.discoverWithOutcomes(specification, context)).offers;
  }

  async discoverWithOutcomes(specification: SearchSpecification, context: DiscoveryContext) {
    const settled = await Promise.allSettled(this.providers.map(async (provider) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const offers = await Promise.race([
          provider.search(specification, context),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('PROVIDER_TIMEOUT')), this.providerTimeoutMs);
          }),
        ]);
        return { providerId: provider.id, offers };
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }));
    const providerResults = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value.offers] : []);
    const outcomes = settled.map((result, index) => ({
      providerId: this.providers[index]!.id,
      status: result.status === 'fulfilled' ? 'SUCCEEDED' as const
        : result.reason instanceof Error && result.reason.message === 'PROVIDER_TIMEOUT'
          ? 'TIMED_OUT' as const : 'FAILED' as const,
      offerCount: result.status === 'fulfilled' ? result.value.offers.length : 0,
    }));
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

    return {
      offers: offers.map((offer, index) => ({ ...offer, rank: index + 1, authoritative: false as const })),
      outcomes,
    };
  }
}
