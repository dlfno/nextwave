import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'intent' },
  { path: 'auth', loadComponent: () => import('./features/auth/auth-page').then((m) => m.AuthPage) },
  { path: 'intent', loadComponent: () => import('./features/intent/intent-page').then((m) => m.IntentPage) },
  { path: 'agent', loadComponent: () => import('./features/agent/agent-page').then((m) => m.AgentPage) },
  { path: '**', redirectTo: 'intent' },
];
