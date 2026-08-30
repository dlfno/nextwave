import { exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';

import { Es256CheckoutSigner } from '../src/modules/commerce/checkout-signer.js';

describe('Es256CheckoutSigner', () => {
  it('verifies only the exact canonical checkout payload', async () => {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const signer = await Es256CheckoutSigner.create(await exportJWK(privateKey), 'merchant-key-1');
    const evidence = await signer.sign({ amount: '13000', merchantId: 'vuela-ya' });

    expect(await signer.verify(evidence.signedPayload, evidence.payload)).toBe(true);
    expect(await signer.verify(evidence.signedPayload, { ...evidence.payload, amount: '30000' })).toBe(false);
    const detached = await signer.signDetached(evidence.payload);
    expect(await signer.verifyDetached(detached, evidence.payload)).toBe(true);
    expect(await signer.verifyDetached(detached, { ...evidence.payload, amount: '30000' })).toBe(false);
  });
});
