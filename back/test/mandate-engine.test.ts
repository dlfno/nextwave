import { describe, expect, it } from 'vitest';

import {
  DeterministicMandateEngine,
  POLICY_REASON_CODES,
  type HumanApprovalEvidence,
  type MandateEvaluationInput,
  type PolicyReasonCode,
} from '../src/modules/policy-engine/index.js';

const NOW = new Date('2026-08-29T12:00:00.000Z');

function validInput(): MandateEvaluationInput {
  return {
    mandate: {
      id: 'mandate-1',
      versionId: 'mandate-version-1',
      version: 1,
      signatureValid: true,
      authorizedAgentId: 'agent-1',
      status: 'ACTIVE',
      validFrom: new Date('2026-08-01T00:00:00.000Z'),
      validUntil: new Date('2026-09-30T00:00:00.000Z'),
      constraints: {
        maxTotalMinor: 15_000n,
        currency: 'USD',
        allowedMerchantIds: ['vuela-ya'],
        allowedCategoryPrefixes: ['travel.flight'],
        allowedProductIds: ['flight-cor-130'],
        maxQuantity: 1,
        maxUses: 2,
        budgetMinor: 30_000n,
        requiresFinalConfirmation: false,
      },
    },
    checkout: {
      id: 'checkout-1',
      hash: 'sha256:checkout-1',
      signatureValid: true,
      status: 'READY',
      alreadyUsed: false,
      mandateId: 'mandate-1',
      mandateVersionId: 'mandate-version-1',
      selectedOfferId: 'offer-1',
      quoteId: 'quote-1',
      merchantId: 'vuela-ya',
      totalMinor: 13_000n,
      currency: 'USD',
      expiresAt: new Date('2026-08-29T12:05:00.000Z'),
      lineItems: [{
        productId: 'flight-cor-130',
        productName: 'MEX to COR flight',
        category: 'travel.flight.economy',
        quantity: 1,
        unitPriceMinor: 13_000n,
        totalMinor: 13_000n,
        currency: 'USD',
      }],
    },
    context: {
      mandateId: 'mandate-1',
      mandateVersionId: 'mandate-version-1',
      selectedOfferId: 'offer-1',
      quoteId: 'quote-1',
      merchantId: 'vuela-ya',
      expectedTotalMinor: 13_000n,
      expectedCurrency: 'USD',
    },
    agentId: 'agent-1',
    currentTime: NOW,
    revokedAt: null,
    priorUsage: {
      consumedUses: 0,
      reservedUses: 0,
      consumedAmountMinor: 0n,
      reservedAmountMinor: 0n,
    },
  };
}

function validApproval(): HumanApprovalEvidence {
  return {
    decision: 'APPROVED',
    mandateVersionId: 'mandate-version-1',
    checkoutHash: 'sha256:checkout-1',
    expiresAt: new Date('2026-08-29T12:02:00.000Z'),
  };
}

type AdversarialCase = readonly [
  name: string,
  reason: PolicyReasonCode,
  alter: (input: MandateEvaluationInput) => MandateEvaluationInput,
];

