import { describe, expect, it } from 'vitest';

import { StripeSPTProvider } from '../src/modules/payments/stripe-spt-provider.js';

const now = new Date('2026-08-29T12:00:00Z');
const checkout = {
  id: '80000000-0000-4000-8000-000000000001',
  merchantId: '10000000-0000-4000-8000-000000000001',
  amountMinor: 13_000n,
  currency: 'USD',
  expiresAt: new Date('2026-08-29T12:05:00Z'),
};
const authorization = {
  id: '90000000-0000-4000-8000-000000000001',
  attemptId: '40000000-0000-4000-8000-000000000001',
  checkoutId: checkout.id,
  checkoutHash: 'checkout-hash',
  mandateVersionId: '70000000-0000-4000-8000-000000000001',
  merchantId: checkout.merchantId,
  amountMinor: checkout.amountMinor,
  currency: checkout.currency,
  issuedAt: now,
  expiresAt: new Date('2026-08-29T12:02:00Z'),
  ap2Presentation: 'issuer.jwt~closed-mandates~',
  ap2PresentationHash: 'ap2-presentation-hash',
};

describe('StripeSPTProvider', () => {
  it('issues an exact SPT and confirms one checkout-bound PaymentIntent', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      new Response(JSON.stringify({
        id: 'spt_test_nextwave',
        usage_limits: { currency: 'usd', max_amount: 13_000, expires_at: 1_788_004_860 },
      }), { status: 200 }),
      new Response(JSON.stringify({
        id: 'pi_test_nextwave', status: 'succeeded', amount: 13_000,
        amount_received: 13_000, currency: 'usd', created: 1_788_004_830,
      }), { status: 200 }),
    ];
    const fetchFn: typeof fetch = async (input, init) => {
      calls.push({ url: input.toString(), ...(init ? { init } : {}) });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected request');
      return response;
    };
    const provider = new StripeSPTProvider({
      apiKey: 'sk_test_example', apiBaseUrl: 'https://stripe.test', fetchFn,
    });

    const credential = await provider.issueCredential(authorization, checkout);
    expect(credential).toMatchObject({
      provider: 'stripe-spt-test',
      providerReference: `stripe-spt-${authorization.id}`,
      merchantId: checkout.merchantId, checkoutId: checkout.id,
      maxAmountMinor: 13_000n, currency: 'USD',
    });
    expect(credential.expiresAt.toISOString()).toBe('2026-08-29T12:01:00.000Z');
    expect(credential.tokenHash.toString('utf8')).not.toContain(credential.secret);
    expect(credential.providerReference).not.toBe(credential.secret);

    const issuedBody = calls[0]?.init?.body as URLSearchParams;
    expect(Object.fromEntries(issuedBody)).toMatchObject({
      payment_method: 'pm_card_visa',
      'usage_limits[currency]': 'usd',
      'usage_limits[max_amount]': '13000',
      'usage_limits[expires_at]': '1788004860',
      'seller_details[external_id]': checkout.id,
    });
    expect(new Headers(calls[0]?.init?.headers).get('idempotency-key'))
      .toBe(`nextwave-spt-${authorization.id}`);

    const payment = await provider.consumeCredential(
      credential, checkout, new Date('2026-08-29T12:00:30Z'),
    );
    expect(payment).toEqual({
      providerReference: 'pi_test_nextwave', processedAt: new Date('2026-08-29T12:00:30Z'),
    });
    const paymentBody = calls[1]?.init?.body as URLSearchParams;
    expect(Object.fromEntries(paymentBody)).toMatchObject({
      amount: '13000', currency: 'usd', confirm: 'true',
      shared_payment_granted_token: 'spt_test_nextwave',
      'metadata[nextwave_checkout_id]': checkout.id,
    });
    await expect(provider.consumeCredential(credential, checkout, new Date('2026-08-29T12:00:31Z')))
      .rejects.toMatchObject({ code: 'PAYMENT_CREDENTIAL_REPLAYED' });
  });

  it('rejects authorization drift before contacting Stripe', async () => {
    let called = false;
    const provider = new StripeSPTProvider({
      apiKey: 'sk_test_example',
      fetchFn: async () => { called = true; throw new Error('must not call Stripe'); },
    });
    await expect(provider.issueCredential(authorization, { ...checkout, amountMinor: 14_000n }))
      .rejects.toMatchObject({ code: 'PAYMENT_AUTHORIZATION_SCOPE_INVALID' });
    expect(called).toBe(false);
  });

  it('fails closed when Stripe returns a differently scoped token', async () => {
    const provider = new StripeSPTProvider({
      apiKey: 'sk_test_example',
      fetchFn: async () => new Response(JSON.stringify({
        id: 'spt_wrong_scope',
        usage_limits: { currency: 'usd', max_amount: 30_000, expires_at: 1_788_004_860 },
      }), { status: 200 }),
    });
    await expect(provider.issueCredential(authorization, checkout))
      .rejects.toMatchObject({ code: 'STRIPE_SPT_SCOPE_MISMATCH' });
  });
});
