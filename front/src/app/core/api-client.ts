import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, catchError, throwError } from 'rxjs';

export interface User { id: string; email: string; displayName: string; role: string; }
export interface Agent { id: string; name: string; status: string; }
export interface IntentMessage { id?: string; role: 'USER' | 'AGENT'; content: string; }
export interface PurchaseIntentResult { intent: { id: string; status: string }; messages: IntentMessage[]; }

@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly baseUrl = '/api/v1';
  constructor(private readonly http: HttpClient) {}

  login(email: string, password: string): Observable<{ user: User }> {
    return this.request<{ user: User }>('post', '/auth/login', { email, password });
  }

  register(displayName: string, email: string, password: string): Observable<{ user: User }> {
    return this.request<{ user: User }>('post', '/auth/register', { displayName, email, password });
  }

  listAgents(): Observable<{ agents: Agent[] }> {
    return this.request<{ agents: Agent[] }>('get', '/agents');
  }

  createAgent(name = 'Personal purchasing agent'): Observable<{ agent: Agent }> {
    return this.request<{ agent: Agent }>('post', '/agents', { name });
  }

  createIntent(agentId: string, originalRequest: string): Observable<PurchaseIntentResult> {
    return this.request<PurchaseIntentResult>('post', '/purchase-intents', { agentId, originalRequest });
  }

  addIntentMessage(intentId: string, content: string): Observable<{ status: string; ready: boolean; messages: IntentMessage[] }> {
    return this.request('post', `/purchase-intents/${intentId}/messages`, { content });
  }

  private request<T>(method: 'get' | 'post', path: string, body?: unknown): Observable<T> {
    const headers = method === 'post' ? new HttpHeaders({ 'x-csrf-token': this.cookie('nextwave_csrf') }) : undefined;
    const call = method === 'get'
      ? this.http.get<T>(`${this.baseUrl}${path}`, { credentials: 'include' })
      : this.http.post<T>(`${this.baseUrl}${path}`, body, { headers, credentials: 'include' });
    return call.pipe(catchError((error: HttpErrorResponse) => {
      const message = typeof error.error?.message === 'string' ? error.error.message : 'Something went wrong. Please try again.';
      return throwError(() => new Error(message));
    }));
  }

  private cookie(name: string): string {
    if (typeof document === 'undefined') return '';
    const prefix = `${name}=`;
    return document.cookie.split(';').map((value) => value.trim()).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? '';
  }
}
