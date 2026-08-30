import { Component, OnDestroy, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Api, Check, poll, setIfChanged } from '../services/api';

interface Product {
  id: number;
  product_type: string;
  merchant: string;
  title: string;
  price: number;
  currency: string;
  attributes: Record<string, string | number>;
}
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
      <header class="section-head">
        <span class="eyebrow">02 / VuelaYa · comercio</span>
        <h1>Acepta agentes sin abrir la puerta al fraude</h1>
        <p class="sub">
          Cada intento de compra se verifica contra un mandato firmado.
          Cambia un precio y mira al agente reaccionar solo.
        </p>
      </header>

      <div class="grid two">
        <div class="card">
          <span class="eyebrow">Catálogo</span>
          <h2>Productos (precio editable en vivo)</h2>
          <table class="catalogo">
            <thead><tr><th>Producto</th><th>Atributos verificables</th><th>Precio</th><th></th></tr></thead>
            <tbody>
              @for (p of products(); track p.id) {
                <tr>
                  <td><strong>{{ p.title }}</strong><div class="muted">{{ p.product_type }}</div></td>
                  <td>
                    <div class="attr-chips">
                      @for (a of pares(p); track a[0]) { <span>{{ a[0] }}: {{ a[1] }}</span> }
                    </div>
                  </td>
                  <td><input type="number" #pr [value]="p.price" /></td>
                  <td><button class="ghost" (click)="setPrice(p.id, pr.value)">Cambiar</button></td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        <div class="card">
          <span class="eyebrow">Verificaciones</span>
          <h2>Compras agénticas</h2>
          <div class="log">
            @for (v of verifications(); track v.id) {
              <div class="item">
                <div class="row spread">
                  <div>
                    <span class="badge {{ v.status }}">{{ v.status }}</span>
                    <strong> {{ v.description }}</strong> · \${{ v.amount }}
                  </div>
                  <button class="ghost" (click)="toggle(v.id)">{{ open() === v.id ? 'ocultar' : 'checks' }}</button>
                </div>
                <div class="muted mt">{{ v.reason }} · {{ v.created_at | date: 'HH:mm:ss' }}</div>
                @if (open() === v.id) {
                  <ul class="checks">
                    @for (c of v.checks; track c.name) {
                      <li [class]="c.ok ? 'ok' : 'fail'">{{ c.name }} · {{ c.detail }}</li>
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
  products = signal<Product[]>([]);
  verifications = signal<Verification[]>([]);
  open = signal<number | null>(null);

  private stop = poll(() => this.refresh());

  refresh() {
    this.api.get<Product[]>('/merchant/products').then((p) => setIfChanged(this.products, p));
    this.api.get<Verification[]>('/merchant/verifications').then((v) => setIfChanged(this.verifications, v));
  }

  // Los atributos son justo lo que el mandato puede restringir; se enseñan tal cual para
  // que se vea contra qué se verifica cada compra.
  pares(p: Product) {
    return Object.entries(p.attributes);
  }

  toggle(id: number) {
    this.open.set(this.open() === id ? null : id);
  }

  async setPrice(id: number, value: string) {
    await this.api.patch(`/merchant/products/${id}`, { price: Number(value) });
    this.refresh();
  }

  ngOnDestroy() {
    this.stop();
  }
}
