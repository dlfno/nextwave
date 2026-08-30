import { exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  Ap2CredentialIssuer,
  ap2CheckoutHash,
  ap2CheckoutMandateSchema,
  ap2CredentialHash,
  ap2OpenCheckoutMandateSchema,
  ap2PaymentMandateSchema,
  ap2TransactionAuthorizationSchema,
} from '../src/modules/mandates/ap2-credential.js';

describe('AP2 delegation credential', () => {
  it('issues a verifiable SD-JWT delegation with an agent key binding', async () => {
    const trusted = await generateKeyPair('ES256', { extractable: true });
    const agent = await generateKeyPair('ES256', { extractable: true });
    const issuer = await Ap2CredentialIssuer.create(
      await exportJWK(trusted.privateKey), 'trusted-key-1', 'urn:nextwave:trusted-agent-provider',
    );
    const agentIssuer = await Ap2CredentialIssuer.create(
      await exportJWK(agent.privateKey), 'agent-key-1', 'urn:nextwave:shopping-agent',
    );
    const content = ap2OpenCheckoutMandateSchema.parse({
      vct: 'mandate.checkout.open.1',
      constraints: [{
        type: 'com.nextwave.checkout.flight.1', category: 'travel.flight',
        origin_iata: 'MEX', destination_iata: 'COR', departure_date: '2026-09-15', quantity: 1,
      }],
      cnf: { jwk: agentIssuer.publicJwk() },
      iat: 1_788_000_000,
      exp: 1_790_000_000,
    });

    const evidence = await issuer.issueDelegation(content, new Date('2026-09-20T00:00:00Z'));
    expect(evidence.compact.split('~')).toHaveLength(3);
    expect(await issuer.verifyDelegation(evidence.compact, content)).toBe(true);
    expect(await issuer.verifyDelegation(evidence.compact, {
      ...content, constraints: [{ ...content.constraints[0], quantity: 2 }],
    })).toBe(false);
    expect(ap2CredentialHash(evidence.compact)).toBe(evidence.hash.toString('base64url'));
  });

  it('binds closed checkout and payment mandates to the exact merchant checkout JWT', async () => {
    const agent = await generateKeyPair('ES256', { extractable: true });
    const issuer = await Ap2CredentialIssuer.create(
      await exportJWK(agent.privateKey), 'agent-key-1', 'urn:nextwave:shopping-agent',
    );
    const checkoutJwt = 'merchant-signed.checkout.jwt';
    const checkoutHash = ap2CheckoutHash(checkoutJwt);
    const checkout = ap2CheckoutMandateSchema.parse({
      vct: 'mandate.checkout.1', checkout_jwt: checkoutJwt, checkout_hash: checkoutHash,
      iat: 1_788_000_000, exp: 1_788_000_060,
    });
    const payment = ap2PaymentMandateSchema.parse({
      vct: 'mandate.payment.1', transaction_id: checkoutHash,
      payee: { id: 'merchant-1', name: 'VuelaYa' },
      payment_amount: { amount: 13_000, currency: 'USD' },
      payment_instrument: { id: 'wallet-1', type: 'mock_constrained_token' },
      execution_date: '2026-08-29T12:00:00.000Z', iat: 1_788_000_000, exp: 1_788_000_060,
    });
    const authorization = ap2TransactionAuthorizationSchema.parse({
      type: 'delegate', format: 'dc+sd-jwt', delegate_payload: [checkout, payment],
    });
    const evidence = await issuer.issueDelegation(authorization, new Date('2026-08-29T12:01:00Z'));

    expect(payment.transaction_id).toBe(checkout.checkout_hash);
    expect(await issuer.verifyDelegation(evidence.compact, authorization)).toBe(true);
    expect(ap2CheckoutHash(`${checkoutJwt}.tampered`)).not.toBe(checkoutHash);
  });
});
