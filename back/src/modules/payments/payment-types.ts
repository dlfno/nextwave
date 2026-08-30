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
  readonly ap2Presentation: string;
  readonly ap2PresentationHash: string;
}

export interface PaymentInstrumentReference {
  readonly id: string;
  readonly type: string;
  readonly description?: string;
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
  readonly ap2PresentationHash: string;
}

export interface PaymentResult {
  readonly providerReference: string;
  readonly processedAt: Date;
  readonly paymentReceipt?: import('../commerce/commerce-types.js').SignedProtocolReceipt;
}

export interface PaymentCredentialProvider {
  readonly id: string;
  paymentInstrument(): PaymentInstrumentReference;
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
