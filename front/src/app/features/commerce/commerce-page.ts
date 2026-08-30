import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, OnInit, computed, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { finalize, switchMap } from 'rxjs';
import { ApiClient, CheckoutAttempt, DiscoveryResult, MandateDecision, Offer, PurchaseResult } from '../../core/api-client';
import { DemoMandateState } from '../../core/demo-mandate-state';
import { AppNav } from '../../shared/app-nav';

type CommercePhase = 'DISCOVERING' | 'OFFERS' | 'CHECKOUT' | 'SUCCESS';

@Component({ selector: 'app-commerce-page', imports: [AppNav, RouterLink, DatePipe, DecimalPipe], templateUrl: './commerce-page.html', styleUrl: './commerce-page.css' })
export class CommercePage implements OnInit {
  readonly intentId: string; readonly demo: boolean;
  readonly phase = signal<CommercePhase>('DISCOVERING'); readonly offers = signal<Offer[]>([]);
  readonly selected = signal<Offer | null>(null); readonly attempt = signal<CheckoutAttempt | null>(null);
  readonly decision = signal<MandateDecision | null>(null); readonly result = signal<PurchaseResult | null>(null);
  readonly busy = signal(false); readonly error = signal(''); readonly approvalOpen = signal(false);
  readonly discoveryContext = signal<DiscoveryResult['context'] | null>(null);
  readonly providerOutcomes = signal<DiscoveryResult['providerOutcomes']>([]);
  readonly providerFailures = computed(() => this.providerOutcomes().filter(
    (provider) => provider.status === 'FAILED' || provider.status === 'TIMED_OUT',
  ));
  readonly discoverySteps = signal(['Connecting to merchant adapters', 'Normalizing offers']);
  readonly passedChecks = computed(() => this.decision()?.checks.filter((check) => check.passed).length ?? 0);

