import { DatePipe, DecimalPipe, isPlatformBrowser } from '@angular/common';
import { Component, computed, Inject, OnInit, PLATFORM_ID, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiClient, TransactionRecord } from '../../core/api-client';
import { AppNav } from '../../shared/app-nav';

@Component({ selector: 'app-activity-page', imports: [AppNav, RouterLink, DatePipe, DecimalPipe], templateUrl: './activity-page.html', styleUrl: './activity-page.css' })
export class ActivityPage implements OnInit {
  readonly transactions = signal<TransactionRecord[]>([]); readonly loading = signal(true); readonly demo = signal(false);
  readonly delegatedSpend = computed(() => this.transactions().reduce((total, transaction) => total + Number(transaction.amountMinor), 0) / 100);
  constructor(private readonly api: ApiClient, @Inject(PLATFORM_ID) private readonly platformId: object) {}
  ngOnInit(): void {
    if (!isPlatformBrowser(this.platformId)) { this.useDemo(); return; }
    this.api.listTransactions().subscribe({ next: ({ transactions }) => { this.transactions.set(transactions); this.loading.set(false); }, error: () => this.useDemo() });
  }
  money(value: string): number { return Number(value) / 100; }
  private useDemo(): void { const now = Date.now(); this.demo.set(true); this.transactions.set([
    { id: 'demo', attemptId: 'demo-attempt', provider: 'MOCK_SPT', providerReference: 'mock-pay-84m2q', status: 'SUCCEEDED', amountMinor: '13000', currency: 'USD', failureCode: null, createdAt: new Date(now - 3600000).toISOString(), processedAt: new Date(now - 3590000).toISOString() },
    { id: 'demo-second', attemptId: 'demo-attempt-2', provider: 'MOCK_SPT', providerReference: 'mock-pay-71bx8', status: 'SUCCEEDED', amountMinor: '8600', currency: 'USD', failureCode: null, createdAt: new Date(now - 8 * 86400000).toISOString(), processedAt: new Date(now - 8 * 86400000 + 10000).toISOString() },
  ]); this.loading.set(false); }
}
