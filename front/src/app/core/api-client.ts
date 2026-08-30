import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable, catchError, throwError } from 'rxjs';

export interface User { id: string; email: string; displayName: string; role: string; }
export interface Agent { id: string; name: string; status: string; }
export interface IntentMessage { id?: string; role: 'USER' | 'AGENT'; content: string; }
export interface PurchaseIntentResult { intent: { id: string; status: string }; messages: IntentMessage[]; }
export interface AuthorizationSpecification {
  productConstraints: { category: 'travel.flight'; originIata: string; destinationIata: string; quantity: number };
  spendConstraints: { maxTotalMinor: string; currency: string };
  merchantConstraints: { allowedMerchants: 'ANY' };
  validUntil: string;
  requiresFinalConfirmation: boolean;
}
export interface MandateSummary {
  id: string; intentId: string | null; agentId: string; status: string; mode: string;
  currentVersionId: string | null; expiresAt: string; createdAt: string;
}
export interface MandateVersion {
  id: string; version: number; status: string; maxTotalMinor: string; currency: string;
  validFrom: string; validUntil: string; requiresFinalConfirmation: boolean;
  canonicalPayload: AuthorizationSpecification; payloadHash: string | null; signatureVerified: boolean | null;
}
export interface MandateDetail { mandate: MandateSummary; versions: MandateVersion[]; revocations: { reason: string | null; revokedAt: string }[]; }

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

  finalizeIntent(intentId: string): Observable<{ authorizationSpecification: AuthorizationSpecification }> {
    return this.request('post', `/purchase-intents/${intentId}/finalize-specifications`, {});
  }

  createMandateDraft(intentId: string, mode: 'HUMAN_PRESENT' | 'AUTONOMOUS'): Observable<{ mandate: MandateSummary; version: MandateVersion }> {
    return this.request('post', `/purchase-intents/${intentId}/mandates/draft`, { mode });
  }

  listMandates(): Observable<{ mandates: MandateSummary[] }> { return this.request('get', '/mandates'); }
  getMandate(id: string): Observable<MandateDetail> { return this.request('get', `/mandates/${id}`); }
  authorizeMandate(id: string, version?: number): Observable<MandateDetail> {
    const suffix = version ? `/versions/${version}/authorize` : '/authorize';
    return this.request('post', `/mandates/${id}${suffix}`, {});
  }
  createMandateVersion(id: string, authorizationSpecification: AuthorizationSpecification): Observable<MandateDetail> {
    return this.request('post', `/mandates/${id}/versions`, { authorizationSpecification });
  }
  revokeMandate(id: string, reason?: string): Observable<MandateDetail> {
    return this.request('post', `/mandates/${id}/revoke`, reason ? { reason } : {});
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
