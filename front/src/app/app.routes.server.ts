import { RenderMode, ServerRoute } from '@angular/ssr';

export const serverRoutes: ServerRoute[] = [
  {
    path: 'mandates/:mandateId',
    renderMode: RenderMode.Server
  },
  {
    path: 'commerce/:intentId',
    renderMode: RenderMode.Server
  },
  { path: 'transactions/:transactionId', renderMode: RenderMode.Server },
  { path: 'merchant-verification/:recordId', renderMode: RenderMode.Server },
  { path: 'auditor-evidence/:recordId', renderMode: RenderMode.Server },
  { path: 'disputes/:disputeId', renderMode: RenderMode.Server },
  {
    path: '**',
    renderMode: RenderMode.Prerender
  }
];
