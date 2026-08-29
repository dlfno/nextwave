import { Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
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
interface ChatMsg { role: 'user' | 'assistant'; content: string; }
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
          <div class="row spread">
            <h2>Autoriza a tu agente</h2>
            @if (parseSource()) {
              <span class="badge info">{{ parseSource() === 'llm' ? 'interpretado por LLM' : 'fallback determinista' }}</span>
            }
          </div>

          <div class="chat" #scroller>
            @for (m of messages(); track $index) {
              <div class="bubble {{ m.role }}">{{ m.content }}</div>
            }
            @if (sending()) { <div class="bubble assistant typing">escribiendo…</div> }
          </div>

          <div class="chat-input mt">
            <textarea
              rows="2"
              #chatBox
              [ngModel]="input()"
              (ngModelChange)="input.set($event)"
              [disabled]="sending()"
              (keydown.enter)="onEnter($event)"
              placeholder="Cómprame un vuelo a Córdoba si baja de $150, válido hasta fin de mes…"
            ></textarea>
            <button (click)="send()" [disabled]="sending() || !input().trim()">Enviar</button>
          </div>
          <p class="muted mt">Nada se firma hasta que lo confirmes: el Wallet te mostrará el mandato completo antes.</p>

          @if (justSigned(); as m) {
            <div class="item mt">
              <div class="row spread">
                <strong>✅ Mandato #{{ m.id }} firmado</strong>
                <span class="badge active">activo</span>
              </div>
              <div class="muted mt">Firma Ed25519 del Wallet · ligado a {{ context()?.agent?.name }}</div>
              <div class="mono">{{ m.wallet_signature.slice(0, 32) }}…</div>
            </div>
          }
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

      @if (showConfirm()) {
        <div class="modal-overlay" (click)="keepEditing()">
          <div class="modal" (click)="$event.stopPropagation()">
            <div class="row spread">
              <h2>Confirma tu Intent Mandate</h2>
              <button class="ghost" (click)="keepEditing()">✕</button>
            </div>

            <p class="summary">{{ summary() }}</p>

            <div class="grid two mt">
              <div><label>Destino</label><input [(ngModel)]="draft.destination" /></div>
              <div><label>Categoría</label><input [(ngModel)]="draft.category" /></div>
              <div><label>Comprar si baja de ($)</label><input type="number" [(ngModel)]="draft.price_below" /></div>
              <div><label>Máximo por compra ($)</label><input type="number" [(ngModel)]="draft.max_amount" /></div>
              <div><label>Presupuesto total ($)</label><input type="number" [(ngModel)]="draft.total_budget" /></div>
              <div><label>Máx. compras por mes</label><input type="number" [(ngModel)]="draft.max_uses_per_month" /></div>
              <div><label>Válido hasta</label><input type="date" [(ngModel)]="draft.valid_until" /></div>
            </div>

            <p class="muted mt">
              🔒 El Wallet lo firma con Ed25519 y lo liga a la llave de {{ context()?.agent?.name }}.
              Tu tarjeta ({{ context()?.payment_method?.brand }} ···· {{ context()?.payment_method?.last4 }}) nunca sale de aquí.
            </p>

            <div class="row mt spread">
              <button class="ghost" (click)="keepEditing()">Seguir ajustando</button>
              <button class="ok" (click)="createMandate()" [disabled]="!canSign() || signing()">
                {{ signing() ? 'Firmando…' : '✍️ Firmar mandato' }}
              </button>
            </div>
          </div>
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
  parseSource = signal<string | null>(null);

  // Chat de autorización: stateless en el back, el historial vive aquí
  messages = signal<ChatMsg[]>([
    { role: 'assistant', content: 'Hola Marta. Cuéntame qué quieres que tu agente pueda comprar por ti, en tus palabras.' },
  ]);
  input = signal('');
  sending = signal(false);
  signing = signal(false);
  showConfirm = signal(false);
  justSigned = signal<any | null>(null);

  @ViewChild('scroller') scroller?: ElementRef<HTMLDivElement>;
  @ViewChild('chatBox') chatBox?: ElementRef<HTMLTextAreaElement>;

  labels: Record<string, string> = { approved: 'comprado', rejected: 'rechazado', pending_approval: 'esperándote', denied: 'denegado' };

  // El draft solo se edita dentro del modal, nunca lo toca el polling
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

  onEnter(e: Event) {
    const ev = e as KeyboardEvent;
    if (ev.shiftKey) return; // Shift+Enter = salto de línea
    ev.preventDefault();
    this.send();
  }

  async send() {
    const text = this.input().trim();
    if (!text || this.sending()) return;
    this.input.set('');
    this.push('user', text);
    this.sending.set(true);
    try {
      const r = await this.api.post<any>('/wallet/mandate-chat', { messages: this.messages() });
      this.parseSource.set(r.source);
      this.push('assistant', r.reply);
      // El back decide si el mandato está completo; el modal nunca se abre a medias
      if (r.ready && r.mandate) {
        this.draft = { category: 'flights', ...r.mandate };
        this.showConfirm.set(true);
      }
    } catch {
      this.push('assistant', 'No pude contactar al Wallet. Revisa que el backend esté corriendo e inténtalo otra vez.');
    } finally {
      this.sending.set(false);
    }
  }

  private push(role: 'user' | 'assistant', content: string) {
    this.messages.update((ms) => [...ms, { role, content }]);
    setTimeout(() => {
      const el = this.scroller?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  // Resumen construido de forma determinista desde el draft: lo que Marta lee es
  // exactamente lo que se va a firmar, no una frase del LLM que podría contradecirlo.
  summary() {
    const d = this.draft;
    const veces = d.max_uses_per_month ? `${d.max_uses_per_month} ${d.max_uses_per_month == 1 ? 'compra' : 'compras'} al mes` : 'compras';
    const destino = d.destination ? ` a ${d.destination}` : '';
    const umbral = d.price_below ? ` solo si el precio baja de $${d.price_below}` : '';
    const fecha = d.valid_until ? new Date(d.valid_until + 'T23:59:59').toLocaleDateString('es-ES') : '—';
    return `Tu agente podrá hacer ${veces}${destino} de categoría "${d.category}"${umbral}, con un máximo de $${d.max_amount ?? '—'} por compra y $${d.total_budget ?? d.max_amount ?? '—'} de presupuesto total, hasta el ${fecha}.`;
  }

  canSign() {
    return !!this.draft.max_amount && !!this.draft.valid_until;
  }

  keepEditing() {
    this.showConfirm.set(false);
    setTimeout(() => this.chatBox?.nativeElement.focus());
  }

  async createMandate() {
    if (!this.canSign() || this.signing()) return;
    this.signing.set(true);
    try {
      const ultimo = [...this.messages()].reverse().find((m) => m.role === 'user');
      const row = await this.api.post<any>('/wallet/mandates', { ...this.draft, nl_text: ultimo?.content });
      this.justSigned.set(row);
      this.showConfirm.set(false);
      this.push('assistant', `Listo: mandato #${row.id} firmado y ligado a tu agente. Puedes revocarlo cuando quieras.`);
      this.refresh();
    } catch {
      this.push('assistant', 'No se pudo firmar el mandato. Revisa los datos e inténtalo otra vez.');
    } finally {
      this.signing.set(false);
    }
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
