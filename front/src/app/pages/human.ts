import { Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Api, Check, poll, setIfChanged } from '../services/api';

interface Constraint { attr: string; op: string; value: unknown; }
interface Variable extends Constraint { observado: { n: number; valores: (string | number)[] }; }
interface Mandate { id: number; status: string; product_type: string; max_amount: number; total_budget: number; spent: number; uses: number; max_uses_per_month: number | null; valid_until: string; evidence_hash: string | null; spec: Constraint[]; }
interface Purchase { id: number; status: string; description: string; amount: number; reason: string; created_at: string; checks: Check[]; }
interface Dispute { id: number; purchase_id: number; claim: string; status: string; verdict: string | null; verdict_detail: string | null; }
interface Ticket {
  id: number; status: string; request_text: string; product_type: string | null; error: string | null; mandate_id: number | null;
  draft: { product_type: string; query: string; max_amount: number | null; total_budget: number | null; max_uses_per_month: number | null; valid_until: string; currency: string; spec: Constraint[]; };
  chat: { role: 'user' | 'assistant'; content: string }[];
  feasibility: { verdict: string; text: string; source: string; matches: number; recommendations: { field: string; suggested?: number; text: string }[]; };
  variables: Variable[];
  disponibles: { attr: string; observado: { n: number; valores: (string | number)[] } }[];
  evidence: { hash: string | null; fetched_at: string | null; stats: { n: number; min?: number; max?: number; mediana?: number }; sources: { source: string; status: string; n: number; ms: number; error?: string }[]; relevancia: { terminos: string[]; encontrados: number; relevantes: number; descartados: { title: string; source: string; score: number }[] } | null; samples: { title: string; price: number; currency: string; merchant: string; url: string; source: string; attributes: Record<string, string | number> }[]; };
}

