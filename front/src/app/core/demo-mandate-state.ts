import { Injectable } from '@angular/core';

export type DemoMandateStatus = 'DRAFT' | 'ACTIVE' | 'REVOKED';

@Injectable({ providedIn: 'root' })
export class DemoMandateState {
  private readonly key = 'nextwave_demo_mandate_status';

  get(fallback: DemoMandateStatus): DemoMandateStatus {
    if (typeof localStorage === 'undefined') return fallback;
    const value = localStorage.getItem(this.key);
    return value === 'DRAFT' || value === 'ACTIVE' || value === 'REVOKED' ? value : fallback;
  }

  set(status: DemoMandateStatus): void {
    if (typeof localStorage !== 'undefined') localStorage.setItem(this.key, status);
  }
}
