import { POLICY_REASON_CODES } from './reason-codes.js';
import type {
  CheckoutLineItem,
  MandateCheck,
  MandateDecision,
  MandateEngine,
  MandateEvaluationInput,
  PolicyEvidenceValue,
} from './policy-types.js';

type Evidence = Readonly<Record<string, PolicyEvidenceValue>>;

function check(
  name: string,
  passed: boolean,
  reasonCode: MandateCheck['reasonCode'],
  evidence?: Evidence,
): MandateCheck {
  const failure = !passed && reasonCode !== undefined ? { reasonCode } : {};
  return evidence === undefined
    ? { name, passed, ...failure }
    : { name, passed, ...failure, evidence };
}

function normalizeProductName(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function categoryMatches(category: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => category === prefix || category.startsWith(`${prefix}.`));
}

function productsMatch(
  lineItems: readonly CheckoutLineItem[],
  allowedIds: readonly string[] | undefined,
  allowedNames: readonly string[] | undefined,
): boolean {
  const normalizedNames = allowedNames?.map(normalizeProductName);

  return lineItems.every((item) => {
    const idAllowed = allowedIds === undefined
      || (item.productId !== undefined && allowedIds.includes(item.productId));
    const nameAllowed = normalizedNames === undefined
      || normalizedNames.includes(normalizeProductName(item.productName));
    return idAllowed && nameAllowed;
  });
}

function checkoutIsBound(input: MandateEvaluationInput): boolean {
  const { checkout, context, mandate } = input;
  const lineItemsTotal = checkout.lineItems.reduce((total, item) => total + item.totalMinor, 0n);
  const validLineItemMath = checkout.lineItems.every(
    (item) => Number.isSafeInteger(item.quantity)
      && item.quantity > 0
      && item.unitPriceMinor >= 0n
      && item.totalMinor === item.unitPriceMinor * BigInt(item.quantity),
  );

  return checkout.mandateId === mandate.id
    && checkout.mandateVersionId === mandate.versionId
    && context.mandateId === mandate.id
    && context.mandateVersionId === mandate.versionId
    && checkout.selectedOfferId === context.selectedOfferId
    && checkout.quoteId === context.quoteId
    && checkout.merchantId === context.merchantId
    && checkout.totalMinor === context.expectedTotalMinor
    && checkout.currency === context.expectedCurrency
    && checkout.lineItems.length > 0
    && lineItemsTotal === checkout.totalMinor
    && validLineItemMath;
}

