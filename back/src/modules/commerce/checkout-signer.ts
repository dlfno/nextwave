import { createHash } from 'node:crypto';

import { canonicalize } from 'json-canonicalize';
import { CompactSign, compactVerify, importJWK, FlattenedSign, flattenedVerify, type JWK } from 'jose';

export interface CheckoutSignature {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadHash: Buffer;
  readonly signedPayload: string;
}

export interface CheckoutSigner {
  sign(payload: Record<string, unknown>): Promise<CheckoutSignature>;
  verify(signedPayload: string, payload: Readonly<Record<string, unknown>>): Promise<boolean>;
  signDetached(payload: Record<string, unknown>): Promise<string>;
  verifyDetached(signature: string, payload: Readonly<Record<string, unknown>>): Promise<boolean>;
  publicJwk(): Readonly<Record<string, unknown>>;
}

type ImportedKey = Awaited<ReturnType<typeof importJWK>>;

export class Es256CheckoutSigner implements CheckoutSigner {
  private constructor(
    private readonly privateKey: ImportedKey,
    private readonly publicKey: ImportedKey,
    private readonly publicJwkValue: JWK,
    private readonly keyId: string,
  ) {}

  static async create(privateJwk: JWK, keyId: string): Promise<Es256CheckoutSigner> {
    if (!privateJwk.d || privateJwk.kty !== 'EC' || privateJwk.crv !== 'P-256') {
      throw new Error('Checkout signing key must be a private P-256 EC JWK');
    }
    const publicJwk: JWK = { ...privateJwk, kid: keyId, alg: 'ES256', use: 'sig' };
    delete publicJwk.d;
    return new Es256CheckoutSigner(
      await importJWK(privateJwk, 'ES256'),
      await importJWK(publicJwk, 'ES256'), publicJwk,
      keyId,
    );
  }

  publicJwk(): Readonly<Record<string, unknown>> {
    return { ...this.publicJwkValue };
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

  async signDetached(payload: Record<string, unknown>): Promise<string> {
    const bytes = Buffer.from(canonicalize(payload), 'utf8');
    const signature = await new FlattenedSign(bytes)
      .setProtectedHeader({ alg: 'ES256', kid: this.keyId })
      .sign(this.privateKey);
    return `${signature.protected}..${signature.signature}`;
  }

  async verifyDetached(signature: string, payload: Readonly<Record<string, unknown>>): Promise<boolean> {
    try {
      const [protectedHeader, emptyPayload, encodedSignature] = signature.split('.');
      if (!protectedHeader || emptyPayload !== '' || !encodedSignature) return false;
      const verified = await flattenedVerify({
        protected: protectedHeader,
        payload: Buffer.from(canonicalize(payload), 'utf8').toString('base64url'),
        signature: encodedSignature,
      }, this.publicKey, { algorithms: ['ES256'] });
      return verified.protectedHeader?.kid === this.keyId;
    } catch {
      return false;
    }
  }
}
