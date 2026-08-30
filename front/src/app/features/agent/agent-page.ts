import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { finalize, switchMap } from 'rxjs';
import { ApiClient, IntentMessage, PurchaseIntentResult } from '../../core/api-client';
import { AppNav } from '../../shared/app-nav';

@Component({ selector: 'app-agent-page', imports: [FormsModule, AppNav], templateUrl: './agent-page.html', styleUrl: './agent-page.css' })
export class AgentPage {
  readonly intentId = signal<string | null>(null);
  readonly messages = signal<IntentMessage[]>([]);
  readonly busy = signal(false);
  readonly ready = signal(false);
  readonly mobilePanel = signal<'chat' | 'context'>('chat');
  readonly reviewBusy = signal(false);
  readonly reviewError = signal('');
  reply = '';
  readonly prompt = computed(() => this.messages().find((message) => message.role === 'USER')?.content ?? 'Buy me a flight to Córdoba if it costs less than $150.');

  constructor(route: ActivatedRoute, private readonly api: ApiClient, private readonly router: Router) {
    const state = (typeof history === 'undefined' ? {} : history.state) as { result?: PurchaseIntentResult; prompt?: string };
    const queryPrompt = route.snapshot.queryParamMap.get('prompt');
    if (state.result) { this.intentId.set(state.result.intent.id); this.messages.set(state.result.messages); }
    else {
      const prompt = state.prompt || queryPrompt || 'Buy me a flight to Córdoba if it costs less than $150.';
      this.messages.set([{ role: 'USER', content: prompt }, { role: 'AGENT', content: 'I can help with that. Should this authorization cover one traveler, economy class, and remain valid until the end of this month?' }]);
    }
  }

  send(): void {
    const content = this.reply.trim(); if (!content || this.busy()) return;
    this.messages.update((messages) => [...messages, { role: 'USER', content }]); this.reply = '';
    const id = this.intentId();
    if (!id) { this.busy.set(true); window.setTimeout(() => { this.messages.update((messages) => [...messages, { role: 'AGENT', content: 'Understood. I have enough detail to prepare separate search and authorization specifications for your review.' }]); this.ready.set(true); this.busy.set(false); }, 650); return; }
    this.busy.set(true);
    this.api.addIntentMessage(id, content).pipe(finalize(() => this.busy.set(false))).subscribe({ next: (result) => { this.messages.update((messages) => [...messages, ...result.messages.filter((message) => message.role === 'AGENT')]); this.ready.set(result.ready); } });
  }

  reviewMandate(): void {
    const id = this.intentId();
    if (!id) { void this.router.navigate(['/mandates/demo']); return; }
    this.reviewBusy.set(true); this.reviewError.set('');
    this.api.finalizeIntent(id).pipe(
      switchMap(() => this.api.createMandateDraft(id, 'AUTONOMOUS')),
      finalize(() => this.reviewBusy.set(false)),
    ).subscribe({
      next: ({ mandate }) => void this.router.navigate(['/mandates', mandate.id]),
      error: (error: Error) => this.reviewError.set(error.message),
    });
  }
}
