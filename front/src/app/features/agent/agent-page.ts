import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { finalize, switchMap } from 'rxjs';
import { ApiClient, FlightIntentDraft, IntentMessage, PurchaseIntentResult } from '../../core/api-client';
import { AppNav } from '../../shared/app-nav';

interface DisplayConstraint {
  label: string;
  value: string;
  confirmed: boolean;
}

@Component({ selector: 'app-agent-page', imports: [FormsModule, AppNav], templateUrl: './agent-page.html', styleUrl: './agent-page.css' })
export class AgentPage {
  readonly intentId = signal<string | null>(null);
  readonly messages = signal<IntentMessage[]>([]);
  readonly intentStatus = signal('CLARIFYING');
  readonly intentDraft = signal<FlightIntentDraft | null>(null);
  readonly mandateId = signal<string | null>(null);
  readonly busy = signal(false);
  readonly ready = signal(false);
  readonly mobilePanel = signal<'chat' | 'context'>('chat');
  readonly reviewBusy = signal(false);
  readonly reviewError = signal('');
  readonly conversationError = signal('');
  readonly demoMode = signal(false);
  reply = '';
  readonly prompt = computed(() => this.messages().find((message) => message.role === 'USER')?.content ?? 'Buy me a flight to Córdoba if it costs less than $150.');
  readonly authorized = computed(() => this.intentStatus() === 'MANDATE_AUTHORIZED');
  readonly constraints = computed<DisplayConstraint[]>(() => {
    const draft = this.intentDraft();
    const route = draft?.origin && draft.destination ? `${draft.origin.iata} → ${draft.destination.iata}` : null;
    const budget = draft?.maxTotalMinor && draft.currency
      ? `${draft.currency} ${(Number(draft.maxTotalMinor) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
      : null;
    return [
      { label: 'Route', value: route ?? 'Origin and destination needed', confirmed: Boolean(route) },
      { label: 'Travel date', value: draft?.departureDate ? this.formatDate(draft.departureDate) : 'Departure date needed', confirmed: Boolean(draft?.departureDate) },
      { label: 'Travelers', value: draft?.passengers ? `${draft.passengers} ${draft.passengers === 1 ? 'passenger' : 'passengers'}` : 'Passenger count needed', confirmed: Boolean(draft?.passengers) },
      { label: 'Maximum total', value: budget ?? 'Budget and currency needed', confirmed: Boolean(budget) },
      { label: 'Mandate expiry', value: draft?.validUntil ? this.formatDateTime(draft.validUntil) : 'Expiration needed', confirmed: Boolean(draft?.validUntil) },
      { label: 'Final approval', value: draft?.requiresFinalConfirmation === null || draft?.requiresFinalConfirmation === undefined ? 'Decision needed' : draft.requiresFinalConfirmation ? 'Required' : 'Not required', confirmed: draft?.requiresFinalConfirmation !== null && draft?.requiresFinalConfirmation !== undefined },
    ];
  });
  readonly confirmedCount = computed(() => this.constraints().filter((constraint) => constraint.confirmed).length);

  constructor(route: ActivatedRoute, private readonly api: ApiClient, private readonly router: Router) {
    const state = (typeof history === 'undefined' ? {} : history.state) as { result?: PurchaseIntentResult; prompt?: string };
    const queryPrompt = route.snapshot.queryParamMap.get('prompt');
    const queryIntentId = route.snapshot.queryParamMap.get('intentId');
    this.demoMode.set(route.snapshot.queryParamMap.get('demo') === 'true');
    if (state.result) { this.applyResult(state.result); }
    else if (queryIntentId) {
      this.busy.set(true);
      this.api.getIntent(queryIntentId).pipe(finalize(() => this.busy.set(false))).subscribe({
        next: (result) => {
          this.applyResult(result);
        },
        error: (error: Error) => this.conversationError.set(error.message),
      });
    } else if (this.demoMode()) {
      const prompt = state.prompt || queryPrompt || 'Buy me a flight to Córdoba if it costs less than $150.';
      this.messages.set([{ role: 'USER', content: prompt }, { role: 'AGENT', content: 'I can help with that. Should this authorization cover one traveler, economy class, and remain valid until the end of this month?' }]);
    } else void this.router.navigateByUrl('/intent');
  }

  send(): void {
    const content = this.reply.trim(); if (!content || this.busy()) return;
    this.messages.update((messages) => [...messages, { role: 'USER', content }]); this.reply = '';
    const id = this.intentId();
    if (!id) {
      if (this.demoMode()) {
        this.busy.set(true);
        window.setTimeout(() => {
          this.messages.update((messages) => [...messages, { role: 'AGENT', content: 'Presentation mode: the demo intent is ready for mandate review.' }]);
          this.ready.set(true);
          this.busy.set(false);
        }, 650);
      }
      return;
    }
    this.busy.set(true);
    this.conversationError.set('');
    this.api.addIntentMessage(id, content).pipe(finalize(() => this.busy.set(false))).subscribe({
      next: (result) => {
        this.messages.update((messages) => [...messages, ...result.messages.filter((message) => message.role === 'AGENT')]);
        this.intentDraft.set(result.intentDraft);
        this.intentStatus.set(result.status);
        this.ready.set(result.ready);
      },
      error: (error: Error) => this.conversationError.set(error.message),
    });
  }

  reviewMandate(): void {
    const id = this.intentId();
    if (!id) { if (this.demoMode()) void this.router.navigate(['/mandates/demo']); return; }
    if (this.authorized() && this.mandateId()) {
      void this.router.navigate(['/mandates', this.mandateId()]);
      return;
    }
    this.reviewBusy.set(true); this.reviewError.set('');
    this.api.finalizeIntent(id).pipe(
      switchMap(() => this.api.createMandateDraft(id, 'AUTONOMOUS')),
      finalize(() => this.reviewBusy.set(false)),
    ).subscribe({
      next: ({ mandate }) => void this.router.navigate(['/mandates', mandate.id]),
      error: (error: Error) => this.reviewError.set(error.message),
    });
  }

  private applyResult(result: PurchaseIntentResult): void {
    this.intentId.set(result.intent.id);
    this.messages.set(result.messages);
    this.intentStatus.set(result.intent.status);
    this.intentDraft.set(result.intent.intentDraft ?? null);
    this.ready.set(result.intent.status === 'READY_FOR_MANDATE' || result.intent.status === 'MANDATE_AUTHORIZED');
    if (result.intent.status === 'MANDATE_AUTHORIZED') {
      this.api.listMandates().subscribe({
        next: ({ mandates }) => this.mandateId.set(mandates.find((mandate) => mandate.intentId === result.intent.id)?.id ?? null),
        error: () => undefined,
      });
    }
  }

  private formatDate(value: string): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
  }

  private formatDateTime(value: string): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }
}
