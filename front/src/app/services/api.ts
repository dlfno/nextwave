import { Injectable, WritableSignal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

@Injectable({ providedIn: 'root' })
export class Api {
  private http = inject(HttpClient);

  get<T>(url: string) {
    return firstValueFrom(this.http.get<T>('/api' + url));
  }
  post<T>(url: string, body: unknown = {}) {
    return firstValueFrom(this.http.post<T>('/api' + url, body));
  }
  patch<T>(url: string, body: unknown = {}) {
    return firstValueFrom(this.http.patch<T>('/api' + url, body));
  }
}

// Polling simple: refresca cada 2s mientras el componente vive
export function poll(fn: () => void, ms = 2000): () => void {
  fn();
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
}

// Solo actualiza la señal si los datos cambiaron: evita re-renderizar inputs
// que el usuario está editando (p.ej. el precio que un juez está cambiando)
export function setIfChanged<T>(sig: WritableSignal<T>, data: T) {
  if (JSON.stringify(sig()) !== JSON.stringify(data)) sig.set(data);
}
