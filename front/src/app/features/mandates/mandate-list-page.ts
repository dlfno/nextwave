import { DatePipe, isPlatformBrowser } from '@angular/common';
import { Component, Inject, OnInit, PLATFORM_ID, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiClient, MandateSummary } from '../../core/api-client';
import { AppNav } from '../../shared/app-nav';

@Component({ selector: 'app-mandate-list-page', imports: [AppNav, RouterLink, DatePipe], templateUrl: './mandate-list-page.html', styleUrl: './mandate-list-page.css' })
export class MandateListPage implements OnInit {
  readonly loading = signal(true);
  readonly demo = signal(false);
  readonly mandates = signal<MandateSummary[]>([]);
  constructor(private readonly api: ApiClient, @Inject(PLATFORM_ID) private readonly platformId: object) {}
  ngOnInit(): void {
    if (!isPlatformBrowser(this.platformId)) { this.demo.set(true); this.mandates.set([this.demoMandate()]); this.loading.set(false); return; }
    this.api.listMandates().subscribe({
      next: ({ mandates }) => { this.mandates.set(mandates); this.loading.set(false); },
      error: () => { this.demo.set(true); this.mandates.set([this.demoMandate()]); this.loading.set(false); },
    });
  }
  private demoMandate(): MandateSummary {
    return { id: 'demo', intentId: null, agentId: 'personal-agent', status: 'ACTIVE', mode: 'AUTONOMOUS', currentVersionId: 'demo-v1', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 12 * 86400000).toISOString() };
  }
}
