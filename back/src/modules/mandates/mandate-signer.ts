import { createHash } from 'node:crypto';

import { canonicalize } from 'json-canonicalize';
import { CompactSign, compactVerify, importJWK, type JWK } from 'jose';

import { HttpError } from '../../shared/http-error.js';

export interface SignedMandateEvidence {
  canonicalPayload: Record<string, unknown>;
  payloadHash: Buffer;
  signedPayload: string;
  signatureAlgorithm: 'ES256';
  signingKeyId: string;
}

export interface MandateSigner {
  sign(payload: Record<string, unknown>): Promise<SignedMandateEvidence>;
  verify(signedPayload: string, payload: Record<string, unknown>): Promise<boolean>;
}

type ImportedKey = Awaited<ReturnType<typeof importJWK>>;

export class Es256MandateSigner implements MandateSigner {
  private constructor(
    private readonly privateKey: ImportedKey,
    private readonly publicKey: ImportedKey,
    private readonly keyId: string,
  ) {}

  static async create(privateJwk: JWK, keyId: string): Promise<Es256MandateSigner> {
    if (!privateJwk.d || privateJwk.kty !== 'EC' || privateJwk.crv !== 'P-256') {
      throw new Error('Mandate signing key must be a private P-256 EC JWK');
    }
    const publicJwk: JWK = { ...privateJwk };
    delete publicJwk.d;
    return new Es256MandateSigner(
      await importJWK(privateJwk, 'ES256'),
      await importJWK(publicJwk, 'ES256'),
      keyId,
    );
  }

  async sign(payload: Record<string, unknown>): Promise<SignedMandateEvidence> {
    const canonicalPayload = JSON.parse(canonicalize(payload)) as Record<string, unknown>;
    const bytes = Buffer.from(canonicalize(canonicalPayload), 'utf8');
    const signedPayload = await new CompactSign(bytes)
      .setProtectedHeader({ alg: 'ES256', kid: this.keyId, typ: 'application/nextwave-mandate+jws' })
      .sign(this.privateKey);

    return {
      canonicalPayload,
      payloadHash: createHash('sha256').update(bytes).digest(),
      signedPayload,
      signatureAlgorithm: 'ES256',
      signingKeyId: this.keyId,
    };
  }

  async verify(signedPayload: string, payload: Record<string, unknown>): Promise<boolean> {
    try {
      const verified = await compactVerify(signedPayload, this.publicKey, { algorithms: ['ES256'] });
      return verified.protectedHeader.typ === 'application/nextwave-mandate+jws' &&
        Buffer.from(verified.payload).equals(Buffer.from(canonicalize(payload), 'utf8'));
    } catch {
      return false;
    }
  }
}

export class UnavailableMandateSigner implements MandateSigner {
  async sign(): Promise<never> {
    throw new HttpError(503, 'MANDATE_SIGNER_UNAVAILABLE', 'Mandate signing is not configured');
  }

  async verify(): Promise<boolean> {
    return false;
  }
}
