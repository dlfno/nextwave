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
export interface Offer {
  id: string; merchantId: string; merchantProductId: string; productName: string; description?: string;
  category: string; unitPriceMinor: string; currency: string; availability: string; sourceType: string;
  observedAt: string; confidence: number; supportsAuthoritativeCheckout: boolean; rank: number; authoritative: false;
  rawPayload?: { departureTime?: string; attributes?: Record<string, unknown> };
}
export interface CheckoutAttempt {
  attempt: { id: string; status: string; mandateId: string; mandateVersionId: string; selectedOfferId: string; reasonCode?: string | null };
  quote: { id: string; totalMinor: string; currency: string; observedAt: string; expiresAt: string };
  checkout: { id: string; merchantId: string; totalMinor: string; currency: string; expiresAt: string; checkoutHash: string; lineItems: { productName: string; quantity: number; totalMinor: string; currency: string }[] };
  verification: { signatureValid: boolean; expired: boolean; replayed: boolean; hashValid: boolean; valid: boolean };
  priceDriftMinor: string;
}
export interface MandateDecision {
  decision: 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN_APPROVAL'; reasonCode: string; mandateVersion: number;
  checkoutHash: string; evaluatedAt: string; checks: { name: string; passed: boolean; reasonCode?: string }[];
}
export interface PurchaseResult {
  transaction: { id: string; status: string; amountMinor: string; currency: string };
  order: { id: string; merchantOrderId: string; status: string; totalMinor: string; currency: string; items: { productName: string; quantity: number }[] };
  receipt: { id: string; payloadHash: string; issuedAt: string };
  credential: { provider: string; merchantId: string; maxAmountMinor: string; currency: string; status: string; expiresAt: string };
}

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
  startDiscovery(intentId: string): Observable<{ run: { id: string; status: string }; offers: Offer[] }> {
    return this.request('post', `/purchase-intents/${intentId}/discovery-runs`, {});
  }
  selectOffer(intentId: string, offerId: string): Observable<CheckoutAttempt> {
    return this.request('post', `/purchase-intents/${intentId}/select-offer`, { offerId });
  }
  evaluateAttempt(attemptId: string): Observable<{ decision: MandateDecision }> {
    return this.request('post', `/purchase-attempts/${attemptId}/evaluate`, {});
  }
  decideApproval(attemptId: string, decision: 'APPROVED' | 'DENIED'): Observable<{ decision: MandateDecision }> {
    return this.request('post', `/purchase-attempts/${attemptId}/approval`, { decision });
  }
  executePurchase(attemptId: string): Observable<PurchaseResult> {
    return this.request('post', `/purchase-attempts/${attemptId}/execute`, {});
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
