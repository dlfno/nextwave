import type { PolicyReasonCode } from './reason-codes.js';

export type MandateDecisionType = 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN_APPROVAL';

export type MandateStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'SUPERSEDED'
  | 'REVOKED'
  | 'EXPIRED'
  | 'CANCELLED';

export type CheckoutStatus = 'READY' | 'COMPLETED' | 'CANCELLED' | 'FAILED';

export interface MandateConstraints {
  readonly maxTotalMinor: bigint;
  readonly currency: string;
  readonly allowedMerchantIds: 'ANY' | readonly string[];
  readonly allowedCategoryPrefixes: readonly string[];
  readonly allowedProductIds?: readonly string[];
  readonly allowedProductNames?: readonly string[];
  readonly maxQuantity: number;
  readonly maxUses?: number;
  readonly budgetMinor?: bigint;
  readonly requiresFinalConfirmation: boolean;
}

export interface EvaluatedMandate {
  readonly id: string;
  readonly versionId: string;
  readonly version: number;
  readonly signatureValid: boolean;
  readonly authorizedAgentId: string;
  readonly status: MandateStatus;
  readonly validFrom: Date;
  readonly validUntil: Date;
  readonly constraints: MandateConstraints;
}

export interface CheckoutLineItem {
  readonly productId?: string;
  readonly productName: string;
  readonly category: string;
  readonly quantity: number;
  readonly unitPriceMinor: bigint;
  readonly totalMinor: bigint;
  readonly currency: string;
}

export interface EvaluatedCheckout {
  readonly id: string;
  readonly hash: string;
  readonly signatureValid: boolean;
  readonly status: CheckoutStatus;
  readonly alreadyUsed: boolean;
  readonly mandateId: string;
  readonly mandateVersionId: string;
  readonly selectedOfferId: string;
  readonly quoteId: string;
  readonly merchantId: string;
  readonly totalMinor: bigint;
  readonly currency: string;
  readonly expiresAt: Date;
  readonly lineItems: readonly CheckoutLineItem[];
}

export interface PurchaseContext {
  readonly mandateId: string;
  readonly mandateVersionId: string;
  readonly selectedOfferId: string;
  readonly quoteId: string;
  readonly merchantId: string;
  readonly expectedTotalMinor: bigint;
  readonly expectedCurrency: string;
}

export interface PriorUsage {
  readonly consumedUses: number;
  readonly reservedUses: number;
  readonly consumedAmountMinor: bigint;
  readonly reservedAmountMinor: bigint;
}

export interface HumanApprovalEvidence {
  readonly decision: 'APPROVED' | 'DENIED';
  readonly mandateVersionId: string;
  readonly checkoutHash: string;
  readonly expiresAt: Date;
}

export interface MandateEvaluationInput {
  readonly mandate: EvaluatedMandate;
  readonly checkout: EvaluatedCheckout;
  readonly context: PurchaseContext;
  readonly agentId: string;
  readonly currentTime: Date;
  readonly revokedAt: Date | null;
  readonly priorUsage: PriorUsage;
  readonly humanApproval?: HumanApprovalEvidence;
}

export type PolicyEvidenceValue = string | number | boolean | null;

export interface MandateCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly reasonCode?: PolicyReasonCode;
  readonly evidence?: Readonly<Record<string, PolicyEvidenceValue>>;
}

export interface MandateDecision {
  readonly decision: MandateDecisionType;
  readonly reasonCode: PolicyReasonCode;
  readonly mandateId: string;
  readonly mandateVersion: number;
  readonly checkoutHash: string;
  readonly evaluatedAt: string;
  readonly checks: readonly MandateCheck[];
}

export interface MandateEngine {
  evaluate(input: MandateEvaluationInput): MandateDecision;
}
