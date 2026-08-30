export interface CommerceOfferReference {
  readonly offerId: string;
  readonly merchantId: string;
  readonly merchantProductId: string;
  readonly productId: string | null;
  readonly productName: string;
  readonly category: string;
  readonly discoveredUnitPriceMinor: bigint;
  readonly currency: string;
}

export interface CheckoutLineItem {
  readonly merchantProductId: string;
  readonly productId: string | null;
  readonly productName: string;
  readonly category: string;
  readonly quantity: number;
  readonly unitPriceMinor: bigint;
  readonly totalMinor: bigint;
  readonly currency: string;
}

export interface AuthoritativeQuote {
  readonly providerQuoteId: string;
  readonly offerId: string;
  readonly merchantId: string;
  readonly totalMinor: bigint;
  readonly currency: string;
  readonly lineItems: readonly CheckoutLineItem[];
  readonly observedAt: Date;
  readonly expiresAt: Date;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface CreateCheckoutRequest {
  readonly attemptId: string;
  readonly quoteId: string;
  readonly mandateId: string;
  readonly mandateVersionId: string;
  readonly quote: AuthoritativeQuote;
  readonly currentTime: Date;
}

export interface SignedCheckout {
  readonly providerCheckoutId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadHash: Buffer;
  readonly signedPayload: string;
  readonly expiresAt: Date;
}

export interface CommerceProvider {
  readonly id: string;
  readonly merchantId: string;
  getLiveQuote(offer: CommerceOfferReference, currentTime: Date): Promise<AuthoritativeQuote>;
  createCheckout(request: CreateCheckoutRequest): Promise<SignedCheckout>;
  verifyCheckout(checkout: SignedCheckout): Promise<boolean>;
}