const adversarialCases: readonly AdversarialCase[] = [
  ['invalid mandate signature', POLICY_REASON_CODES.MANDATE_SIGNATURE_INVALID,
    (input) => ({ ...input, mandate: { ...input.mandate, signatureValid: false } })],
  ['different agent', POLICY_REASON_CODES.AGENT_NOT_AUTHORIZED,
    (input) => ({ ...input, agentId: 'impersonated-agent' })],
  ['live revocation', POLICY_REASON_CODES.MANDATE_REVOKED,
    (input) => ({ ...input, revokedAt: new Date('2026-08-29T11:59:00.000Z') })],
  ['revoked mandate status', POLICY_REASON_CODES.MANDATE_REVOKED,
    (input) => ({ ...input, mandate: { ...input.mandate, status: 'REVOKED' } })],
  ['inactive mandate', POLICY_REASON_CODES.MANDATE_NOT_ACTIVE,
    (input) => ({ ...input, mandate: { ...input.mandate, status: 'DRAFT' } })],
  ['mandate not yet valid', POLICY_REASON_CODES.MANDATE_NOT_YET_VALID,
    (input) => ({ ...input, mandate: { ...input.mandate, validFrom: new Date('2026-08-30') } })],
  ['expired mandate', POLICY_REASON_CODES.MANDATE_EXPIRED,
    (input) => ({ ...input, mandate: { ...input.mandate, validUntil: NOW } })],
  ['invalid checkout signature', POLICY_REASON_CODES.CHECKOUT_SIGNATURE_INVALID,
    (input) => ({ ...input, checkout: { ...input.checkout, signatureValid: false } })],
  ['reused checkout', POLICY_REASON_CODES.CHECKOUT_ALREADY_USED,
    (input) => ({ ...input, checkout: { ...input.checkout, alreadyUsed: true, status: 'COMPLETED' } })],
  ['invalid checkout state', POLICY_REASON_CODES.CHECKOUT_STATUS_INVALID,
    (input) => ({ ...input, checkout: { ...input.checkout, status: 'CANCELLED' } })],
  ['expired checkout', POLICY_REASON_CODES.CHECKOUT_EXPIRED,
    (input) => ({ ...input, checkout: { ...input.checkout, expiresAt: NOW } })],
  ['checkout bound to a different quote', POLICY_REASON_CODES.CHECKOUT_BINDING_MISMATCH,
    (input) => ({ ...input, checkout: { ...input.checkout, quoteId: 'old-quote' } })],
  ['line-item arithmetic tampering', POLICY_REASON_CODES.CHECKOUT_BINDING_MISMATCH,
    (input) => ({
      ...input,
      checkout: {
        ...input.checkout,
        lineItems: [{ ...input.checkout.lineItems[0]!, totalMinor: 12_999n }],
      },
    })],
  ['empty checkout', POLICY_REASON_CODES.CHECKOUT_BINDING_MISMATCH,
    (input) => ({
      ...input,
      checkout: {
        ...input.checkout,
        totalMinor: 0n,
        lineItems: [],
      },
      context: { ...input.context, expectedTotalMinor: 0n },
    })],
  ['different merchant', POLICY_REASON_CODES.MERCHANT_NOT_ALLOWED,
    (input) => ({
      ...input,
      mandate: {
        ...input.mandate,
        constraints: { ...input.mandate.constraints, allowedMerchantIds: ['other-merchant'] },
      },
    })],
  ['different category', POLICY_REASON_CODES.CATEGORY_NOT_ALLOWED,
    (input) => ({
      ...input,
      checkout: {
        ...input.checkout,
        lineItems: [{ ...input.checkout.lineItems[0]!, category: 'travel.hotel' }],
      },
    })],
  ['different product', POLICY_REASON_CODES.PRODUCT_NOT_ALLOWED,
    (input) => ({
      ...input,
      checkout: {
        ...input.checkout,
        lineItems: [{ ...input.checkout.lineItems[0]!, productId: 'flight-mad-130' }],
      },
    })],
  ['excess quantity', POLICY_REASON_CODES.QUANTITY_EXCEEDED,
    (input) => ({
      ...input,
      mandate: {
        ...input.mandate,
        constraints: { ...input.mandate.constraints, maxQuantity: 0 },
      },
    })],
  ['$300 checkout under a $150 mandate', POLICY_REASON_CODES.AMOUNT_EXCEEDS_MANDATE,
    (input) => ({
      ...input,
      mandate: {
        ...input.mandate,
        constraints: { ...input.mandate.constraints, maxTotalMinor: 12_999n },
      },
    })],
  ['different currency', POLICY_REASON_CODES.CURRENCY_NOT_ALLOWED,
    (input) => ({
      ...input,
      mandate: {
        ...input.mandate,
        constraints: { ...input.mandate.constraints, currency: 'MXN' },
      },
    })],
  ['usage exhausted', POLICY_REASON_CODES.USAGE_LIMIT_EXCEEDED,
    (input) => ({
      ...input,
      priorUsage: { ...input.priorUsage, consumedUses: 2 },
    })],
  ['budget exhausted', POLICY_REASON_CODES.BUDGET_EXCEEDED,
    (input) => ({
      ...input,
      priorUsage: { ...input.priorUsage, consumedAmountMinor: 20_000n },
    })],
];

