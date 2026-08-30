import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { HttpError } from '../../shared/http-error.js';
import type {
  CredentialCheckout,
  IssuedPaymentCredential,
  PaymentAuthorizationInput,
  PaymentCredentialProvider,
  PaymentResult,
} from './payment-types.js';

export class MockPaymentCredentialProvider implements PaymentCredentialProvider {
  readonly id = 'mock-constrained-credential';
  private readonly consumedReferences = new Set<string>();

  async issueCredential(
    authorization: PaymentAuthorizationInput,
    checkout: CredentialCheckout,
  ): Promise<IssuedPaymentCredential> {
    if (authorization.checkoutId !== checkout.id || authorization.merchantId !== checkout.merchantId
      || authorization.amountMinor !== checkout.amountMinor || authorization.currency !== checkout.currency) {
      throw new HttpError(500, 'PAYMENT_AUTHORIZATION_SCOPE_INVALID', 'Payment authorization exceeds checkout scope');
    }
    const issuedAt = authorization.issuedAt;
    const expiresAt = new Date(Math.min(
      authorization.expiresAt.getTime(), checkout.expiresAt.getTime(), issuedAt.getTime() + 60_000,
    ));
    const secret = randomBytes(32).toString('base64url');
    return {
      provider: this.id,
      providerReference: `mock-credential-${randomUUID()}`,
      secret,
      tokenHash: createHash('sha256').update(secret).digest(),
      merchantId: checkout.merchantId,
      checkoutId: checkout.id,
      maxAmountMinor: checkout.amountMinor,
      currency: checkout.currency,
      issuedAt,
      expiresAt,
    };
  }

  async consumeCredential(
    credential: IssuedPaymentCredential,
    checkout: CredentialCheckout,
    currentTime: Date,
  ): Promise<PaymentResult> {
    if (this.consumedReferences.has(credential.providerReference)) {
      throw new HttpError(409, 'PAYMENT_CREDENTIAL_REPLAYED', 'Payment credential was already consumed');
    }
    const hashValid = createHash('sha256').update(credential.secret).digest().equals(credential.tokenHash);
    const scopeValid = credential.merchantId === checkout.merchantId
      && credential.checkoutId === checkout.id && credential.maxAmountMinor === checkout.amountMinor
      && credential.currency === checkout.currency;
    if (!hashValid || !scopeValid) {
      throw new HttpError(409, 'PAYMENT_CREDENTIAL_SCOPE_INVALID', 'Payment credential does not match checkout');
    }
    if (credential.expiresAt.getTime() <= currentTime.getTime()) {
      throw new HttpError(409, 'PAYMENT_CREDENTIAL_EXPIRED', 'Payment credential is expired');
    }
    this.consumedReferences.add(credential.providerReference);
    return { providerReference: `mock-payment-${randomUUID()}`, processedAt: currentTime };
  }
}

export class StripeSPTProvider implements PaymentCredentialProvider {
  readonly id = 'stripe-spt';

  async issueCredential(): Promise<never> {
    throw new HttpError(503, 'STRIPE_SPT_UNAVAILABLE', 'Stripe Shared Payment Tokens are not configured');
  }

  async consumeCredential(): Promise<never> {
    throw new HttpError(503, 'STRIPE_SPT_UNAVAILABLE', 'Stripe Shared Payment Tokens are not configured');
  }
}