@Component({
  selector: 'page-human',
  imports: [FormsModule, DatePipe],
  template: `
    <div class="page page--assistant" [class.is-welcome]="welcome()">
      <section class="assistant">
        <div class="assistant-top"><span class="eyebrow">Asistente de PagoSeguro</span>@if (ticket(); as t) { <span class="badge info" aria-live="polite">{{ t.feasibility.source === 'llm' ? 'redactado por LLM' : 'veredicto determinista' }}</span> }</div>
        <div class="assistant-progress" [class.on]="sending() || researching()" aria-hidden="true"></div>
        @if (welcome()) {
          <div class="assistant-welcome">
            <h1>¿Qué te gustaría comprar hoy?</h1>
            <p class="sub">Pídelo en tus palabras. El asistente lo investiga de verdad en internet, te propone un mandato claro y tú decides qué firmar. Tu tarjeta ({{ context()?.payment_method?.brand }} ···· {{ context()?.payment_method?.last4 }}) nunca sale de aquí.</p>
          </div>
        }
        <div class="assistant-thread" #scroller [hidden]="welcome()">
          @for (m of messages(); track $index) {
            @if (m.role === 'user') { <div class="msg msg-user"><p>{{ m.content }}</p></div> }
            @else { <div class="msg msg-ai"><div class="msg-ai-head"><span class="ai-badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 5.3L19 9.2l-4.2 3.1L16 18l-4-3-4 3 1.2-5.7L5 9.2l5.1-1.9z" /></svg></span><span class="eyebrow">Asistente</span></div><p class="msg-ai-body">{{ m.content }}</p></div> }
          }
          @if (sending() || researching()) { <div class="msg msg-ai"><div class="msg-ai-head"><span class="ai-badge is-thinking" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 5.3L19 9.2l-4.2 3.1L16 18l-4-3-4 3 1.2-5.7L5 9.2l5.1-1.9z" /></svg></span><span class="eyebrow">Asistente</span></div><div class="thinking"><span class="typing-dots"><i></i><i></i><i></i></span>@if (researching()) { <span class="muted"> buscando el producto en internet…</span> }</div></div> }
          @if (justSigned(); as m) { <div class="msg signed-flash"><div class="row spread"><strong>Mandato #{{ m.id }} firmado</strong><span class="badge active">activo</span></div><div class="muted mt">Tu agente ya puede vigilar esta compra. Tú puedes revocarlo cuando quieras.</div></div> }
        </div>
        <div class="assistant-dock"><div class="dock-chips">@for (c of chips; track c) { <button type="button" (click)="useChip(c)" [disabled]="sending()">{{ c }}</button> }</div><div class="dock-pill"><textarea rows="1" #chatBox [ngModel]="input()" (ngModelChange)="input.set($event)" (input)="grow($event)" [disabled]="sending()" (keydown.enter)="onEnter($event)" placeholder="¿Qué quieres que tu agente pueda comprar?"></textarea><button class="send" (click)="send()" [disabled]="sending() || !input().trim()" aria-label="Enviar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6" /></svg></button></div><p class="dock-note">El asistente puede equivocarse. Nada se firma sin tu confirmación.</p></div>
      </section>

      <div class="grid two mt">
        <div class="card"><span class="eyebrow">Mandatos</span><h2>Mis mandatos</h2>@for (m of mandates(); track m.id) { <div class="item"><div class="row spread"><div><strong>#{{ m.id }} · {{ m.product_type }}</strong><span class="badge {{ m.status }}">{{ m.status }}</span></div>@if (m.status === 'active') { <button class="danger" (click)="revoke(m.id)">Revocar</button> }</div><div class="muted mt">@for (c of m.spec; track $index) { {{ c.attr }} {{ simbolo[c.op] || c.op }} {{ c.value }} · } máx. &#36;{{ m.max_amount }}/compra · presupuesto &#36;{{ m.total_budget }} (gastado &#36;{{ m.spent }}) · hasta {{ m.valid_until | date: 'dd/MM/yyyy' }}</div>@if (m.evidence_hash) { <div class="muted mono">evidencia {{ m.evidence_hash.slice(0, 16) }}…</div> }<div class="usage-bar"><span [style.width.%]="pct(m)"></span></div></div> } @empty { <p class="muted">Aún no hay mandatos.</p> }</div>
        <div class="card"><span class="eyebrow">Historial</span><h2>Mi registro de compras</h2>@for (p of purchases(); track p.id) { <div class="item"><div class="row spread"><div><span class="badge {{ p.status }}">{{ labels[p.status] || p.status }}</span><strong> {{ p.description }}</strong> · &#36;{{ p.amount }}</div>@if (p.status === 'approved' && !disputeFor(p.id)) { <button class="ghost" (click)="dispute(p.id)">Disputar</button> }</div><div class="muted mt">{{ p.reason }} · {{ p.created_at | date: 'dd/MM HH:mm:ss' }}</div></div> } @empty { <p class="muted">Sin compras todavía. El agente está vigilando precios…</p> }</div>
      </div>

      @if (approvals().length) { <div class="card mt" style="border-color: var(--warn)" aria-live="polite"><span class="eyebrow">Aprobaciones</span><h2>Tu agente necesita tu aprobación</h2>@for (a of approvals(); track a.id) { <div class="item row spread"><div><strong>{{ a.description }}</strong> · &#36;{{ a.amount }}<div class="muted">{{ a.reason }}</div></div><div class="row"><button class="ok" (click)="decide(a.id, 'approve')">Aprobar</button><button class="danger" (click)="decide(a.id, 'deny')">Denegar</button></div></div> }</div> }

      @if (ticket(); as t) {
        @if (t.status !== 'signed' && t.status !== 'discarded') {
          <div class="modal-overlay" (click)="keepEditing()"><div class="modal modal--ticket" (click)="$event.stopPropagation()">
            <div class="row spread"><div><span class="eyebrow">Borrador de mandato · #{{ t.id }}</span><h2>Esto es lo que tu agente podrá hacer</h2></div><button class="ghost ticket-close" (click)="keepEditing()">Seguir conversando</button></div>
            @if (t.status === 'failed') { <p class="summary">No pude investigar este producto: {{ t.error }}</p><div class="row mt spread"><button class="ghost" (click)="discard(t.id)">Descartar</button><button (click)="reinvestigar(t.id)">Reintentar investigación</button></div> }
            @else {
              <div class="ticket-intent"><span class="ticket-intent__label">Tu encargo</span><p>{{ t.request_text }}</p></div>
              <div class="ticket-promises"><div class="ticket-promise"><span>Puede comprar</span><strong>{{ t.draft.product_type === 'flights' ? 'Vuelos' : t.draft.product_type === 'groceries' ? 'Productos de supermercado' : 'El producto solicitado' }}</strong></div><div class="ticket-promise"><span>Hasta</span><strong>{{ t.draft.currency }} &#36;{{ t.draft.max_amount || '—' }} por compra</strong></div><div class="ticket-promise"><span>Presupuesto total</span><strong>{{ t.draft.currency }} &#36;{{ t.draft.total_budget || t.draft.max_amount || '—' }}</strong></div><div class="ticket-promise"><span>Vigente hasta</span><strong>{{ t.draft.valid_until | date: 'dd/MM/yyyy' }}</strong></div></div>
              <div class="verdict" [class.warn]="t.feasibility.verdict !== 'ok'"><div class="row spread"><strong>{{ t.feasibility.verdict === 'ok' ? 'Encontré opciones que cumplen tu encargo' : 'Quiero que revises un detalle antes de firmar' }}</strong><span class="badge info">{{ t.feasibility.matches }}/{{ t.evidence.stats.n }} opciones</span></div><p class="mt">{{ t.feasibility.text }}</p>@for (r of t.feasibility.recommendations; track $index) { <div class="rec"><span>{{ r.text }}</span>@if (r.suggested) { <button class="ghost" (click)="aplicarSugerencia(t.id, r)">Usar &#36;{{ r.suggested }}</button> }</div> }</div>
              <div class="ticket-section-head"><div><span class="eyebrow">Condiciones del encargo</span><h3>Tu agente solo seguirá estas reglas</h3></div><span class="ticket-section-note">Puedes editar cada una</span></div>
              <table class="vars"><thead><tr><th>Quiero que</th><th>Sea</th><th>Valor</th><th>Visto en opciones</th><th></th></tr></thead><tbody>@for (v of t.variables; track $index) { <tr><td><strong>{{ v.attr }}</strong></td><td><select (change)="cambiarOp(t, $index, $any($event.target).value)">@for (o of operadores; track o.op) { <option [value]="o.op" [selected]="o.op === v.op">{{ o.texto }}</option> }</select></td><td><input [value]="v.value" (change)="cambiarValor(t, $index, $any($event.target).value)" /></td><td class="muted">@if (v.observado.n) { {{ v.observado.valores.join(', ') }} } @else { <em>nadie lo declara</em> }</td><td><button class="ghost" (click)="quitarVariable(t, $index)" aria-label="Quitar condición">×</button></td></tr> } @empty { <tr><td colspan="5" class="muted">No añadiste condiciones específicas; el límite de importe sigue aplicando.</td></tr> }</tbody></table>
              @if (t.disponibles.length) { <p class="muted mt">También puedes limitar:</p><div class="dock-chips">@for (d of t.disponibles.slice(0, 8); track d.attr) { <button type="button" (click)="anadirVariable(t, d.attr, d.observado.valores[0])">+ {{ d.attr }}</button> }</div> }
              <div class="ticket-section-head limits-head"><div><span class="eyebrow">Límites que tú controlas</span><h3>Dinero y vigencia</h3></div></div><div class="ticket-limits"><label>Máximo por compra <span>{{ t.draft.currency }}</span><input type="number" [value]="t.draft.max_amount" (change)="cambiarCampo(t, 'max_amount', $any($event.target).value)" /></label><label>Presupuesto total <span>{{ t.draft.currency }}</span><input type="number" [value]="t.draft.total_budget" (change)="cambiarCampo(t, 'total_budget', $any($event.target).value)" /></label><label>Compras al mes<input type="number" [value]="t.draft.max_uses_per_month" (change)="cambiarCampo(t, 'max_uses_per_month', $any($event.target).value)" /></label><label>Válido hasta<input type="date" [value]="t.draft.valid_until" (change)="cambiarCampo(t, 'valid_until', $any($event.target).value)" /></label></div>
              <details class="mt"><summary>Ver la investigación y las comprobaciones · {{ t.evidence.stats.n }} ofertas</summary><div class="muted mono">snapshot {{ t.evidence.hash?.slice(0, 24) }}… · {{ t.evidence.fetched_at | date: 'dd/MM HH:mm:ss' }}</div><ul class="checks">@for (s of t.evidence.sources; track s.source) { <li [class]="s.status === 'ok' ? 'ok' : 'fail'">{{ s.source }} · {{ s.status }} · {{ s.n }} ofertas</li> }</ul></details>
              <div class="ticket-safety"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 2.9 8.6 7 10 4.1-1.4 7-5.5 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></svg><p>Tu tarjeta no se comparte. PagoSeguro firma este mandato y VuelaYa lo comprobará antes de cada compra.</p></div>
              <div class="row mt spread"><button class="ghost" (click)="keepEditing()">Quiero ajustar algo</button><div class="row"><button class="ghost" (click)="discard(t.id)">Descartar</button><button class="ok" (click)="firmar(t)" [disabled]="!canSign(t) || signing()">{{ signing() ? 'Activando tu agente…' : 'Firmar y activar agente' }}</button></div></div>
            }
          </div></div>
        }
      }
    </div>
  `,
})
export class HumanPage implements OnDestroy {
  private api = inject(Api);
  context = signal<any>(null); mandates = signal<Mandate[]>([]); purchases = signal<Purchase[]>([]); approvals = signal<Purchase[]>([]); disputes = signal<Dispute[]>([]);
  ticket = signal<Ticket | null>(null); ticketId = signal<number | null>(null); cerrado = signal(false);
  messages = signal<{ role: 'user' | 'assistant'; content: string }[]>([{ role: 'assistant', content: 'Hola Marta. Dime qué quieres que tu agente pueda comprar y lo investigo antes de que firmes nada.' }]);
  input = signal(''); sending = signal(false); signing = signal(false); justSigned = signal<any | null>(null);
  @ViewChild('scroller') scroller?: ElementRef<HTMLDivElement>;
  @ViewChild('chatBox') chatBox?: ElementRef<HTMLTextAreaElement>;
  labels: Record<string, string> = { approved: 'comprado', rejected: 'rechazado', pending_approval: 'esperándote', denied: 'denegado' };
  simbolo: Record<string, string> = { eq: '=', neq: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥', in: '∈', contains: '⊃', between: '∈' };
  operadores = [{ op: 'eq', texto: 'es igual a' }, { op: 'neq', texto: 'no es' }, { op: 'lt', texto: 'menor que' }, { op: 'lte', texto: 'menor o igual a' }, { op: 'gt', texto: 'mayor que' }, { op: 'gte', texto: 'mayor o igual a' }, { op: 'contains', texto: 'contiene' }];
  chips = ['Café molido, marca Carrefour, < $6', 'Vuelo a Córdoba si baja de $200', 'Máx. una compra al mes'];
  private stop = poll(() => this.refresh());
  researching() { return this.ticket()?.status === 'researching'; }
  welcome() { return this.messages().length <= 1 && !this.ticket() && !this.sending() && !this.justSigned(); }
  refresh() { this.api.get('/wallet/context').then((c) => setIfChanged(this.context, c)); this.api.get<Mandate[]>('/wallet/mandates').then((m) => setIfChanged(this.mandates, m)); this.api.get<Purchase[]>('/wallet/purchases').then((p) => setIfChanged(this.purchases, p)); this.api.get<Purchase[]>('/wallet/approvals').then((a) => setIfChanged(this.approvals, a)); this.api.get<Dispute[]>('/disputes').then((d) => setIfChanged(this.disputes, d)); const id = this.ticketId(); if (id && (this.researching() || !this.cerrado())) this.api.get<Ticket>(`/wallet/tickets/${id}`).then((t) => this.recibir(t)); }
  private recibir(t: Ticket) { const before = this.ticket()?.status; setIfChanged(this.ticket, t); if (before === 'researching' && t.status !== 'researching') this.avisarInvestigacion(t); }
  private avisarInvestigacion(t: Ticket) { if (t.status === 'failed') return this.push('assistant', `No pude investigar el producto: ${t.error}`); const s = t.evidence.stats; this.push('assistant', `Investigué el producto y encontré ${s.n} ofertas reales${s.n ? ` (de $${s.min} a $${s.max}). ` : '. '}${t.feasibility.text}`); }
  disputeFor(purchaseId: number) { return this.disputes().find((d) => d.purchase_id === purchaseId); }
  pct(m: Mandate) { const total = m.total_budget || m.max_amount || 0; return total ? Math.max(0, Math.min(100, Math.round((m.spent / total) * 100))) : 0; }
  onEnter(e: Event) { const ev = e as KeyboardEvent; if (ev.shiftKey) return; ev.preventDefault(); this.send(); }
  useChip(c: string) { this.input.set(c); setTimeout(() => { const el = this.chatBox?.nativeElement; if (el) { el.focus(); this.grow({ target: el } as unknown as Event); } }); }
  grow(e: Event) { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 160)}px`; }
  async send() { const text = this.input().trim(); if (!text || this.sending()) return; this.input.set(''); if (this.chatBox) this.chatBox.nativeElement.style.height = 'auto'; this.push('user', text); this.sending.set(true); try { const open = this.ticket(); if (open && !['signed', 'discarded', 'failed'].includes(open.status)) { const t = await this.api.post<Ticket>(`/wallet/tickets/${open.id}/chat`, { message: text }); this.ticket.set(t); this.cerrado.set(false); this.push('assistant', t.chat[t.chat.length - 1]?.content || 'Actualicé tu propuesta.'); } else { const t = await this.api.post<Ticket>('/wallet/tickets', { text }); this.ticket.set(t); this.ticketId.set(t.id); this.cerrado.set(false); this.push('assistant', 'Déjame investigarlo: buscaré opciones reales antes de proponerte nada.'); } } catch { this.push('assistant', 'No pude contactar al Wallet. Revisa que el backend esté corriendo e inténtalo otra vez.'); } finally { this.sending.set(false); } }
  private push(role: 'user' | 'assistant', content: string) { this.messages.update((ms) => [...ms, { role, content }]); setTimeout(() => { const el = this.scroller?.nativeElement; if (el) el.scrollTop = el.scrollHeight; }); }
  private async enviarSpec(t: Ticket, spec: Constraint[]) { this.ticket.set(await this.api.patch<Ticket>(`/wallet/tickets/${t.id}`, { spec })); }
  cambiarOp(t: Ticket, i: number, op: string) { this.enviarSpec(t, t.variables.map((v, j) => ({ attr: v.attr, op: j === i ? op : v.op, value: v.value }))); }
  cambiarValor(t: Ticket, i: number, value: string) { this.enviarSpec(t, t.variables.map((v, j) => ({ attr: v.attr, op: v.op, value: j === i ? value : v.value }))); }
  quitarVariable(t: Ticket, i: number) { this.enviarSpec(t, t.variables.filter((_, j) => j !== i).map((v) => ({ attr: v.attr, op: v.op, value: v.value }))); }
  anadirVariable(t: Ticket, attr: string, valor: string | number) { this.enviarSpec(t, [...t.variables.map((v) => ({ attr: v.attr, op: v.op, value: v.value })), { attr, op: 'eq', value: valor ?? '' }]); }
  async cambiarCampo(t: Ticket, campo: string, valor: unknown) { this.ticket.set(await this.api.patch<Ticket>(`/wallet/tickets/${t.id}`, { [campo]: valor })); }
  aplicarSugerencia(id: number, r: { field: string; suggested?: number }) { if (r.suggested) this.api.patch<Ticket>(`/wallet/tickets/${id}`, { [r.field]: r.suggested }).then((t) => this.ticket.set(t)); }
  async reinvestigar(id: number) { this.ticket.update((t) => (t ? { ...t, status: 'researching' } : t)); this.ticket.set(await this.api.post<Ticket>(`/wallet/tickets/${id}/research`)); }
  async discard(id: number) { await this.api.post(`/wallet/tickets/${id}/discard`); this.ticket.set(null); this.ticketId.set(null); }
  canSign(t: Ticket) { return !!t.draft.max_amount && !!t.draft.valid_until && t.status !== 'researching'; }
  keepEditing() { this.cerrado.set(true); setTimeout(() => this.chatBox?.nativeElement.focus()); }
  async firmar(t: Ticket) { if (!this.canSign(t) || this.signing()) return; this.signing.set(true); try { const r = await this.api.post<any>(`/wallet/tickets/${t.id}/sign`); this.justSigned.set(r.mandate); this.ticket.set(null); this.ticketId.set(null); this.push('assistant', `Listo: mandato #${r.mandate.id} firmado y ligado a tu agente.`); this.refresh(); } catch (e: any) { this.push('assistant', `No se pudo firmar el mandato: ${e?.error?.error || 'revisa los datos e inténtalo otra vez'}.`); } finally { this.signing.set(false); } }
  async revoke(id: number) { await this.api.post(`/wallet/mandates/${id}/revoke`); this.refresh(); }
  async decide(purchaseId: number, decision: 'approve' | 'deny') { await this.api.post(`/wallet/approvals/${purchaseId}`, { decision }); this.refresh(); }
  async dispute(purchaseId: number) { await this.api.post('/disputes', { purchase_id: purchaseId, claim: 'Yo no autoricé esta compra' }); this.refresh(); }
  ngOnDestroy() { this.stop(); }
}
