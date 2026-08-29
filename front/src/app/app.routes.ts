import { Routes } from '@angular/router';
import { HumanPage } from './pages/human';
import { MerchantPage } from './pages/merchant';
import { AgentPage } from './pages/agent';
import { AuditorPage } from './pages/auditor';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'human' },
  { path: 'human', component: HumanPage },
  { path: 'merchant', component: MerchantPage },
  { path: 'agent', component: AgentPage },
  { path: 'auditor', component: AuditorPage },
];
