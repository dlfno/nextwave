import { Component, OnDestroy, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Api, poll } from '../services/api';

interface Decision { ts: string; level: string; message: string; }
interface Product { id: number; title: string; price: number; product_type: string; }
interface AttackResult { attack: string; status: string; reason: string; }

@Component({
  selector: 'page-agent',
  imports: [DatePipe],
  template: `
    <div class="page">
      <header class="section-head">
        <span class="eyebrow">03 / Agente</span>
        <h1>El LLM propone, el mandato dispone</h1>
        <p class="sub">
          El agente de Marta vigila precios cada 3 segundos y decide solo, pero cada compra pasa por el mandato.
        </p>
      </header>

      <div class="grid two">
        <div class="card">
          <span class="eyebrow">Decisiones</span>
          <div class="row spread">
            <h2>Decisiones del agente</h2>
            <span class="badge {{ running() ? 'ok' : 'err' }}">{{ running() ? 'vigilando' : 'detenido' }}</span>
          </div>
          <div class="log">
            @for (d of decisions(); track d.ts + d.message) {
              <div class="entry">
                <span class="dot {{ d.level }}"></span>
                <span class="ts">{{ d.ts | date: 'HH:mm:ss' }}</span>
                {{ d.message }}
              </div>
            } @empty {
              <p class="muted">Sin actividad todavía.</p>
            }
          </div>
        </div>

        <div>
          <div class="card">
            <span class="eyebrow">Simulación</span>
            <h2>Simular error del agente</h2>
            <p class="muted">
              Fuerza al agente a intentar un producto fuera de su mandato (como si "alucinara" la compra).
              El sistema debe frenarlo o escalarlo, nunca aprobarlo en silencio.
            </p>
            <div class="row mt">
              <select #sel style="width: auto; flex: 1">
                @for (p of products(); track p.id) {
                  <option [value]="p.id">{{ p.title }} · \${{ p.price }}</option>
                }
              </select>
              <button (click)="force(sel.value)">Intentar comprar</button>
            </div>
            @if (forceResult()) {
              <div class="mt">
                <span class="badge {{ forceResult().status }}">{{ forceResult().status }}</span>
                <span class="muted"> {{ forceResult().reason }}</span>
              </div>
            }
          </div>

          <div class="card mt" style="border-color: var(--err)">
            <span class="eyebrow">Adversario</span>
            <h2>Agente adversarial</h2>
            <p class="muted">
              Lanza un agente hostil que intenta comprar fuera del mandato por caminos creativos:
              impersonación, tipo de producto disfrazado, compra dividida, montos gigantes, mandatos inventados.
            </p>
            <button class="danger mt" (click)="attack()" [disabled]="attacking()">
              {{ attacking() ? 'Atacando…' : 'Lanzar batería de ataques' }}
            </button>
            @if (attacks().length) {
              <div class="mt">
                @for (a of attacks(); track a.attack) {
                  <div class="item">
                    <span class="badge {{ a.status }}">{{ a.status }}</span>
                    <strong> {{ a.attack }}</strong>
                    <div class="muted">{{ a.reason }}</div>
                  </div>
                }
                <p class="mt"><strong>{{ blocked() }}/{{ attacks().length }}</strong> ataques frenados por la verificación del mandato.</p>
              </div>
            }
          </div>
        </div>
      </div>
    </div>
  `,
})
export class AgentPage implements OnDestroy {
  private api = inject(Api);
  decisions = signal<Decision[]>([]);
  running = signal(false);
  products = signal<Product[]>([]);
  attacks = signal<AttackResult[]>([]);
  attacking = signal(false);
  forceResult = signal<any>(null);

  private stop = poll(() => this.refresh());

  refresh() {
    this.api.get<any>('/agent/decisions').then((r) => {
      this.running.set(r.running);
      this.decisions.set(r.decisions);
    });
    this.api.get<Product[]>('/merchant/products').then((p) => this.products.set(p));
  }

  async force(productId: string) {
    this.forceResult.set(await this.api.post(`/agent/attempt/${productId}`));
    this.refresh();
  }

  async attack() {
    this.attacking.set(true);
    try {
      this.attacks.set(await this.api.post<AttackResult[]>('/agent/rogue/attack'));
    } finally {
      this.attacking.set(false);
    }
  }

  blocked() {
    return this.attacks().filter((a) => a.status !== 'approved').length;
  }

  ngOnDestroy() {
    this.stop();
  }
}
