import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { finalize, switchMap } from 'rxjs';
import { ApiClient, PurchaseClientContext } from '../../core/api-client';
import { AppNav } from '../../shared/app-nav';

interface IntentPreset { title: string; caption: string; prompt: string; icon: string; }

@Component({ selector: 'app-intent-page', imports: [FormsModule, AppNav], templateUrl: './intent-page.html', styleUrl: './intent-page.css' })
export class IntentPage {
  readonly presets: IntentPreset[] = [
    { title: 'Plan a trip', caption: 'Flights and stays within a precise budget', icon: '✦', prompt: 'Buy me a flight to Córdoba if it costs less than $150, valid until the end of the month.' },
    { title: 'Restock essentials', caption: 'Repeat purchases with frequency limits', icon: '↻', prompt: 'Restock our office coffee when fewer than two bags remain. Spend no more than $80 monthly.' },
    { title: 'Compare a plan', caption: 'Evaluate subscriptions before committing', icon: '◇', prompt: 'Find a project management plan for 12 people under $120 per month. Ask before subscribing.' },
    { title: 'Watch a price', caption: 'Purchase only when a condition becomes true', icon: '⌁', prompt: 'Buy Apple AirPods Pro if the total price drops below $220 before September 5.' },
  ];
  readonly selected = signal(0);
  readonly busy = signal(false);
  readonly error = signal('');
  prompt = this.presets[0].prompt;

  constructor(private readonly api: ApiClient, private readonly router: Router) {}
  select(index: number): void { this.selected.set(index); this.prompt = this.presets[index].prompt; }
  async continue(): Promise<void> {
    const request = this.prompt.trim();
    if (!request || this.busy()) return;
    this.busy.set(true); this.error.set('');
    const clientContext = await this.clientContext();
    this.api.listAgents().pipe(
      switchMap(({ agents }) => agents[0] ? this.api.createIntent(agents[0].id, request, clientContext) : this.api.createAgent().pipe(switchMap(({ agent }) => this.api.createIntent(agent.id, request, clientContext)))),
      finalize(() => this.busy.set(false)),
    ).subscribe({
      next: (result) => void this.router.navigate(['/agent'], {
        queryParams: { intentId: result.intent.id },
        state: { result, prompt: request },
      }),
      error: (error: Error) => this.error.set(error.message),
    });
  }

  private async clientContext(): Promise<PurchaseClientContext> {
    const base: PurchaseClientContext = {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      locale: navigator.language || 'en-US',
      observedAt: new Date().toISOString(),
    };
    if (!navigator.geolocation) return base;
    const position = await new Promise<GeolocationPosition | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), {
        enableHighAccuracy: false,
        maximumAge: 300_000,
        timeout: 1_500,
      });
    });
    if (!position) return base;
    return {
      ...base,
      location: {
        latitude: Number(position.coords.latitude.toFixed(2)),
        longitude: Number(position.coords.longitude.toFixed(2)),
        accuracyMeters: Math.max(position.coords.accuracy, 1_500),
      },
    };
  }
}
