import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'intent' },
  { path: 'auth', loadComponent: () => import('./features/auth/auth-page').then((m) => m.AuthPage) },
  { path: 'intent', loadComponent: () => import('./features/intent/intent-page').then((m) => m.IntentPage) },
  { path: 'agent', loadComponent: () => import('./features/agent/agent-page').then((m) => m.AgentPage) },
  { path: 'mandates', loadComponent: () => import('./features/mandates/mandate-list-page').then((m) => m.MandateListPage) },
  { path: 'mandates/:mandateId', loadComponent: () => import('./features/mandates/mandate-detail-page').then((m) => m.MandateDetailPage) },
  { path: '**', redirectTo: 'intent' },
];
