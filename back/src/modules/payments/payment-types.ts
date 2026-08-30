export interface PaymentAuthorizationInput {
  readonly id: string;
  readonly attemptId: string;
  readonly checkoutId: string;
  readonly checkoutHash: string;
  readonly mandateVersionId: string;
  readonly merchantId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface CredentialCheckout {
  readonly id: string;
  readonly merchantId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly expiresAt: Date;
}

export interface IssuedPaymentCredential {
  readonly provider: string;
  readonly providerReference: string;
  readonly secret: string;
  readonly tokenHash: Buffer;
  readonly merchantId: string;
  readonly checkoutId: string;
  readonly maxAmountMinor: bigint;
  readonly currency: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface PaymentResult {
  readonly providerReference: string;
  readonly processedAt: Date;
}

export interface PaymentCredentialProvider {
  readonly id: string;
  issueCredential(
    authorization: PaymentAuthorizationInput,
    checkout: CredentialCheckout,
  ): Promise<IssuedPaymentCredential>;
  consumeCredential(
    credential: IssuedPaymentCredential,
    checkout: CredentialCheckout,
    currentTime: Date,
  ): Promise<PaymentResult>;
}
