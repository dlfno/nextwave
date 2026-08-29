import { Component, OnDestroy, inject, signal } from '@angular/core';
import { DatePipe, JsonPipe } from '@angular/common';
import { Api, poll } from '../services/api';

interface TrailEntry {
  id: number;
  actor: string;
  event: string;
  payload: any;
  prev_hash: string;
  hash: string;
  created_at: string;
}
interface Dispute { id: number; purchase_id: number; claim: string; status: string; verdict: string | null; verdict_detail: string | null; }

@Component({
  selector: 'page-auditor',
  imports: [DatePipe, JsonPipe],
  template: `
    <div class="page">
      <h1>🔍 Vista del auditor</h1>
      <p class="sub">
        Cada decisión de compra deja una entrada encadenada por hash: humano, agente, merchant y wallet escriben
        en el mismo trail, y cualquier manipulación rompe la cadena.
      </p>

      <div class="card">
        <div class="row spread">
          <h2>Integridad de la cadena</h2>
          @if (integrity(); as i) {
            <span class="badge {{ i.ok ? 'ok' : 'err' }}">
              {{ i.ok ? '✓ íntegra (' + i.entries + ' entradas)' : '✗ rota en #' + i.broken_at }}
            </span>
          }
        </div>
      </div>

      @if (disputes().length) {
        <div class="card mt">
          <h2>⚖️ Disputas</h2>
          @for (d of disputes(); track d.id) {
            <div class="item">
              <div class="row spread">
                <div>
                  <span class="badge {{ d.status }}">{{ d.status }}</span>
                  <strong> Compra #{{ d.purchase_id }}</strong> — “{{ d.claim }}”
                </div>
                @if (d.status === 'open') {
                  <button (click)="resolve(d.id)" [disabled]="resolving()">Resolver con el trail</button>
                }
              </div>
              @if (d.verdict) {
                <div class="mt">
                  <span class="badge info">responsable: {{ d.verdict }}</span>
                  <div class="muted mt">{{ d.verdict_detail }}</div>
                </div>
              }
            </div>
          }
        </div>
      }

      <div class="card mt">
        <h2>Trail auditable</h2>
        <div class="log" style="max-height: 560px">
          @for (t of trail(); track t.id) {
            <div class="item">
              <div class="row spread">
                <div>
                  <span class="badge {{ actorClass(t.actor) }}">{{ t.actor }}</span>
                  <strong> {{ t.event }}</strong>
                </div>
                <span class="ts muted mono">#{{ t.id }} · {{ t.created_at | date: 'HH:mm:ss' }}</span>
              </div>
              <div class="muted mono mt">{{ t.payload | json }}</div>
              <div class="mono" style="color: #4a5568">⛓ {{ t.prev_hash.slice(0, 12) }} → {{ t.hash.slice(0, 12) }}</div>
            </div>
          }
        </div>
      </div>
    </div>
  `,
})
export class AuditorPage implements OnDestroy {
  private api = inject(Api);
  trail = signal<TrailEntry[]>([]);
  integrity = signal<any>(null);
  disputes = signal<Dispute[]>([]);
  resolving = signal(false);

  private stop = poll(() => this.refresh());

  refresh() {
    this.api.get<TrailEntry[]>('/audit/trail').then((t) => this.trail.set(t));
    this.api.get('/audit/trail/verify').then((i) => this.integrity.set(i));
    this.api.get<Dispute[]>('/disputes').then((d) => this.disputes.set(d));
  }

  actorClass(actor: string) {
    return { human: 'info', agent: 'ok', 'rogue-agent': 'err', merchant: 'warn', wallet: 'info', auditor: 'info' }[actor] || 'info';
  }

  async resolve(id: number) {
    this.resolving.set(true);
    try {
      await this.api.post(`/disputes/${id}/resolve`);
      this.refresh();
    } finally {
      this.resolving.set(false);
    }
  }

  ngOnDestroy() {
    this.stop();
  }
}
