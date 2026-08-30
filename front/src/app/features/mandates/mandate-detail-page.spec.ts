import { ActivatedRoute } from '@angular/router';
import { ApiClient } from '../../core/api-client';
import { DemoMandateState } from '../../core/demo-mandate-state';
import { MandateDetailPage } from './mandate-detail-page';

describe('MandateDetailPage demo lifecycle', () => {
  function createPage(): MandateDetailPage {
    localStorage.removeItem('nextwave_demo_mandate_status');
    const route = { snapshot: { paramMap: { get: () => 'demo' } } } as unknown as ActivatedRoute;
    return new MandateDetailPage(route, {} as ApiClient, new DemoMandateState());
  }

  it('authorizes the exact draft version', () => {
    const page = createPage();
    page.ngOnInit();
    page.authorize(1);
    expect(page.detail()?.mandate.status).toBe('ACTIVE');
    expect(page.currentVersion()?.signatureVerified).toBeTrue();
    expect(page.currentVersion()?.payloadHash).toBeTruthy();
  });

  it('creates a new immutable draft version', () => {
    const page = createPage();
    page.ngOnInit();
    page.authorize(1);
    page.openEditor();
    page.maxTotal = 175;
    page.saveVersion();
    expect(page.detail()?.versions.length).toBe(2);
    expect(page.detail()?.versions[0].maxTotalMinor).toBe('15000');
    expect(page.detail()?.versions[1].maxTotalMinor).toBe('17500');
    expect(page.detail()?.versions[1].status).toBe('DRAFT');
  });

  it('revokes live authority immediately', () => {
    const page = createPage();
    page.ngOnInit();
    page.authorize(1);
    page.revoke();
    expect(page.detail()?.mandate.status).toBe('REVOKED');
    expect(page.success()).toContain('Every later purchase attempt will fail');
  });
});
