import { and, asc, eq, inArray } from 'drizzle-orm';

import type { DatabaseClient } from '../../database/client.js';
import { AuditService } from '../audit/audit-service.js';
import { discoveryRuns, merchants, offers, purchaseIntents } from '../../database/schema.js';
import { HttpError } from '../../shared/http-error.js';
import { authorizationSpecificationSchema, searchSpecificationSchema, type SearchSpecification } from '../purchase-intents/specifications.js';
import { DiscoveryEngine } from './discovery-engine.js';
import type { DiscoveredOffer, RankedOffer } from './discovery-types.js';

export class DiscoveryService {
  private readonly audit: AuditService;

  constructor(
    private readonly database: DatabaseClient,
    private readonly engine: DiscoveryEngine,
  ) {
    this.audit = new AuditService(database);
  }

  async start(userId: string, intentId: string) {
    const intent = await this.findOwnedIntent(userId, intentId);
    if (!['MANDATE_AUTHORIZED', 'SEARCHING'].includes(intent.status)) {
      throw new HttpError(409, 'MANDATE_AUTHORIZATION_REQUIRED',
        'An active authorized mandate is required before discovery');
    }

    const specification = searchSpecificationSchema.safeParse(intent.searchSpecification);
    if (!specification.success) {
      throw new HttpError(409, 'SEARCH_SPECIFICATION_REQUIRED',
        'A valid search specification is required before discovery');
    }
    const authorization = authorizationSpecificationSchema.safeParse(intent.authorizationSpecification);
    if (!authorization.success) {
      throw new HttpError(409, 'AUTHORIZATION_SPECIFICATION_REQUIRED',
        'A valid authorization specification is required before discovery');
    }

    const startedAt = new Date();
    const [run] = await this.database.db.insert(discoveryRuns).values({
      intentId,
      status: 'RUNNING',
      providerIds: this.engine.providerIds,
      startedAt,
    }).returning();
    if (!run) throw new Error('Discovery run insert did not return a row');

    try {
      const discovery = await this.engine.discoverWithOutcomes(specification.data, { observedAt: startedAt });
      const activeMerchants = await this.activeMerchants(discovery.offers);
      const screenedOffers = discovery.offers
        .filter((offer) => activeMerchants.has(offer.merchantId))
        .map((offer) => ({
          ...offer,
          preliminaryCompliance: this.preliminaryCompliance(offer, authorization.data),
        }));
      screenedOffers.sort((left, right) => {
        const eligibility = Number(left.preliminaryCompliance.decision === 'INELIGIBLE')
          - Number(right.preliminaryCompliance.decision === 'INELIGIBLE');
        return eligibility || left.rank - right.rank;
      });
      const rankedOffers = screenedOffers.map((offer, index) => ({ ...offer, rank: index + 1 }));
      const completedAt = new Date();

      const storedOffers = await this.database.db.transaction(async (transaction) => {
        const records = rankedOffers.length === 0 ? [] : await transaction.insert(offers).values(
          rankedOffers.map((offer) => ({
            discoveryRunId: run.id,
            providerId: offer.providerId,
            merchantId: offer.merchantId,
            merchantProductId: offer.merchantProductId,
            productId: offer.productId,
            productName: offer.productName,
            description: offer.description,
            category: offer.category,
            unitPriceMinor: BigInt(offer.unitPriceMinor),
            currency: offer.currency,
            availability: offer.availability,
            sourceType: offer.sourceType,
            sourceReference: offer.sourceReference,
            observedAt: new Date(offer.observedAt),
            confidence: offer.confidence.toFixed(4),
            supportsAuthoritativeCheckout: offer.supportsAuthoritativeCheckout,
            rawPayload: {
              attributes: offer.attributes,
              departureTime: offer.departureTime,
              preliminaryCompliance: offer.preliminaryCompliance,
            },
          })),
        ).returning();

        await transaction.update(discoveryRuns).set({ status: 'COMPLETED', completedAt })
          .where(eq(discoveryRuns.id, run.id));
        await transaction.update(purchaseIntents).set({ status: 'SEARCHING', updatedAt: completedAt })
          .where(eq(purchaseIntents.id, intentId));
        return records;
      });

      const byProduct = new Map(storedOffers.map((offer) => [offer.merchantProductId, offer]));
      await this.audit.append({
        eventType: 'DISCOVERY_COMPLETED', actorType: 'AGENT', actorId: intent.agentId, intentId,
        payload: { runId: run.id, providerOutcomes: discovery.outcomes, offerCount: rankedOffers.length },
      });
      return {
        run: { ...run, status: 'COMPLETED' as const, completedAt },
        providerOutcomes: discovery.outcomes,
        context: {
          searchSpecification: specification.data,
          authorizationSpecification: authorization.data,
        },
        offers: rankedOffers.map((offer) => this.serializeOffer(
          byProduct.get(offer.merchantProductId)!, offer.rank, activeMerchants.get(offer.merchantId)!,
        )),
      };
    } catch (error) {
      await this.database.db.update(discoveryRuns).set({
        status: 'FAILED',
        completedAt: new Date(),
        failureCode: error instanceof HttpError ? error.code : 'DISCOVERY_PROVIDER_FAILED',
      }).where(eq(discoveryRuns.id, run.id));
      throw error;
    }
  }

  async get(userId: string, runId: string) {
    const run = await this.findOwnedRun(userId, runId);
    return { run };
  }