  constructor(route: ActivatedRoute, private readonly api: ApiClient, private readonly demoState: DemoMandateState) { this.intentId = route.snapshot.paramMap.get('intentId') ?? 'demo'; this.demo = this.intentId === 'demo'; }
  ngOnInit(): void {
    if (this.demo) { this.offers.set(this.demoOffers()); this.discoverySteps.set(['Merchant adapters connected', '2 offers normalized', 'Ranking complete']); this.phase.set('OFFERS'); return; }
    this.api.startDiscovery(this.intentId).subscribe({ next: ({ offers, providerOutcomes, context }) => { this.offers.set(offers); this.providerOutcomes.set(providerOutcomes); this.discoveryContext.set(context); const connected = providerOutcomes.filter((provider) => provider.status === 'SUCCEEDED').length; this.discoverySteps.set([`${connected} merchant adapters responded`, `${offers.length} offers normalized`, 'Mandate screening and ranking complete']); this.phase.set('OFFERS'); }, error: (error: Error) => { this.error.set(error.message); this.phase.set('OFFERS'); } });
  }
  choose(offer: Offer): void {
    if (!offer.supportsAuthoritativeCheckout) {
      this.error.set('This research result cannot be purchased until the merchant supplies an authoritative checkout.');
      return;
    }
    this.selected.set(offer); this.busy.set(true); this.error.set(''); this.decision.set(null);
    if (this.demo) { window.setTimeout(() => { const attempt = this.demoAttempt(offer); this.attempt.set(attempt); this.decision.set(this.demoState.get('ACTIVE') === 'REVOKED' ? this.revokedDecision(offer) : this.demoDecision(offer)); this.phase.set('CHECKOUT'); this.busy.set(false); }, 450); return; }
    this.api.selectOffer(this.intentId, offer.id).pipe(
      switchMap((attempt) => { this.attempt.set(attempt); return this.api.evaluateAttempt(attempt.attempt.id); }),
      finalize(() => this.busy.set(false)),
    ).subscribe({ next: ({ decision }) => { this.decision.set(decision); this.phase.set('CHECKOUT'); }, error: (error: Error) => this.error.set(error.message) });
  }
  backToOffers(): void { this.phase.set('OFFERS'); this.selected.set(null); this.attempt.set(null); this.decision.set(null); this.error.set(''); }
  approve(): void {
    const attempt = this.attempt(); if (!attempt) return;
    this.busy.set(true); this.error.set('');
    if (this.demo) { this.decision.set(this.demoDecision(this.selected()!, true)); this.approvalOpen.set(false); this.busy.set(false); return; }
    this.api.decideApproval(attempt.attempt.id, 'APPROVED').pipe(finalize(() => this.busy.set(false))).subscribe({ next: ({ decision }) => { this.decision.set(decision); this.approvalOpen.set(false); }, error: (error: Error) => this.error.set(error.message) });
  }
  denyApproval(): void {
    const attempt = this.attempt(); if (!attempt) return;
    if (this.demo) { this.approvalOpen.set(false); this.decision.update((decision) => decision ? { ...decision, decision: 'DENY', reasonCode: 'HUMAN_APPROVAL_DENIED' } : decision); return; }
    this.busy.set(true); this.error.set('');
    this.api.decideApproval(attempt.attempt.id, 'DENIED').pipe(finalize(() => this.busy.set(false))).subscribe({ next: ({ decision }) => { this.decision.set(decision); this.approvalOpen.set(false); }, error: (error: Error) => this.error.set(error.message) });
  }
  purchase(): void {
    const attempt = this.attempt(); if (!attempt || this.decision()?.decision !== 'ALLOW') return;
    this.busy.set(true); this.error.set('');
    if (this.demo) { if (this.demoState.get('ACTIVE') === 'REVOKED') { this.decision.set(this.revokedDecision(this.selected()!)); this.busy.set(false); return; } window.setTimeout(() => { this.result.set(this.demoResult()); this.phase.set('SUCCESS'); this.busy.set(false); }, 550); return; }
    this.api.executePurchase(attempt.attempt.id).pipe(finalize(() => this.busy.set(false))).subscribe({ next: (result) => { this.result.set(result); this.phase.set('SUCCESS'); }, error: (error: Error) => this.error.set(error.message) });
  }
  money(value: string, currency = 'USD'): number {
    const exponent = new Intl.NumberFormat('en', { style: 'currency', currency })
      .resolvedOptions().maximumFractionDigits ?? 2;
    return Number(value) / 10 ** exponent;
  }
  reasonLabel(reason: string): string { return reason.toLowerCase().replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase()); }
  departure(offer: Offer): string { return offer.rawPayload?.departureTime ?? (offer.merchantProductId.includes('130') ? '2026-09-15T14:00:00Z' : '2026-09-15T16:00:00Z'); }
  departureClock(offer: Offer): string {
    const local = offer.rawPayload?.attributes?.['departureLocal'];
    if (typeof local === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local)) {
      return local.slice(11, 16);
    }
    return new Intl.DateTimeFormat('en', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC',
    }).format(new Date(this.departure(offer)));
  }
  carrierLabel(offer: Offer): string {
    const carriers = offer.rawPayload?.attributes?.['operatingCarriers'];
    return Array.isArray(carriers) && carriers.every((carrier) => typeof carrier === 'string')
      ? carriers.join(' + ') : offer.merchantName;
  }
  sourceLabel(offer: Offer): string {
    if (offer.providerId === 'duffel-flights') {
      return offer.rawPayload?.attributes?.['liveMode'] === true
        ? 'Live carrier offer' : 'Duffel sandbox';
    }
    if (offer.sourceType === 'WEB') return 'Web research';
    return offer.supportsAuthoritativeCheckout ? 'Demo checkout' : 'Discovery only';
  }
  isLiveOffer(offer: Offer): boolean {
    return offer.providerId === 'duffel-flights'
      && offer.rawPayload?.attributes?.['liveMode'] === true;
  }
  isSandboxOffer(offer: Offer): boolean {
    return offer.providerId === 'duffel-flights'
      && offer.rawPayload?.attributes?.['liveMode'] === false;
  }
  merchantMark(offer: Offer | null): string { return (offer ? this.carrierLabel(offer) : 'Merchant').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(); }
  origin(): string { return this.discoveryContext()?.searchSpecification.origin.iata ?? 'MEX'; }
  destination(): string { return this.discoveryContext()?.searchSpecification.destination.iata ?? 'COR'; }
  passengers(): number { return this.discoveryContext()?.searchSpecification.passengers ?? 1; }
  departureDate(): string { return this.discoveryContext()?.searchSpecification.departureDate ?? '2026-09-15'; }
  mandateMaximum(): number { return this.money(this.discoveryContext()?.authorizationSpecification.spendConstraints.maxTotalMinor ?? '15000', this.mandateCurrency()); }
  mandateCurrency(): string { return this.discoveryContext()?.authorizationSpecification.spendConstraints.currency ?? 'USD'; }
  isEligible(offer: Offer): boolean { return offer.rawPayload?.preliminaryCompliance?.decision !== 'INELIGIBLE'; }

  private demoOffers(): Offer[] { const base = { providerId: 'mock-vuelaya', merchantId: 'vuelaya', merchantName: 'VuelaYa', category: 'travel.flight', currency: 'USD', availability: 'IN_STOCK', sourceType: 'MOCK', observedAt: new Date().toISOString(), confidence: 1, supportsAuthoritativeCheckout: true, authoritative: false as const }; return [
    { ...base, id: 'offer-130', merchantProductId: 'VY-MEX-COR-130', productName: 'Mexico City to Córdoba', description: 'Economy, one stop in Lima', unitPriceMinor: '13000', rank: 1, rawPayload: { departureTime: '2026-09-15T14:00:00Z' } },
    { ...base, id: 'offer-300', merchantProductId: 'VY-MEX-COR-300', productName: 'Mexico City to Córdoba Premium', description: 'Premium cabin, flexible ticket', unitPriceMinor: '30000', rank: 2, rawPayload: { departureTime: '2026-09-15T16:00:00Z' } },
  ]; }
  private demoAttempt(offer: Offer): CheckoutAttempt { return { attempt: { id: `attempt-${offer.id}`, status: 'QUOTED', mandateId: 'demo', mandateVersionId: 'demo-v1', selectedOfferId: offer.id }, quote: { id: `quote-${offer.id}`, totalMinor: offer.unitPriceMinor, currency: offer.currency, observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString() }, checkout: { id: `checkout-${offer.id}`, merchantId: 'vuelaya', totalMinor: offer.unitPriceMinor, currency: offer.currency, expiresAt: new Date(Date.now() + 300000).toISOString(), checkoutHash: '6Jh3Kp9aR2vL8nQ5mX1cT7sY4dW0fB', lineItems: [{ productName: offer.productName, quantity: 1, totalMinor: offer.unitPriceMinor, currency: offer.currency }] }, verification: { signatureValid: true, expired: false, replayed: false, hashValid: true, valid: true }, priceDriftMinor: '0' }; }
  private demoDecision(offer: Offer, approved = false): MandateDecision { const over = Number(offer.unitPriceMinor) > 15000; const requires = !over && !approved; const decision = over ? 'DENY' : requires ? 'REQUIRE_HUMAN_APPROVAL' : 'ALLOW'; const reasonCode = over ? 'AMOUNT_EXCEEDS_MANDATE' : requires ? 'HUMAN_APPROVAL_REQUIRED' : 'ALL_CONSTRAINTS_SATISFIED'; const names = ['MANDATE_SIGNATURE_VALID', 'AUTHORIZED_AGENT', 'MANDATE_ACTIVE', 'NOT_REVOKED', 'CHECKOUT_SIGNATURE_VALID', 'MERCHANT_ALLOWED', 'CATEGORY_ALLOWED', 'AMOUNT_WITHIN_LIMIT', 'HUMAN_APPROVAL']; return { decision, reasonCode, mandateVersion: 1, checkoutHash: '6Jh3Kp9aR2vL8nQ5mX1cT7sY4dW0fB', evaluatedAt: new Date().toISOString(), checks: names.map((name) => ({ name, passed: name === 'AMOUNT_WITHIN_LIMIT' ? !over : name === 'HUMAN_APPROVAL' ? approved : true, ...((name === 'AMOUNT_WITHIN_LIMIT' && over) ? { reasonCode } : {}) })) }; }
  private revokedDecision(offer: Offer): MandateDecision { const decision = this.demoDecision(offer); return { ...decision, decision: 'DENY', reasonCode: 'MANDATE_REVOKED', checks: decision.checks.map((check) => check.name === 'NOT_REVOKED' || check.name === 'HUMAN_APPROVAL' ? { ...check, passed: false, reasonCode: check.name === 'NOT_REVOKED' ? 'MANDATE_REVOKED' : check.reasonCode } : check) }; }
  private demoResult(): PurchaseResult { return { transaction: { id: 'txn_8f3c1a27', status: 'SUCCEEDED', amountMinor: '13000', currency: 'USD' }, order: { id: 'order_19ae72', merchantOrderId: 'VY-ORDER-84M2Q', status: 'CONFIRMED', totalMinor: '13000', currency: 'USD', items: [{ productName: 'Mexico City to Córdoba', quantity: 1 }] }, receipt: { id: 'receipt_42bd', payloadHash: 'aV7kP2nX9mR4cT8wQ1sF6gH3jL', issuedAt: new Date().toISOString() }, credential: { provider: 'MOCK_SPT', merchantId: 'vuelaya', maxAmountMinor: '13000', currency: 'USD', status: 'CONSUMED', expiresAt: new Date(Date.now() + 60000).toISOString() } }; }
}