export class DeterministicMandateEngine implements MandateEngine {
  evaluate(input: MandateEvaluationInput): MandateDecision {
    const { mandate, checkout, priorUsage, currentTime } = input;
    const { constraints } = mandate;
    const currentMillis = currentTime.getTime();
    const totalQuantity = checkout.lineItems.reduce((total, item) => total + item.quantity, 0);
    const allowedMerchant = constraints.allowedMerchantIds === 'ANY'
      || constraints.allowedMerchantIds.includes(checkout.merchantId);
    const allowedCategories = checkout.lineItems.every((item) =>
      categoryMatches(item.category, constraints.allowedCategoryPrefixes));
    const allowedProducts = productsMatch(
      checkout.lineItems,
      constraints.allowedProductIds,
      constraints.allowedProductNames,
    );
    const currencyAllowed = checkout.currency === constraints.currency
      && checkout.lineItems.every((item) => item.currency === constraints.currency);
    const withinUsageLimit = constraints.maxUses === undefined
      || priorUsage.consumedUses + priorUsage.reservedUses + 1 <= constraints.maxUses;
    const withinBudget = constraints.budgetMinor === undefined
      || priorUsage.consumedAmountMinor + priorUsage.reservedAmountMinor + checkout.totalMinor
        <= constraints.budgetMinor;

    const checks: MandateCheck[] = [
      check('MANDATE_SIGNATURE_VALID', mandate.signatureValid,
        POLICY_REASON_CODES.MANDATE_SIGNATURE_INVALID),
      check('AUTHORIZED_AGENT_MATCH', mandate.authorizedAgentId === input.agentId,
        POLICY_REASON_CODES.AGENT_NOT_AUTHORIZED),
      check('MANDATE_NOT_REVOKED', input.revokedAt === null && mandate.status !== 'REVOKED',
        POLICY_REASON_CODES.MANDATE_REVOKED,
        { revokedAt: input.revokedAt?.toISOString() ?? null }),
      check('MANDATE_ACTIVE', mandate.status === 'ACTIVE', POLICY_REASON_CODES.MANDATE_NOT_ACTIVE,
        { status: mandate.status }),
      check('MANDATE_VALID_FROM', currentMillis >= mandate.validFrom.getTime(),
        POLICY_REASON_CODES.MANDATE_NOT_YET_VALID,
        { validFrom: mandate.validFrom.toISOString() }),
      check('MANDATE_NOT_EXPIRED', currentMillis < mandate.validUntil.getTime(),
        POLICY_REASON_CODES.MANDATE_EXPIRED,
        { validUntil: mandate.validUntil.toISOString() }),
      check('CHECKOUT_SIGNATURE_VALID', checkout.signatureValid,
        POLICY_REASON_CODES.CHECKOUT_SIGNATURE_INVALID),
      check('CHECKOUT_NOT_USED', !checkout.alreadyUsed, POLICY_REASON_CODES.CHECKOUT_ALREADY_USED),
      check('CHECKOUT_READY', checkout.status === 'READY', POLICY_REASON_CODES.CHECKOUT_STATUS_INVALID,
        { status: checkout.status }),
      check('CHECKOUT_NOT_EXPIRED', currentMillis < checkout.expiresAt.getTime(),
        POLICY_REASON_CODES.CHECKOUT_EXPIRED,
        { expiresAt: checkout.expiresAt.toISOString() }),
      check('CHECKOUT_BOUND_TO_CONTEXT', checkoutIsBound(input),
        POLICY_REASON_CODES.CHECKOUT_BINDING_MISMATCH),
      check('MERCHANT_ALLOWED', allowedMerchant, POLICY_REASON_CODES.MERCHANT_NOT_ALLOWED,
        { merchantId: checkout.merchantId }),
      check('CATEGORY_ALLOWED', allowedCategories, POLICY_REASON_CODES.CATEGORY_NOT_ALLOWED),
      check('PRODUCT_ALLOWED', allowedProducts, POLICY_REASON_CODES.PRODUCT_NOT_ALLOWED),
      check('QUANTITY_ALLOWED', totalQuantity <= constraints.maxQuantity,
        POLICY_REASON_CODES.QUANTITY_EXCEEDED,
        { quantity: totalQuantity, maxQuantity: constraints.maxQuantity }),
      check('AMOUNT_ALLOWED', checkout.totalMinor <= constraints.maxTotalMinor,
        POLICY_REASON_CODES.AMOUNT_EXCEEDS_MANDATE,
        { totalMinor: checkout.totalMinor.toString(), maxTotalMinor: constraints.maxTotalMinor.toString() }),
      check('CURRENCY_ALLOWED', currencyAllowed, POLICY_REASON_CODES.CURRENCY_NOT_ALLOWED,
        { currency: checkout.currency, allowedCurrency: constraints.currency }),
      check('USAGE_ALLOWED', withinUsageLimit, POLICY_REASON_CODES.USAGE_LIMIT_EXCEEDED),
      check('BUDGET_ALLOWED', withinBudget, POLICY_REASON_CODES.BUDGET_EXCEEDED),
    ];

    const hardFailure = checks.find((candidate) => !candidate.passed);
    if (hardFailure?.reasonCode !== undefined) {
      return this.decision(input, 'DENY', hardFailure.reasonCode, checks);
    }

    if (constraints.requiresFinalConfirmation) {
      const approval = input.humanApproval;
      if (approval === undefined) {
        checks.push(check('HUMAN_APPROVAL_PRESENT', false,
          POLICY_REASON_CODES.HUMAN_APPROVAL_MISSING));
        return this.decision(input, 'REQUIRE_HUMAN_APPROVAL',
          POLICY_REASON_CODES.HUMAN_APPROVAL_REQUIRED, checks);
      }

      if (approval.decision === 'DENIED') {
        checks.push(check('HUMAN_APPROVAL_GRANTED', false,
          POLICY_REASON_CODES.HUMAN_APPROVAL_DENIED));
        return this.decision(input, 'DENY', POLICY_REASON_CODES.HUMAN_APPROVAL_DENIED, checks);
      }

      if (currentMillis >= approval.expiresAt.getTime()) {
        checks.push(check('HUMAN_APPROVAL_NOT_EXPIRED', false,
          POLICY_REASON_CODES.HUMAN_APPROVAL_EXPIRED,
          { expiresAt: approval.expiresAt.toISOString() }));
        return this.decision(input, 'DENY', POLICY_REASON_CODES.HUMAN_APPROVAL_EXPIRED, checks);
      }

      if (approval.mandateVersionId !== mandate.versionId
        || approval.checkoutHash !== checkout.hash) {
        checks.push(check('HUMAN_APPROVAL_BOUND_TO_CONTEXT', false,
          POLICY_REASON_CODES.HUMAN_APPROVAL_MISMATCH));
        return this.decision(input, 'DENY', POLICY_REASON_CODES.HUMAN_APPROVAL_MISMATCH, checks);
      }

      checks.push(check('HUMAN_APPROVAL_VALID', true, undefined));
    }

    return this.decision(
      input,
      'ALLOW',
      POLICY_REASON_CODES.ALL_CONSTRAINTS_SATISFIED,
      checks,
    );
  }

  private decision(
    input: MandateEvaluationInput,
    decision: MandateDecision['decision'],
    reasonCode: MandateDecision['reasonCode'],
    checks: readonly MandateCheck[],
  ): MandateDecision {
    return {
      decision,
      reasonCode,
      mandateId: input.mandate.id,
      mandateVersion: input.mandate.version,
      checkoutHash: input.checkout.hash,
      evaluatedAt: input.currentTime.toISOString(),
      checks,
    };
  }
}
