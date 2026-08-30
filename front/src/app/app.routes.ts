import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'intent' },
  { path: 'auth', loadComponent: () => import('./features/auth/auth-page').then((m) => m.AuthPage) },
  { path: 'intent', loadComponent: () => import('./features/intent/intent-page').then((m) => m.IntentPage) },
  { path: 'agent', loadComponent: () => import('./features/agent/agent-page').then((m) => m.AgentPage) },
  { path: 'mandates', loadComponent: () => import('./features/mandates/mandate-list-page').then((m) => m.MandateListPage) },
  { path: 'mandates/:mandateId', loadComponent: () => import('./features/mandates/mandate-detail-page').then((m) => m.MandateDetailPage) },
  { path: 'commerce/:intentId', loadComponent: () => import('./features/commerce/commerce-page').then((m) => m.CommercePage) },
  { path: 'activity', loadComponent: () => import('./features/records/activity-page').then((m) => m.ActivityPage) },
  { path: 'transactions/:transactionId', loadComponent: () => import('./features/records/transaction-page').then((m) => m.TransactionPage) },
  { path: 'merchant-verification/:recordId', data: { evidenceView: 'merchant' }, loadComponent: () => import('./features/records/evidence-page').then((m) => m.EvidencePage) },
  { path: 'auditor-evidence/:recordId', data: { evidenceView: 'auditor' }, loadComponent: () => import('./features/records/evidence-page').then((m) => m.EvidencePage) },
  { path: 'disputes/:disputeId', loadComponent: () => import('./features/records/dispute-page').then((m) => m.DisputePage) },
  { path: '**', redirectTo: 'intent' },
];
