import { exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  Ap2CredentialIssuer,
  ap2CredentialHash,
  ap2OpenCheckoutMandateSchema,
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
});