describe('DeterministicMandateEngine', () => {
  const engine = new DeterministicMandateEngine();

  it('allows an authentic $130 VuelaYa checkout under the $150 mandate', () => {
    const result = engine.evaluate(validInput());

    expect(result.decision).toBe('ALLOW');
    expect(result.reasonCode).toBe(POLICY_REASON_CODES.ALL_CONSTRAINTS_SATISFIED);
    expect(result.checks.every((candidate) => candidate.passed)).toBe(true);
  });

  it.each(adversarialCases)('denies %s with a stable reason', (_name, reason, alter) => {
    const result = engine.evaluate(alter(validInput()));

    expect(result.decision).toBe('DENY');
    expect(result.reasonCode).toBe(reason);
    expect(result.checks.some((candidate) =>
      !candidate.passed && candidate.reasonCode === reason)).toBe(true);
  });

  it('requires approval when the mandate calls for final confirmation', () => {
    const input = validInput();
    const result = engine.evaluate({
      ...input,
      mandate: {
        ...input.mandate,
        constraints: { ...input.mandate.constraints, requiresFinalConfirmation: true },
      },
    });

    expect(result.decision).toBe('REQUIRE_HUMAN_APPROVAL');
    expect(result.reasonCode).toBe(POLICY_REASON_CODES.HUMAN_APPROVAL_REQUIRED);
    expect(result.checks.at(-1)?.reasonCode).toBe(POLICY_REASON_CODES.HUMAN_APPROVAL_MISSING);
  });

  it('allows a valid approval bound to the mandate version and checkout hash', () => {
    const input = validInput();
    const result = engine.evaluate({
      ...input,
      mandate: {
        ...input.mandate,
        constraints: { ...input.mandate.constraints, requiresFinalConfirmation: true },
      },
      humanApproval: validApproval(),
    });

    expect(result.decision).toBe('ALLOW');
    expect(result.checks.at(-1)).toMatchObject({ name: 'HUMAN_APPROVAL_VALID', passed: true });
  });

  it.each([
    ['denied', POLICY_REASON_CODES.HUMAN_APPROVAL_DENIED,
      { ...validApproval(), decision: 'DENIED' as const }],
    ['expired', POLICY_REASON_CODES.HUMAN_APPROVAL_EXPIRED,
      { ...validApproval(), expiresAt: NOW }],
    ['wrong checkout', POLICY_REASON_CODES.HUMAN_APPROVAL_MISMATCH,
      { ...validApproval(), checkoutHash: 'sha256:another-checkout' }],
    ['wrong mandate version', POLICY_REASON_CODES.HUMAN_APPROVAL_MISMATCH,
      { ...validApproval(), mandateVersionId: 'mandate-version-0' }],
  ] as const)('denies %s approval evidence', (_name, reason, approval) => {
    const input = validInput();
    const result = engine.evaluate({
      ...input,
      mandate: {
        ...input.mandate,
        constraints: { ...input.mandate.constraints, requiresFinalConfirmation: true },
      },
      humanApproval: approval,
    });

    expect(result.decision).toBe('DENY');
    expect(result.reasonCode).toBe(reason);
  });

  it('does not let valid human approval override a hard amount failure', () => {
    const input = validInput();
    const result = engine.evaluate({
      ...input,
      mandate: {
        ...input.mandate,
        constraints: {
          ...input.mandate.constraints,
          maxTotalMinor: 12_999n,
          requiresFinalConfirmation: true,
        },
      },
      humanApproval: validApproval(),
    });

    expect(result.decision).toBe('DENY');
    expect(result.reasonCode).toBe(POLICY_REASON_CODES.AMOUNT_EXCEEDS_MANDATE);
  });

  it('returns the same result for the same explicit input without mutating it', () => {
    const input = validInput();
    const before = structuredClone(input);

    expect(engine.evaluate(input)).toEqual(engine.evaluate(input));
    expect(input).toEqual(before);
  });
});
