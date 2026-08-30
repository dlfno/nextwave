import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { finalize } from 'rxjs';
import { ApiClient, AuthorizationSpecification, MandateDetail, MandateVersion } from '../../core/api-client';
import { DemoMandateState, DemoMandateStatus } from '../../core/demo-mandate-state';
import { AppNav } from '../../shared/app-nav';

@Component({ selector: 'app-mandate-detail-page', imports: [AppNav, RouterLink, FormsModule, DatePipe, DecimalPipe], templateUrl: './mandate-detail-page.html', styleUrl: './mandate-detail-page.css' })
export class MandateDetailPage implements OnInit {
  readonly mandateId: string;
  readonly detail = signal<MandateDetail | null>(null);
  readonly loading = signal(true); readonly busy = signal(false); readonly error = signal(''); readonly demo = signal(false);
  readonly editing = signal(false); readonly revoking = signal(false); readonly success = signal('');
  maxTotal = 150; validUntil = ''; requiresConfirmation = true; revokeReason = '';
  readonly currentVersion = computed(() => this.detail()?.versions.find((version) => version.id === this.detail()?.mandate.currentVersionId) ?? this.detail()?.versions.at(-1) ?? null);
  readonly currentSpecification = computed(() => this.specification(this.currentVersion()));

  constructor(route: ActivatedRoute, private readonly api: ApiClient, private readonly demoState: DemoMandateState) { this.mandateId = route.snapshot.paramMap.get('mandateId') ?? 'demo'; }
  ngOnInit(): void {
    if (this.mandateId === 'demo') { this.setDetail(this.demoDetail(this.demoState.get('DRAFT'))); this.demo.set(true); return; }
    this.api.getMandate(this.mandateId).subscribe({ next: (detail) => this.setDetail(detail), error: (error: Error) => { this.error.set(error.message); this.loading.set(false); } });
  }
  authorize(version?: number): void {
    if (this.demo()) { this.updateDemoStatus('ACTIVE'); this.success.set('Mandate signed and activated.'); return; }
    this.run(this.api.authorizeMandate(this.mandateId, version), 'Mandate signed and activated.');
  }
  openEditor(): void { const version = this.currentVersion(); if (!version) return; this.maxTotal = Number(version.maxTotalMinor) / 100; this.validUntil = this.toLocalDate(version.validUntil); this.requiresConfirmation = version.requiresFinalConfirmation; this.editing.set(true); }
  saveVersion(): void {
    const base = this.specification(this.currentVersion()); if (!base || this.maxTotal <= 0 || !this.validUntil) return;
    const specification: AuthorizationSpecification = { ...base, spendConstraints: { ...base.spendConstraints, maxTotalMinor: String(Math.round(this.maxTotal * 100)) }, validUntil: new Date(`${this.validUntil}T23:59:59Z`).toISOString(), requiresFinalConfirmation: this.requiresConfirmation };
    if (this.demo()) { const detail = this.detail()!; const version = this.demoVersion(detail.versions.length + 1, 'DRAFT', specification); this.detail.set({ ...detail, versions: [...detail.versions, version] }); this.editing.set(false); this.success.set('Version drafted. It must be authorized before it becomes active.'); return; }
    this.run(this.api.createMandateVersion(this.mandateId, specification), 'Version drafted. It must be authorized before it becomes active.', () => this.editing.set(false));
  }
  revoke(): void {
    if (this.demo()) { this.updateDemoStatus('REVOKED'); this.revoking.set(false); this.success.set('Mandate revoked. Every later purchase attempt will fail.'); return; }
    this.run(this.api.revokeMandate(this.mandateId, this.revokeReason.trim() || undefined), 'Mandate revoked. Every later purchase attempt will fail.', () => this.revoking.set(false));
  }
  money(minor: string): number { return Number(minor) / 100; }
  shortHash(hash: string | null): string { return hash ? `${hash.slice(0, 11)}…${hash.slice(-7)}` : 'Created when authorized'; }
  airportName(iata?: string): string { return ({ MEX: 'Mexico City', LAX: 'Los Angeles', COR: 'Córdoba, Argentina', ODB: 'Córdoba, Spain' } as Record<string, string>)[iata ?? ''] ?? iata ?? 'Unknown'; }

  private run(request: ReturnType<ApiClient['getMandate']>, message: string, done?: () => void): void {
    this.busy.set(true); this.error.set(''); this.success.set(''); request.pipe(finalize(() => this.busy.set(false))).subscribe({ next: (detail) => { this.detail.set(detail); this.success.set(message); done?.(); }, error: (error: Error) => this.error.set(error.message) });
  }
  private setDetail(detail: MandateDetail): void { this.detail.set(detail); this.loading.set(false); }
  private specification(version: MandateVersion | null): AuthorizationSpecification | null { if (!version) return null; const payload = version.canonicalPayload as AuthorizationSpecification & { constraints?: AuthorizationSpecification }; return payload.constraints ?? payload; }
  private toLocalDate(value: string): string { return new Date(value).toISOString().slice(0, 10); }
  private updateDemoStatus(status: DemoMandateStatus): void { this.demoState.set(status); const detail = this.detail()!; const versions = detail.versions.map((version, index) => ({ ...version, status: index === detail.versions.length - 1 ? status : 'SUPERSEDED', signatureVerified: status === 'ACTIVE' ? true : version.signatureVerified, payloadHash: status === 'ACTIVE' ? 'Y4uN2Kx8qP5sDc9Rv7Ab3Fg1Lm' : version.payloadHash })); this.detail.set({ ...detail, mandate: { ...detail.mandate, status, currentVersionId: status === 'ACTIVE' ? versions.at(-1)!.id : detail.mandate.currentVersionId }, versions }); }
  private demoVersion(version: number, status: string, specification?: AuthorizationSpecification): MandateVersion { const spec = specification ?? { intentDraftHash: '0'.repeat(64), productConstraints: { category: 'travel.flight', originIata: 'MEX', destinationIata: 'COR', departureDate: '2026-09-15', quantity: 1 }, spendConstraints: { maxTotalMinor: '15000', currency: 'USD' }, merchantConstraints: { allowedMerchants: 'ANY' }, validUntil: new Date(Date.now() + 12 * 86400000).toISOString(), requiresFinalConfirmation: true }; return { id: `demo-v${version}`, version, status, maxTotalMinor: spec.spendConstraints.maxTotalMinor, currency: spec.spendConstraints.currency, validFrom: new Date().toISOString(), validUntil: spec.validUntil, requiresFinalConfirmation: spec.requiresFinalConfirmation, canonicalPayload: spec, payloadHash: status === 'ACTIVE' ? 'Y4uN2Kx8qP5sDc9Rv7Ab3Fg1Lm' : null, signatureVerified: status === 'ACTIVE' ? true : null }; }
  private demoDetail(status: DemoMandateStatus): MandateDetail { const version = this.demoVersion(1, status); return { mandate: { id: 'demo', intentId: null, agentId: 'personal-agent', status, mode: 'AUTONOMOUS', currentVersionId: status === 'DRAFT' ? null : version.id, createdAt: new Date().toISOString(), expiresAt: version.validUntil }, versions: [version], revocations: status === 'REVOKED' ? [{ reason: 'Demo trial-by-fire revocation', revokedAt: new Date().toISOString() }] : [] }; }
}
