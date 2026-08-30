import { createHash } from 'node:crypto';

import { canonicalize } from 'json-canonicalize';
import { CompactSign, compactVerify, importJWK, type JWK } from 'jose';

export interface CheckoutSignature {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadHash: Buffer;
  readonly signedPayload: string;
}

export interface CheckoutSigner {
  sign(payload: Record<string, unknown>): Promise<CheckoutSignature>;
  verify(signedPayload: string, payload: Readonly<Record<string, unknown>>): Promise<boolean>;
}

type ImportedKey = Awaited<ReturnType<typeof importJWK>>;

export class Es256CheckoutSigner implements CheckoutSigner {
  private constructor(
    private readonly privateKey: ImportedKey,
    private readonly publicKey: ImportedKey,
    private readonly keyId: string,
  ) {}

  static async create(privateJwk: JWK, keyId: string): Promise<Es256CheckoutSigner> {
    if (!privateJwk.d || privateJwk.kty !== 'EC' || privateJwk.crv !== 'P-256') {
      throw new Error('Checkout signing key must be a private P-256 EC JWK');
    }
    const publicJwk: JWK = { ...privateJwk };
    delete publicJwk.d;
    return new Es256CheckoutSigner(
      await importJWK(privateJwk, 'ES256'),
      await importJWK(publicJwk, 'ES256'),
      keyId,
    );
  }

  async sign(payload: Record<string, unknown>): Promise<CheckoutSignature> {
    const canonicalPayload = JSON.parse(canonicalize(payload)) as Record<string, unknown>;
    const bytes = Buffer.from(canonicalize(canonicalPayload), 'utf8');
    return {
      payload: canonicalPayload,
      payloadHash: createHash('sha256').update(bytes).digest(),
      signedPayload: await new CompactSign(bytes)
        .setProtectedHeader({ alg: 'ES256', kid: this.keyId, typ: 'application/nextwave-checkout+jws' })
        .sign(this.privateKey),
    };
  }

  async verify(signedPayload: string, payload: Readonly<Record<string, unknown>>): Promise<boolean> {
    try {
      const verified = await compactVerify(signedPayload, this.publicKey, { algorithms: ['ES256'] });
      return verified.protectedHeader.typ === 'application/nextwave-checkout+jws'
        && Buffer.from(verified.payload).equals(Buffer.from(canonicalize(payload), 'utf8'));
    } catch {
      return false;
    }
  }
}
