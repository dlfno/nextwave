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
export interface TransactionRecord { id: string; attemptId: string; provider: string; providerReference: string | null; status: string; amountMinor: string; currency: string; failureCode: string | null; createdAt: string; processedAt: string | null; merchantName?: string | null; productName?: string | null; mandateVersion?: number | null; }
export interface OrderRecord { id: string; merchantOrderId: string; status: string; totalMinor: string; currency: string; createdAt: string; items: { productName: string; quantity: number; totalMinor: string; currency: string }[]; }
export interface ReceiptRecord { id: string; orderId: string; transactionId: string; receiptType: string; payloadHash: string; rawPayload: Record<string, unknown>; issuedAt: string; }
export interface AuditEvent { id: string; eventType: string; occurredAt: string; actorType: string; actorId: string | null; intentId: string; mandateId: string | null; mandateVersionId: string | null; attemptId: string | null; transactionId: string | null; correlationId: string; payload: Record<string, unknown>; previousHash: string | null; eventHash: string; }
export interface AuditProjection { integrity: { valid: boolean; eventCount: number; failedEventId: string | null }; events: AuditEvent[]; }
export interface TransactionDetail { transaction: TransactionRecord; order: OrderRecord | null; receipt: ReceiptRecord | null; }
export interface DisputeRecord { id: string; transactionId: string; status: string; reasonCode: string; statement: string | null; openedAt: string; resolvedAt?: string | null; resolutionSummary?: string | null; }

@Injectable({ providedIn: 'root' })
export class ApiClient {
  private readonly baseUrl = '/api/v1';
  constructor(private readonly http: HttpClient) {}

  login(email: string, password: string): Observable<{ user: User }> {
    return this.request<{ user: User }>('post', '/auth/login', { email, password });
  }

  getMe(): Observable<{ user: User }> { return this.request('get', '/auth/me'); }

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

  getIntent(intentId: string): Observable<PurchaseIntentResult> {
    return this.request<PurchaseIntentResult>('get', `/purchase-intents/${intentId}`);
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
  listTransactions(): Observable<{ transactions: TransactionRecord[] }> { return this.request('get', '/transactions'); }
  getTransaction(id: string): Observable<TransactionDetail> { return this.request('get', `/transactions/${id}`); }
  getTransactionAudit(id: string): Observable<AuditProjection> { return this.request('get', `/transactions/${id}/audit`); }
  getMerchantVerification(attemptId: string): Observable<AuditProjection> { return this.request('get', `/merchant/verifications/${attemptId}`); }
  getAuditorEvidence(transactionId: string): Observable<AuditProjection & { facts: Record<string, unknown> }> { return this.request('get', `/auditor/transactions/${transactionId}/evidence`); }
  openDispute(transactionId: string, reasonCode: string, statement?: string): Observable<{ dispute: DisputeRecord; evidence: { bundle: Record<string, unknown>; bundleHash: string; verificationResult: { valid: boolean; eventCount: number } } }> {
    return this.request('post', `/transactions/${transactionId}/disputes`, { reasonCode, ...(statement ? { statement } : {}) });
  }
  getDispute(id: string): Observable<{ dispute: DisputeRecord; evidence: { bundle: Record<string, unknown>; bundleHash: string; verificationResult: { valid: boolean; eventCount: number } } }> { return this.request('get', `/disputes/${id}`); }

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