  async listOffers(userId: string, runId: string) {
    const run = await this.findOwnedRun(userId, runId);
    const intent = await this.findOwnedIntent(userId, run.intentId);
    const specification = searchSpecificationSchema.parse(intent.searchSpecification);
    const records = await this.database.db.select().from(offers)
      .where(eq(offers.discoveryRunId, runId))
      .orderBy(asc(offers.createdAt), asc(offers.id));
    const merchantNames = await this.activeMerchants(records);
    const ranked = this.rankStored(
      records.filter((offer) => merchantNames.has(offer.merchantId)),
      specification,
      merchantNames,
    );
    return { offers: ranked };
  }

  private async activeMerchants(discovered: readonly { merchantId: string }[]): Promise<Map<string, string>> {
    const merchantIds = [...new Set(discovered.map((offer) => offer.merchantId))];
    if (merchantIds.length === 0) return new Map();
    const active = await this.database.db.select({ id: merchants.id, name: merchants.name }).from(merchants)
      .where(and(inArray(merchants.id, merchantIds), eq(merchants.status, 'ACTIVE')));
    return new Map(active.map((merchant) => [merchant.id, merchant.name]));
  }

  private rankStored(records: readonly (typeof offers.$inferSelect)[], specification: SearchSpecification, merchantNames: Map<string, string>) {
    const ranked = [...records].sort((left, right) => {
      const eligibility = Number(this.isStoredIneligible(left.rawPayload))
        - Number(this.isStoredIneligible(right.rawPayload));
      if (eligibility !== 0) return eligibility;
      for (const preference of specification.rankingPreferences) {
        const comparison = preference === 'lowest_total_price'
          ? left.unitPriceMinor < right.unitPriceMinor ? -1 : left.unitPriceMinor > right.unitPriceMinor ? 1 : 0
          : this.departureMillis(left.rawPayload) - this.departureMillis(right.rawPayload);
        if (comparison !== 0) return comparison;
      }
      return left.merchantProductId.localeCompare(right.merchantProductId);
    });
    return ranked.map((offer, index) => this.serializeOffer(offer, index + 1, merchantNames.get(offer.merchantId) ?? 'Unavailable merchant'));
  }

  private isStoredIneligible(rawPayload: unknown): boolean {
    if (!rawPayload || typeof rawPayload !== 'object' || !('preliminaryCompliance' in rawPayload)) return true;
    const compliance = rawPayload.preliminaryCompliance;
    return Boolean(compliance && typeof compliance === 'object'
      && 'decision' in compliance && compliance.decision === 'INELIGIBLE');
  }

  private departureMillis(rawPayload: unknown): number {
    if (!rawPayload || typeof rawPayload !== 'object' || !('departureTime' in rawPayload)) {
      return Number.MAX_SAFE_INTEGER;
    }
    const value = rawPayload.departureTime;
    return typeof value === 'string' ? Date.parse(value) : Number.MAX_SAFE_INTEGER;
  }

  private serializeOffer(record: typeof offers.$inferSelect, rank: number, merchantName: string) {
    return {
      ...record,
      unitPriceMinor: record.unitPriceMinor.toString(),
      confidence: Number(record.confidence),
      merchantName,
      rank,
      authoritative: false as const,
    };
  }

  private preliminaryCompliance(offer: DiscoveredOffer, authorization: ReturnType<typeof authorizationSpecificationSchema.parse>) {
    const attributes = offer.attributes;
    const reasons: string[] = [];
    if (offer.category !== authorization.productConstraints.category) reasons.push('CATEGORY_NOT_ALLOWED');
    if (attributes.origin !== authorization.productConstraints.originIata) reasons.push('ORIGIN_NOT_ALLOWED');
    if (attributes.destination !== authorization.productConstraints.destinationIata) reasons.push('DESTINATION_NOT_ALLOWED');
    if (attributes.departureDate !== authorization.productConstraints.departureDate) reasons.push('DEPARTURE_DATE_NOT_ALLOWED');
    if (attributes.passengers !== authorization.productConstraints.quantity) reasons.push('QUANTITY_NOT_ALLOWED');
    if (BigInt(offer.unitPriceMinor) > BigInt(authorization.spendConstraints.maxTotalMinor)) reasons.push('AMOUNT_EXCEEDS_MANDATE');
    if (offer.currency !== authorization.spendConstraints.currency) reasons.push('CURRENCY_NOT_ALLOWED');
    if (!offer.supportsAuthoritativeCheckout) reasons.push('AUTHORITATIVE_CHECKOUT_UNAVAILABLE');
    return { decision: reasons.length === 0 ? 'ELIGIBLE' : 'INELIGIBLE', reasons };
  }

  private async findOwnedIntent(userId: string, intentId: string) {
    const [intent] = await this.database.db.select().from(purchaseIntents)
      .where(and(eq(purchaseIntents.id, intentId), eq(purchaseIntents.userId, userId))).limit(1);
    if (!intent) throw new HttpError(404, 'PURCHASE_INTENT_NOT_FOUND', 'Purchase intent not found');
    return intent;
  }

  private async findOwnedRun(userId: string, runId: string) {
    const [record] = await this.database.db.select({ run: discoveryRuns })
      .from(discoveryRuns)
      .innerJoin(purchaseIntents, eq(purchaseIntents.id, discoveryRuns.intentId))
      .where(and(eq(discoveryRuns.id, runId), eq(purchaseIntents.userId, userId))).limit(1);
    if (!record) throw new HttpError(404, 'DISCOVERY_RUN_NOT_FOUND', 'Discovery run not found');
    return record.run;
  }
}
