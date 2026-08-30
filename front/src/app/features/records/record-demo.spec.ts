import { demoAudit, demoDispute, demoTransaction } from './record-demo';

describe('record evidence projections', () => {
  it('links every audit event to the previous event hash', () => {
    const audit = demoAudit();
    expect(audit.integrity.valid).toBeTrue();
    expect(audit.integrity.eventCount).toBe(audit.events.length);
    audit.events.slice(1).forEach((event, index) => expect(event.previousHash).toBe(audit.events[index].eventHash));
  });

  it('binds the receipt to the completed transaction and order', () => {
    const detail = demoTransaction();
    expect(detail.transaction.status).toBe('SUCCEEDED');
    expect(detail.order?.status).toBe('CONFIRMED');
    expect(detail.receipt?.transactionId).toBe(detail.transaction.id);
    expect(detail.receipt?.orderId).toBe(detail.order?.id);
  });

  it('assembles a verified dispute bundle without raw credential secrets', () => {
    const { evidence } = demoDispute();
    expect(evidence.verificationResult.valid).toBeTrue();
    expect(evidence.bundleHash).toBeTruthy();
    expect(JSON.stringify(evidence.bundle)).not.toContain('token_hash');
    expect(JSON.stringify(evidence.bundle)).not.toContain('signed_payload');
  });
});
