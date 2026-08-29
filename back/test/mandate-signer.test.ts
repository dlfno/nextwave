import { exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';

import { Es256MandateSigner } from '../src/modules/mandates/mandate-signer.js';

describe('ES256 mandate evidence', () => {
  it('signs canonical JSON and rejects payload or signature tampering', async () => {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const signer = await Es256MandateSigner.create(await exportJWK(privateKey), 'test-key');
    const payload = {
      version: 1,
      constraints: { currency: 'USD', maxTotalMinor: '15000' },
      authorizedAgent: { id: 'agent-1' },
    };

    const evidence = await signer.sign(payload);
    expect(await signer.verify(evidence.signedPayload, {
      authorizedAgent: { id: 'agent-1' },
      constraints: { maxTotalMinor: '15000', currency: 'USD' },
      version: 1,
    })).toBe(true);
    expect(await signer.verify(evidence.signedPayload, {
      ...payload,
      constraints: { currency: 'USD', maxTotalMinor: '30000' },
    })).toBe(false);

    const parts = evidence.signedPayload.split('.');
    const signature = parts[2]!;
    parts[2] = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    const tamperedSignature = parts.join('.');
    expect(await signer.verify(tamperedSignature, payload)).toBe(false);
  });
});
