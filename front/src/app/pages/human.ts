import { Component, OnDestroy, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { Api, Check, poll, setIfChanged } from '../services/api';

interface Mandate {
  id: number;
  status: string;
  category: string;
  max_amount: number;
  total_budget: number;
  spent: number;
  uses: number;
  valid_until: string;
  conditions: { destination?: string; price_below?: number; max_uses_per_month?: number };
}
interface Purchase {
  id: number;
  status: string;
  description: string;
  amount: number;
  reason: string;
  created_at: string;
  checks: Check[];
}
interface Dispute { id: number; purchase_id: number; claim: string; status: string; verdict: string | null; verdict_detail: string | null; }

@Component({
  selector: 'page-human',
  imports: [FormsModule, DatePipe],
  template: `
    <div class="page">
      <h1>👤 Vista de Marta — titular</h1>
      <p class="sub">
        Crea el mandato para tu agente sin entregar la tarjeta ({{ context()?.payment_method?.brand }} ···· {{ context()?.payment_method?.last4 }}),
        mira lo que compró y revócalo cuando quieras.
      </p>

      <div class="grid two">
        <div class="card">
          <h2>Nuevo Intent Mandate</h2>
          <label>Díselo en tus palabras</label>
          <textarea rows="2" [(ngModel)]="nlText" placeholder="Cómprame un vuelo a Córdoba si baja de $150, válido hasta fin de mes, máximo 1 vez"></textarea>
          <div class="row mt">
            <button (click)="interpret()" [disabled]="interpreting()">{{ interpreting() ? 'Interpretando…' : '🪄 Interpretar con IA' }}</button>
            @if (parseSource()) {
              <span class="badge info">{{ parseSource() === 'llm' ? 'interpretado por LLM' : 'fallback determinista' }}</span>
            }
          </div>

          <div class="grid two mt">
            <div><label>Destino</label><input [(ngModel)]="draft.destination" /></div>
            <div><label>Categoría</label><input [(ngModel)]="draft.category" /></div>
            <div><label>Comprar si baja de ($)</label><input type="number" [(ngModel)]="draft.price_below" /></div>
            <div><label>Máximo por compra ($)</label><input type="number" [(ngModel)]="draft.max_amount" /></div>
            <div><label>Presupuesto total ($)</label><input type="number" [(ngModel)]="draft.total_budget" /></div>
            <div><label>Máx. compras por mes</label><input type="number" [(ngModel)]="draft.max_uses_per_month" /></div>
            <div><label>Válido hasta</label><input type="date" [(ngModel)]="draft.valid_until" /></div>
          </div>
          <div class="row mt">
            <button class="ok" (click)="createMandate()">✍️ Confirmar y firmar mandato</button>
            <span class="muted">El Wallet lo firma con Ed25519 y liga la llave del agente.</span>
          </div>
        </div>

        <div class="card">
          <h2>Mis mandatos</h2>
          @for (m of mandates(); track m.id) {
            <div class="item">
              <div class="row spread">
                <div>
                  <strong>#{{ m.id }} · {{ m.conditions.destination || m.category }}</strong>
                  <span class="badge {{ m.status }}">{{ m.status }}</span>
                </div>
                @if (m.status === 'active') {
                  <button class="danger" (click)="revoke(m.id)">🛑 Revocar</button>
                }
              </div>
              <div class="muted mt">
                @if (m.conditions.price_below) { comprar si &lt; \${{ m.conditions.price_below }} · }
                máx. \${{ m.max_amount }}/compra · presupuesto \${{ m.total_budget }} (gastado \${{ m.spent }})
                @if (m.conditions.max_uses_per_month) { · {{ m.conditions.max_uses_per_month }}/mes }
                · hasta {{ m.valid_until | date: 'dd/MM/yyyy' }}
              </div>
              @if (m.status === 'active') {
                <div class="row mt">
                  <span class="muted">Cambiar límite por compra:</span>
                  <input type="number" style="width: 90px" #lim [value]="m.max_amount" />
                  <button class="ghost" (click)="changeLimit(m.id, lim.value)">Aplicar en vivo</button>
                </div>
              }
            </div>
          } @empty {
            <p class="muted">Aún no hay mandatos.</p>
          }
        </div>
      </div>

      @if (approvals().length) {
        <div class="card mt" style="border-color: var(--warn)">
          <h2>⚠️ Tu agente necesita tu aprobación</h2>
          @for (a of approvals(); track a.id) {
            <div class="item row spread">
              <div>
                <strong>{{ a.description }}</strong> — \${{ a.amount }}
                <div class="muted">{{ a.reason }}</div>
              </div>
              <div class="row">
                <button class="ok" (click)="decide(a.id, 'approve')">Aprobar</button>
                <button class="danger" (click)="decide(a.id, 'deny')">Denegar</button>
              </div>
            </div>
          }
        </div>
      }

      <div class="card mt">
        <h2>Mi registro de compras</h2>
        @for (p of purchases(); track p.id) {
          <div class="item">
            <div class="row spread">
              <div>
                <span class="badge {{ p.status }}">{{ labels[p.status] || p.status }}</span>
                <strong> {{ p.description }}</strong> — \${{ p.amount }}
              </div>
              @if (p.status === 'approved' && !disputeFor(p.id)) {
                <button class="ghost" (click)="dispute(p.id)">⚖️ Disputar</button>
              }
            </div>
            <div class="muted mt">{{ p.reason }} · {{ p.created_at | date: 'dd/MM HH:mm:ss' }}</div>
            @if (disputeFor(p.id); as d) {
              <div class="mt">
                <span class="badge {{ d.status }}">disputa {{ d.status }}</span>
                @if (d.verdict_detail) { <div class="muted mt">Veredicto ({{ d.verdict }}): {{ d.verdict_detail }}</div> }
              </div>
            }
          </div>
        } @empty {
          <p class="muted">Sin compras todavía. El agente está vigilando precios…</p>
        }
      </div>
    </div>
  `,
})
export class HumanPage implements OnDestroy {
  private api = inject(Api);

  context = signal<any>(null);
  mandates = signal<Mandate[]>([]);
  purchases = signal<Purchase[]>([]);
  approvals = signal<Purchase[]>([]);
  disputes = signal<Dispute[]>([]);
  interpreting = signal(false);
  parseSource = signal<string | null>(null);

  labels: Record<string, string> = { approved: 'comprado', rejected: 'rechazado', pending_approval: 'esperándote', denied: 'denegado' };

  nlText = 'Cómprame un vuelo a Córdoba si baja de $150, válido hasta fin de mes, máximo 1 vez';
  draft: any = { category: 'flights', destination: '', max_amount: null, total_budget: null, valid_until: '', price_below: null, max_uses_per_month: null };

  private stop = poll(() => this.refresh());

  refresh() {
    this.api.get('/wallet/context').then((c) => setIfChanged(this.context, c));
    this.api.get<Mandate[]>('/wallet/mandates').then((m) => setIfChanged(this.mandates, m));
    this.api.get<Purchase[]>('/wallet/purchases').then((p) => setIfChanged(this.purchases, p));
    this.api.get<Purchase[]>('/wallet/approvals').then((a) => setIfChanged(this.approvals, a));
    this.api.get<Dispute[]>('/disputes').then((d) => setIfChanged(this.disputes, d));
  }

  disputeFor(purchaseId: number) {
    return this.disputes().find((d) => d.purchase_id === purchaseId);
  }

  async interpret() {
    this.interpreting.set(true);
    try {
      const r = await this.api.post<any>('/wallet/parse-mandate', { text: this.nlText });
      this.parseSource.set(r.source);
      this.draft = { category: 'flights', ...r.mandate };
    } finally {
      this.interpreting.set(false);
    }
  }

  async createMandate() {
    if (!this.draft.max_amount || !this.draft.valid_until) {
      alert('Completa al menos el máximo por compra y la vigencia (o usa "Interpretar con IA").');
      return;
    }
    await this.api.post('/wallet/mandates', this.draft);
    this.refresh();
  }

  async revoke(id: number) {
    await this.api.post(`/wallet/mandates/${id}/revoke`);
    this.refresh();
  }

  async changeLimit(id: number, value: string) {
    await this.api.patch(`/wallet/mandates/${id}`, { max_amount: Number(value) });
    this.refresh();
  }

  async decide(purchaseId: number, decision: 'approve' | 'deny') {
    await this.api.post(`/wallet/approvals/${purchaseId}`, { decision });
    this.refresh();
  }

  async dispute(purchaseId: number) {
    await this.api.post('/disputes', { purchase_id: purchaseId, claim: 'Yo no autoricé esta compra' });
    this.refresh();
  }

  ngOnDestroy() {
    this.stop();
  }
}
