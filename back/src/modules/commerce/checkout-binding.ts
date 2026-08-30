import type { AuthoritativeQuote, SignedCheckout } from './commerce-types.js';

export interface ExpectedCheckoutBinding {
  readonly attemptId: string;
  readonly quoteId: string;
  readonly offerId: string;
  readonly mandateId: string;
  readonly mandateVersionId: string;
  readonly quote: AuthoritativeQuote;
}

export function checkoutPayloadBound(
  payload: Readonly<Record<string, unknown>>,
  checkout: Pick<SignedCheckout, 'providerCheckoutId' | 'expiresAt'>,
  expected: ExpectedCheckoutBinding,
): boolean {
  if (typeof payload.ucp === 'object' && payload.ucp !== null) {
    return ucpCheckoutBound(payload, checkout, expected.quote);
  }
  return payload.providerCheckoutId === checkout.providerCheckoutId
    && payload.attemptId === expected.attemptId && payload.quoteId === expected.quoteId
    && payload.providerQuoteId === expected.quote.providerQuoteId
    && payload.offerId === expected.offerId && payload.mandateId === expected.mandateId
    && payload.mandateVersionId === expected.mandateVersionId
    && payload.merchantId === expected.quote.merchantId
    && payload.totalMinor === expected.quote.totalMinor.toString()
    && payload.currency === expected.quote.currency
    && payload.expiresAt === checkout.expiresAt.toISOString();
}

function ucpCheckoutBound(
  payload: Readonly<Record<string, unknown>>,
  checkout: Pick<SignedCheckout, 'providerCheckoutId' | 'expiresAt'>,
  quote: AuthoritativeQuote,
): boolean {
  if (payload.id !== checkout.providerCheckoutId || payload.currency !== quote.currency
    || payload.status !== 'ready_for_complete' || payload.expires_at !== checkout.expiresAt.toISOString()
    || !Array.isArray(payload.totals) || !Array.isArray(payload.line_items)) return false;
  const totals = payload.totals;
  const lineItems = payload.line_items;
  const total = totals.find((entry): entry is Record<string, unknown> =>
    typeof entry === 'object' && entry !== null && entry.type === 'total');
  if (!Number.isSafeInteger(total?.amount) || BigInt(total!.amount as number) !== quote.totalMinor
    || lineItems.length !== quote.lineItems.length) return false;
  return quote.lineItems.every((expectedLine, index) => {
    const actual = lineItems[index];
    if (typeof actual !== 'object' || actual === null) return false;
    const item = 'item' in actual ? actual.item : undefined;
    return typeof item === 'object' && item !== null && 'id' in item
      && item.id === expectedLine.merchantProductId
      && 'quantity' in actual && actual.quantity === expectedLine.quantity;
  });
}
