import { ActivatedRoute } from '@angular/router';
import { ApiClient } from '../../core/api-client';
import { DemoMandateState } from '../../core/demo-mandate-state';
import { CommercePage } from './commerce-page';

describe('CommercePage demo circuit', () => {
  let page: CommercePage;

  beforeEach(() => {
    jasmine.clock().install();
    localStorage.removeItem('nextwave_demo_mandate_status');
    const route = { snapshot: { paramMap: { get: () => 'demo' } } } as unknown as ActivatedRoute;
    page = new CommercePage(route, {} as ApiClient, new DemoMandateState());
    page.ngOnInit();
  });

  afterEach(() => jasmine.clock().uninstall());

  it('labels discovered offers as non-authoritative', () => {
    expect(page.phase()).toBe('OFFERS');
    expect(page.offers().length).toBe(2);
    expect(page.offers().every((offer) => offer.authoritative === false)).toBeTrue();
  });

  it('does not allow a discovery-only web result to cross the checkout boundary', () => {
    const webOffer = {
      ...page.offers()[0],
      sourceType: 'WEB',
      supportsAuthoritativeCheckout: false,
    };

    page.choose(webOffer);

    expect(page.selected()).toBeNull();
    expect(page.phase()).toBe('OFFERS');
    expect(page.error()).toContain('authoritative checkout');
  });

  it('deterministically denies an over-limit authoritative checkout', () => {
    page.choose(page.offers()[1]);
    jasmine.clock().tick(451);
    expect(page.phase()).toBe('CHECKOUT');
    expect(page.decision()?.decision).toBe('DENY');
    expect(page.decision()?.reasonCode).toBe('AMOUNT_EXCEEDS_MANDATE');
  });

  it('requires approval before issuing and consuming a constrained credential', () => {
    page.choose(page.offers()[0]);
    jasmine.clock().tick(451);
    expect(page.decision()?.decision).toBe('REQUIRE_HUMAN_APPROVAL');
    page.approve();
    expect(page.decision()?.decision).toBe('ALLOW');
    page.purchase();
    jasmine.clock().tick(551);
    expect(page.phase()).toBe('SUCCESS');
    expect(page.result()?.credential.status).toBe('CONSUMED');
    expect(page.result()?.order.status).toBe('CONFIRMED');
  });
});
