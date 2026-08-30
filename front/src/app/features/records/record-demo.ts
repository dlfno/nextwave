import { AuditEvent, AuditProjection, DisputeRecord, TransactionDetail } from '../../core/api-client';

export function demoTransaction(): TransactionDetail {
  return { transaction: { id: 'demo', attemptId: 'demo-attempt', provider: 'MOCK_SPT', providerReference: 'mock-pay-84m2q', status: 'SUCCEEDED', amountMinor: '13000', currency: 'USD', failureCode: null, createdAt: new Date(Date.now() - 3600000).toISOString(), processedAt: new Date(Date.now() - 3590000).toISOString() }, order: { id: 'demo-order', merchantOrderId: 'VY-ORDER-84M2Q', status: 'CONFIRMED', totalMinor: '13000', currency: 'USD', createdAt: new Date(Date.now() - 3590000).toISOString(), items: [{ productName: 'Mexico City to Córdoba flight', quantity: 1, totalMinor: '13000', currency: 'USD' }] }, receipt: { id: 'demo-receipt', orderId: 'demo-order', transactionId: 'demo', receiptType: 'ORDER', payloadHash: 'aV7kP2nX9mR4cT8wQ1sF6gH3jL0eD5yB', rawPayload: {}, issuedAt: new Date(Date.now() - 3590000).toISOString() } };
}

export function demoAudit(): AuditProjection {
  const types: [string, string][] = [['PURCHASE_INTENT_CREATED','USER'],['SPECIFICATIONS_FINALIZED','AGENT'],['MANDATE_AUTHORIZED','USER'],['DISCOVERY_COMPLETED','AGENT'],['CHECKOUT_CREATED','MERCHANT'],['MANDATE_EVALUATED','SYSTEM'],['HUMAN_APPROVAL_GRANTED','USER'],['PAYMENT_AUTHORIZATION_CREATED','SYSTEM'],['PAYMENT_CREDENTIAL_ISSUED','PAYMENT_PROVIDER'],['PAYMENT_SUCCEEDED','PAYMENT_PROVIDER'],['ORDER_AND_RECEIPT_CREATED','MERCHANT']];
  const events: AuditEvent[] = types.map(([eventType,actorType],index)=>({ id:`event-${index}`,eventType,actorType,actorId:null,intentId:'demo-intent',mandateId:index>1?'demo-mandate':null,mandateVersionId:index>1?'demo-v1':null,attemptId:index>3?'demo-attempt':null,transactionId:index>8?'demo':null,correlationId:'corr-demo-84m2q',payload:eventType==='MANDATE_EVALUATED'?{decision:'REQUIRE_HUMAN_APPROVAL',reasonCode:'HUMAN_APPROVAL_REQUIRED'}:{},occurredAt:new Date(Date.now()-3600000+index*1300).toISOString(),previousHash:index?`hash-${index-1}`:null,eventHash:`hash-${index}` }));
  return { integrity:{valid:true,eventCount:events.length,failedEventId:null},events };
}

export function demoDispute(): { dispute: DisputeRecord; evidence: { bundle: Record<string, unknown>; bundleHash: string; verificationResult: { valid: boolean; eventCount: number } } } {
  return { dispute:{id:'demo-dispute',transactionId:'demo',status:'EVIDENCE_ASSEMBLED',reasonCode:'PURCHASE_NOT_RECOGNIZED',statement:'I do not recognize this agent purchase.',openedAt:new Date().toISOString()},evidence:{bundle:{mandate:{status:'ACTIVE'},mandateVersion:{version:1},checkout:{total_minor:'13000',currency:'USD'},approval:{decision:'APPROVED'},transaction:{status:'SUCCEEDED'},order:{merchant_order_id:'VY-ORDER-84M2Q'}},bundleHash:'dB8pL2xN5qR9vT1mK4cY7sW3fG0hJ6aE',verificationResult:{valid:true,eventCount:11}} };
}
