export interface ApprovalPayloadInput {
  readonly approvalId: string;
  readonly attemptId: string;
  readonly userId: string;
  readonly mandateVersionId: string;
  readonly checkoutId: string;
  readonly checkoutHash: string;
  readonly decision: 'APPROVED' | 'DENIED';
  readonly decidedAt: Date;
  readonly expiresAt: Date;
}

export function approvalPayload(input: ApprovalPayloadInput): Record<string, unknown> {
  return {
    vct: 'com.nextwave.human-checkout-approval.1',
    approvalId: input.approvalId,
    attemptId: input.attemptId,
    userId: input.userId,
    mandateVersionId: input.mandateVersionId,
    checkoutId: input.checkoutId,
    checkoutHash: input.checkoutHash,
    decision: input.decision,
    decidedAt: input.decidedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  };
}
