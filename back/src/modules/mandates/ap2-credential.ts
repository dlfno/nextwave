import { createHash, randomBytes } from 'node:crypto';

import { canonicalize } from 'json-canonicalize';
import { CompactSign, compactVerify, importJWK, type JWK } from 'jose';
import { z } from 'zod';

const publicJwkSchema = z.object({
  kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string().min(1), y: z.string().min(1),
}).passthrough();

const flightConstraintSchema = z.object({
  type: z.literal('com.nextwave.checkout.flight.1'),
  category: z.literal('travel.flight'),
  origin_iata: z.string().regex(/^[A-Z]{3}$/),
  destination_iata: z.string().regex(/^[A-Z]{3}$/),
  departure_date: z.iso.date(),
  quantity: z.number().int().positive(),
}).strict();

export const ap2OpenCheckoutMandateSchema = z.object({
  vct: z.literal('mandate.checkout.open.1'),
  constraints: z.array(z.union([
    flightConstraintSchema,
    z.object({
      type: z.literal('checkout.allowed_merchants'),
      allowed: z.array(z.object({ id: z.string(), name: z.string(), website: z.string().optional() }).strict()),
    }).strict(),
  ])).min(1),
  cnf: z.object({ jwk: publicJwkSchema }).strict(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
}).strict();

export const ap2OpenPaymentMandateSchema = z.object({
  vct: z.literal('mandate.payment.open.1'),
  constraints: z.array(z.union([
    z.object({
      type: z.literal('payment.amount_range'), currency: z.string().regex(/^[A-Z]{3}$/),
      max: z.number().int().nonnegative(), min: z.number().int().nonnegative().optional(),
    }).strict(),
    z.object({
      type: z.literal('payment.agent_recurrence'), frequency: z.literal('ON_DEMAND'),
      max_occurrences: z.number().int().positive(),
    }).strict(),
    z.object({
      type: z.literal('payment.execution_date'), not_after: z.iso.datetime(),
    }).strict(),
    z.object({
      type: z.literal('payment.reference'), conditional_transaction_id: z.string().min(1),
    }).strict(),
  ])).min(1),
  cnf: z.object({ jwk: publicJwkSchema }).strict(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
}).strict();

const ap2MerchantSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  website: z.string().url().optional(),
}).strict();

const ap2PaymentInstrumentSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  description: z.string().optional(),
}).strict();

export const ap2CheckoutMandateSchema = z.object({
  vct: z.literal('mandate.checkout.1'),
  checkout_jwt: z.string().min(1),
  checkout_hash: z.string().min(1),
  iat: z.number().int().positive().optional(),
  exp: z.number().int().positive().optional(),
}).strict();

export const ap2PaymentMandateSchema = z.object({
  vct: z.literal('mandate.payment.1'),
  transaction_id: z.string().min(1),
  payee: ap2MerchantSchema,
  payment_amount: z.object({
    amount: z.number().int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }).strict(),
  payment_instrument: ap2PaymentInstrumentSchema,
  execution_date: z.iso.datetime().optional(),
  iat: z.number().int().positive().optional(),
  exp: z.number().int().positive().optional(),
}).strict();

export const ap2TransactionAuthorizationSchema = z.object({
  type: z.literal('delegate'),
  format: z.literal('dc+sd-jwt'),
  delegate_payload: z.tuple([ap2CheckoutMandateSchema, ap2PaymentMandateSchema]),
}).strict();

export interface Ap2DelegationEvidence {
  readonly content: Record<string, unknown>;
  readonly compact: string;
  readonly hash: Buffer;
}

type ImportedKey = Awaited<ReturnType<typeof importJWK>>;

export class Ap2CredentialIssuer {
  private constructor(
    private readonly privateKey: ImportedKey,
    private readonly publicKey: ImportedKey,
    private readonly publicJwkValue: JWK,
    private readonly keyId: string,
    private readonly issuer: string,
  ) {}

  static async create(privateJwk: JWK, keyId: string, issuer: string): Promise<Ap2CredentialIssuer> {
    if (!privateJwk.d || privateJwk.kty !== 'EC' || privateJwk.crv !== 'P-256') {
      throw new Error('AP2 signing key must be a private P-256 EC JWK');
    }
    const publicJwk: JWK = { ...privateJwk, kid: keyId, alg: 'ES256', use: 'sig' };
    delete publicJwk.d;
    return new Ap2CredentialIssuer(
      await importJWK(privateJwk, 'ES256'), await importJWK(publicJwk, 'ES256'),
      publicJwk, keyId, issuer,
    );
  }

  publicJwk(): Record<string, unknown> {
    return { ...this.publicJwkValue };
  }

  async issueDelegation(content: Record<string, unknown>, expiresAt: Date): Promise<Ap2DelegationEvidence> {
    const canonicalContent = JSON.parse(canonicalize(content)) as Record<string, unknown>;
    const disclosure = Buffer.from(canonicalize([
      randomBytes(16).toString('base64url'), canonicalContent,
    ]), 'utf8').toString('base64url');
    const digest = createHash('sha256').update(disclosure, 'ascii').digest('base64url');
    const issuedAt = Math.floor(Date.now() / 1_000);
    const issuerPayload = {
      iss: this.issuer, iat: issuedAt, exp: Math.floor(expiresAt.getTime() / 1_000),
      delegate_payload: [{ '...': digest }], _sd_alg: 'sha-256',
    };
    const issuerJwt = await new CompactSign(Buffer.from(canonicalize(issuerPayload), 'utf8'))
      .setProtectedHeader({ alg: 'ES256', kid: this.keyId, typ: 'dc+sd-jwt' })
      .sign(this.privateKey);
    const compact = `${issuerJwt}~${disclosure}~`;
    return {
      content: canonicalContent,
      compact,
      hash: createHash('sha256').update(compact, 'utf8').digest(),
    };
  }

  async verifyDelegation(compact: string, expectedContent: Record<string, unknown>): Promise<boolean> {
    try {
      const [issuerJwt, disclosure, terminator] = compact.split('~');
      if (!issuerJwt || !disclosure || terminator !== '') return false;
      const verified = await compactVerify(issuerJwt, this.publicKey, { algorithms: ['ES256'] });
      if (verified.protectedHeader.typ !== 'dc+sd-jwt') return false;
      const payload = z.object({
        iss: z.literal(this.issuer), iat: z.number().int(), exp: z.number().int(),
        delegate_payload: z.array(z.object({ '...': z.string() }).strict()).length(1),
        _sd_alg: z.literal('sha-256'),
      }).strict().parse(JSON.parse(Buffer.from(verified.payload).toString('utf8')));
      const digest = createHash('sha256').update(disclosure, 'ascii').digest('base64url');
      if (payload.delegate_payload[0]?.['...'] !== digest) return false;
      const decoded = z.tuple([z.string(), z.record(z.string(), z.unknown())])
        .parse(JSON.parse(Buffer.from(disclosure, 'base64url').toString('utf8')));
      return canonicalize(decoded[1]) === canonicalize(expectedContent);
    } catch {
      return false;
    }
  }
}

export function ap2CredentialHash(compact: string): string {
  return createHash('sha256').update(compact, 'utf8').digest('base64url');
}

export function ap2CheckoutHash(checkoutJwt: string): string {
  return createHash('sha256').update(checkoutJwt, 'utf8').digest('base64url');
}
