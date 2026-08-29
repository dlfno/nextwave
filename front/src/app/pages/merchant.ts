import { Component, OnDestroy, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Api, Check, poll, setIfChanged } from '../services/api';

interface Flight { id: number; origin: string; destination: string; airline: string; price: number; departs_at: string; }
interface Verification {
  id: number;
  status: string;
  description: string;
  amount: number;
  reason: string;
  created_at: string;
  checks: Check[];
}

@Component({
  selector: 'page-merchant',
  imports: [DatePipe],
  template: `
    <div class="page">
      <h1>✈️ VuelaYa — merchant</h1>
      <p class="sub">
        Acepta compras de agentes sin abrir la puerta al fraude: cada intento se verifica contra un mandato firmado.
        Cambia un precio y mira al agente reaccionar solo.
      </p>

      <div class="grid two">
        <div class="card">
          <h2>Catálogo de vuelos (precio editable en vivo)</h2>
          <table>
            <thead><tr><th>Ruta</th><th>Aerolínea</th><th>Precio</th><th></th></tr></thead>
            <tbody>
              @for (f of flights(); track f.id) {
                <tr>
                  <td>{{ f.origin }} → <strong>{{ f.destination }}</strong></td>
                  <td class="muted">{{ f.airline }}</td>
                  <td><input type="number" style="width: 85px" #pr [value]="f.price" /></td>
                  <td><button class="ghost" (click)="setPrice(f.id, pr.value)">💲 Cambiar</button></td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        <div class="card">
          <h2>Verificaciones de compras agénticas</h2>
          <div class="log">
            @for (v of verifications(); track v.id) {
              <div class="item">
                <div class="row spread">
                  <div>
                    <span class="badge {{ v.status }}">{{ v.status }}</span>
                    <strong> {{ v.description }}</strong> — \${{ v.amount }}
                  </div>
                  <button class="ghost" (click)="toggle(v.id)">{{ open() === v.id ? 'ocultar' : 'checks' }}</button>
                </div>
                <div class="muted mt">{{ v.reason }} · {{ v.created_at | date: 'HH:mm:ss' }}</div>
                @if (open() === v.id) {
                  <ul class="checks">
                    @for (c of v.checks; track c.name) {
                      <li [class]="c.ok ? 'ok' : 'fail'">{{ c.name }} — {{ c.detail }}</li>
                    }
                  </ul>
                }
              </div>
            } @empty {
              <p class="muted">Sin intentos de compra todavía.</p>
            }
          </div>
        </div>
      </div>
    </div>
  `,
})
export class MerchantPage implements OnDestroy {
  private api = inject(Api);
  flights = signal<Flight[]>([]);
  verifications = signal<Verification[]>([]);
  open = signal<number | null>(null);

  private stop = poll(() => this.refresh());

  refresh() {
    this.api.get<Flight[]>('/merchant/flights').then((f) => setIfChanged(this.flights, f));
    this.api.get<Verification[]>('/merchant/verifications').then((v) => setIfChanged(this.verifications, v));
  }

  toggle(id: number) {
    this.open.set(this.open() === id ? null : id);
  }

  async setPrice(id: number, value: string) {
    await this.api.patch(`/merchant/flights/${id}`, { price: Number(value) });
    this.refresh();
  }

  ngOnDestroy() {
    this.stop();
  }
}
