import { describe, expect, it } from 'vitest';

import { MockPaymentCredentialProvider } from '../src/modules/payments/mock-payment-credential-provider.js';

const now = new Date('2026-08-29T12:00:00Z');
const checkout = {
  id: 'checkout-1',
  merchantId: 'merchant-1',
  amountMinor: 13_000n,
  currency: 'USD',
  expiresAt: new Date('2026-08-29T12:05:00Z'),
};
const authorization = {
  id: 'authorization-1',
  attemptId: 'attempt-1',
  checkoutId: checkout.id,
  checkoutHash: 'hash-1',
  mandateVersionId: 'version-1',
  merchantId: checkout.merchantId,
  amountMinor: checkout.amountMinor,
  currency: checkout.currency,
  issuedAt: now,
  expiresAt: new Date('2026-08-29T12:02:00Z'),
  ap2Presentation: 'issuer.jwt~closed-mandates~',
  ap2PresentationHash: 'ap2-presentation-hash',
};

describe('MockPaymentCredentialProvider', () => {
  it('issues a narrower credential capped at 60 seconds and the exact checkout', async () => {
    const provider = new MockPaymentCredentialProvider();
    const credential = await provider.issueCredential(authorization, checkout);

    expect(credential).toMatchObject({
      merchantId: checkout.merchantId,
      checkoutId: checkout.id,
      maxAmountMinor: checkout.amountMinor,
      currency: checkout.currency,
    });
    expect(credential.expiresAt.toISOString()).toBe('2026-08-29T12:01:00.000Z');
    expect(credential.secret).not.toBe(credential.tokenHash.toString('base64url'));
  });

  it('rejects wrong scope, expiration, and replay', async () => {
    const provider = new MockPaymentCredentialProvider();
    const credential = await provider.issueCredential(authorization, checkout);

    await expect(provider.consumeCredential(credential, { ...checkout, amountMinor: 14_000n }, now))
      .rejects.toMatchObject({ code: 'PAYMENT_CREDENTIAL_SCOPE_INVALID' });
    await expect(provider.consumeCredential(credential, checkout, credential.expiresAt))
      .rejects.toMatchObject({ code: 'PAYMENT_CREDENTIAL_EXPIRED' });
    await provider.consumeCredential(credential, checkout, new Date('2026-08-29T12:00:30Z'));
    await expect(provider.consumeCredential(credential, checkout, new Date('2026-08-29T12:00:31Z')))
      .rejects.toMatchObject({ code: 'PAYMENT_CREDENTIAL_REPLAYED' });
  });
});
