import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { HttpError } from '../../shared/http-error.js';
import type { CheckoutSigner } from '../commerce/checkout-signer.js';
import { ap2PaymentReceiptSchema } from '../mandates/ap2-credential.js';
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

  constructor(private readonly receiptSigner?: CheckoutSigner) {}

  paymentInstrument() {
    return { id: 'nextwave-mock-wallet', type: 'mock_constrained_token', description: 'Nextwave demo wallet' };
  }

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
      ap2PresentationHash: authorization.ap2PresentationHash,
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
    const providerReference = `mock-payment-${randomUUID()}`;
    const receiptPayload = ap2PaymentReceiptSchema.parse({
      status: 'Success', iss: 'urn:nextwave:mock-payment-processor',
      iat: Math.floor(currentTime.getTime() / 1_000), reference: credential.ap2PresentationHash,
      payment_id: providerReference, psp_confirmation_id: providerReference,
      network_confirmation_id: `mock-network-${randomUUID()}`,
    });
    const paymentReceipt = this.receiptSigner
      ? await this.receiptSigner.signReceipt(receiptPayload) : undefined;
    return { providerReference, processedAt: currentTime, ...(paymentReceipt ? { paymentReceipt } : {}) };
  }
}
