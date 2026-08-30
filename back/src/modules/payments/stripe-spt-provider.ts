import { createHash } from 'node:crypto';

import { z } from 'zod';

import { HttpError } from '../../shared/http-error.js';
import type {
  CredentialCheckout,
  IssuedPaymentCredential,
  PaymentAuthorizationInput,
  PaymentCredentialProvider,
  PaymentResult,
} from './payment-types.js';

const sharedPaymentTokenSchema = z.object({
  id: z.string().startsWith('spt_'),
  usage_limits: z.object({
    currency: z.string(),
    max_amount: z.number().int().positive(),
    expires_at: z.number().int().positive(),
  }).strict(),
}).passthrough();

const paymentIntentSchema = z.object({
  id: z.string().startsWith('pi_'),
  status: z.string(),
  amount: z.number().int().positive(),
  amount_received: z.number().int().nonnegative(),
  currency: z.string(),
  created: z.number().int().positive(),
}).passthrough();

const stripeErrorSchema = z.object({
  error: z.object({ type: z.string().optional(), code: z.string().optional() }).passthrough(),
}).passthrough();

interface StripeSptOptions {
  readonly apiKey: string;
  readonly paymentMethod?: string;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
}

export class StripeSPTProvider implements PaymentCredentialProvider {
  readonly id = 'stripe-spt-test';
  private readonly apiBaseUrl: string;
  private readonly paymentMethod: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly consumedReferences = new Set<string>();

  paymentInstrument() {
    return { id: this.paymentMethod, type: 'stripe_shared_payment_token', description: 'Stripe test payment method' };
  }

  constructor(private readonly options: StripeSptOptions) {
    if (!options.apiKey.startsWith('sk_test_')) {
      throw new Error('Stripe SPT demo provider requires a Stripe test secret key');
    }
    this.apiBaseUrl = (options.apiBaseUrl ?? 'https://api.stripe.com').replace(/\/$/, '');
    this.paymentMethod = options.paymentMethod ?? 'pm_card_visa';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async issueCredential(
    authorization: PaymentAuthorizationInput,
    checkout: CredentialCheckout,
  ): Promise<IssuedPaymentCredential> {
    this.assertAuthorizationScope(authorization, checkout);
    const expiresAt = new Date(Math.min(
      authorization.expiresAt.getTime(), checkout.expiresAt.getTime(),
      authorization.issuedAt.getTime() + 60_000,
    ));
    if (expiresAt <= authorization.issuedAt) {
      throw new HttpError(409, 'PAYMENT_CREDENTIAL_EXPIRED', 'Payment credential would already be expired');
    }
    const amount = this.stripeAmount(checkout.amountMinor);
    const currency = checkout.currency.toLowerCase();
    const token = await this.post('/v1/test_helpers/shared_payment/granted_tokens', new URLSearchParams({
      payment_method: this.paymentMethod,
      'usage_limits[currency]': currency,
      'usage_limits[max_amount]': amount.toString(),
      'usage_limits[expires_at]': Math.floor(expiresAt.getTime() / 1_000).toString(),
      'seller_details[network_id]': 'nextwave',
      'seller_details[external_id]': checkout.id,
    }), sharedPaymentTokenSchema, `nextwave-spt-${authorization.id}`);
    const scopeMatches = token.usage_limits.currency.toLowerCase() === currency
      && token.usage_limits.max_amount === amount
      && token.usage_limits.expires_at === Math.floor(expiresAt.getTime() / 1_000);
    if (!scopeMatches) {
      throw new HttpError(502, 'STRIPE_SPT_SCOPE_MISMATCH', 'Stripe returned an incorrectly scoped token');
    }
    return {
      provider: this.id,
      providerReference: `stripe-spt-${authorization.id}`,
      secret: token.id,
      tokenHash: createHash('sha256').update(token.id).digest(),
      merchantId: checkout.merchantId,
      checkoutId: checkout.id,
      maxAmountMinor: checkout.amountMinor,
      currency: checkout.currency,
      issuedAt: authorization.issuedAt,
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
    this.assertCredentialScope(credential, checkout, currentTime);
    const amount = this.stripeAmount(checkout.amountMinor);
    const intent = await this.post('/v1/payment_intents', new URLSearchParams({
      amount: amount.toString(),
      currency: checkout.currency.toLowerCase(),
      shared_payment_granted_token: credential.secret,
      confirm: 'true',
      'metadata[nextwave_checkout_id]': checkout.id,
      'metadata[nextwave_merchant_id]': checkout.merchantId,
    }), paymentIntentSchema, `nextwave-payment-${checkout.id}`);
    if (intent.amount !== amount || intent.currency.toUpperCase() !== checkout.currency) {
      throw new HttpError(502, 'STRIPE_PAYMENT_SCOPE_MISMATCH', 'Stripe payment does not match checkout scope');
    }
    if (intent.status !== 'succeeded' || intent.amount_received !== amount) {
      throw new HttpError(409, 'STRIPE_PAYMENT_NOT_COMPLETED', 'Stripe payment did not complete synchronously');
    }
    this.consumedReferences.add(credential.providerReference);
    return { providerReference: intent.id, processedAt: new Date(intent.created * 1_000) };
  }

  private assertAuthorizationScope(
    authorization: PaymentAuthorizationInput,
    checkout: CredentialCheckout,
  ): void {
    if (authorization.checkoutId !== checkout.id || authorization.merchantId !== checkout.merchantId
      || authorization.amountMinor !== checkout.amountMinor || authorization.currency !== checkout.currency) {
      throw new HttpError(500, 'PAYMENT_AUTHORIZATION_SCOPE_INVALID', 'Payment authorization exceeds checkout scope');
    }
  }

  private assertCredentialScope(
    credential: IssuedPaymentCredential,
    checkout: CredentialCheckout,
    currentTime: Date,
  ): void {
    const hashValid = createHash('sha256').update(credential.secret).digest().equals(credential.tokenHash);
    const scopeValid = credential.provider === this.id
      && credential.merchantId === checkout.merchantId && credential.checkoutId === checkout.id
      && credential.maxAmountMinor === checkout.amountMinor && credential.currency === checkout.currency;
    if (!hashValid || !scopeValid) {
      throw new HttpError(409, 'PAYMENT_CREDENTIAL_SCOPE_INVALID', 'Payment credential does not match checkout');
    }
    if (credential.expiresAt <= currentTime) {
      throw new HttpError(409, 'PAYMENT_CREDENTIAL_EXPIRED', 'Payment credential is expired');
    }
  }

  private stripeAmount(amount: bigint): number {
    if (amount <= 0n || amount > 99_999_999n) {
      throw new HttpError(422, 'STRIPE_AMOUNT_UNSUPPORTED', 'Amount is outside Stripe PaymentIntent limits');
    }
    return Number(amount);
  }

  private async post<T>(
    path: string,
    body: URLSearchParams,
    schema: z.ZodType<T>,
    idempotencyKey: string,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.apiBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.options.apiKey}:`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
          'idempotency-key': idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new HttpError(503, 'STRIPE_UNAVAILABLE', 'Stripe is unavailable');
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const stripeError = stripeErrorSchema.safeParse(payload);
      throw new HttpError(502, 'STRIPE_REQUEST_FAILED', 'Stripe rejected the payment request', {
        type: stripeError.success ? stripeError.data.error.type : undefined,
        code: stripeError.success ? stripeError.data.error.code : undefined,
      });
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new HttpError(502, 'STRIPE_INVALID_RESPONSE', 'Stripe returned an invalid response');
    }
    return parsed.data;
  }
}
