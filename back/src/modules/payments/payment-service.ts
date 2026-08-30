import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type { DatabaseClient } from '../../database/client.js';
import { AuditService } from '../audit/audit-service.js';
import {
  checkoutLineItems,
  checkoutSessions,
  mandateUsageReservations,
  mandates,
  merchants,
  orderItems,
  orders,
  paymentAuthorizations,
  paymentCredentials,
  purchaseAttempts,
  purchaseIntents,
  receipts,
  transactions,
} from '../../database/schema.js';
import { HttpError } from '../../shared/http-error.js';
import { PurchaseAuthorizationService } from '../authorization/purchase-authorization-service.js';
import type { CommerceProvider } from '../commerce/commerce-types.js';
import type { MandateSigner } from '../mandates/mandate-signer.js';
import {
  ap2CheckoutHash,
  ap2CheckoutMandateSchema,
  ap2PaymentMandateSchema,
  ap2TransactionAuthorizationSchema,
  type Ap2CredentialIssuer,
} from '../mandates/ap2-credential.js';
import type { PaymentCredentialProvider } from './payment-types.js';

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === '23505') return true;
  return 'cause' in error && isUniqueViolation(error.cause);
}

export class PaymentService {
  private readonly commerceProviders: ReadonlyMap<string, CommerceProvider>;
  private readonly authorization: PurchaseAuthorizationService;
  private readonly audit: AuditService;

  constructor(
    private readonly database: DatabaseClient,
    private readonly mandateSigner: MandateSigner,
    commerceProviders: readonly CommerceProvider[],
    private readonly credentialProvider: PaymentCredentialProvider,
    private readonly ap2TrustedIssuer?: Ap2CredentialIssuer,
    private readonly ap2AgentIssuer?: Ap2CredentialIssuer,
  ) {
    this.commerceProviders = new Map(commerceProviders.map((provider) => [provider.merchantId, provider]));
    this.authorization = new PurchaseAuthorizationService(database, mandateSigner, commerceProviders);
    this.audit = new AuditService(database);
  }

  async execute(userId: string, attemptId: string) {
    const existing = await this.existingResult(userId, attemptId);
    if (existing) return existing;

    const decision = await this.authorization.evaluate(userId, attemptId);
    if (decision.decision !== 'ALLOW') {
      throw new HttpError(409, decision.reasonCode,
        decision.decision === 'REQUIRE_HUMAN_APPROVAL'
          ? 'Human approval is required before payment'
          : 'Purchase is outside the mandate');
    }
    const loaded = await this.load(userId, attemptId);
    const commerceProvider = this.commerceProviders.get(loaded.checkout.merchantId);
    if (!commerceProvider) {
      throw new HttpError(503, 'COMMERCE_PROVIDER_UNAVAILABLE', 'Commerce provider is unavailable');
    }

    const issuedAt = new Date();
    const expiresAt = new Date(Math.min(loaded.checkout.expiresAt.getTime(), issuedAt.getTime() + 60_000));
    if (expiresAt.getTime() <= issuedAt.getTime()) {
      throw new HttpError(409, 'CHECKOUT_EXPIRED', 'Checkout expired before credential issuance');
    }
    const authorizationId = randomUUID();
    const credentialId = randomUUID();
    const transactionId = randomUUID();
    const ap2Issuer = loaded.mandate.mode === 'AUTONOMOUS' ? this.ap2AgentIssuer : this.ap2TrustedIssuer;
    if (!ap2Issuer) {
      throw new HttpError(503, 'AP2_ISSUER_UNAVAILABLE', 'AP2 transaction authorization is unavailable');
    }
    const amount = Number(loaded.checkout.totalMinor);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new HttpError(422, 'AP2_AMOUNT_UNSUPPORTED', 'Checkout amount cannot be represented in an AP2 mandate');
    }
    const checkoutHash = ap2CheckoutHash(loaded.checkout.signedCheckout);
    const issuedAtSeconds = Math.floor(issuedAt.getTime() / 1_000);
    const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1_000);
    const ap2CheckoutMandate = ap2CheckoutMandateSchema.parse({
      vct: 'mandate.checkout.1',
      checkout_jwt: loaded.checkout.signedCheckout,
      checkout_hash: checkoutHash,
      iat: issuedAtSeconds,
      exp: expiresAtSeconds,
    });
    const ap2PaymentMandate = ap2PaymentMandateSchema.parse({
      vct: 'mandate.payment.1',
      transaction_id: checkoutHash,
      payee: { id: loaded.merchant.id, name: loaded.merchant.name },
      payment_amount: { amount, currency: loaded.checkout.currency },
      payment_instrument: this.credentialProvider.paymentInstrument(),
      execution_date: issuedAt.toISOString(),
      iat: issuedAtSeconds,
      exp: expiresAtSeconds,
    });
    const ap2Authorization = ap2TransactionAuthorizationSchema.parse({
      type: 'delegate', format: 'dc+sd-jwt',
      delegate_payload: [ap2CheckoutMandate, ap2PaymentMandate],
    });
    const ap2Presentation = await ap2Issuer.issueDelegation(ap2Authorization, expiresAt);
    if (!await ap2Issuer.verifyDelegation(ap2Presentation.compact, ap2Authorization)) {
      throw new HttpError(500, 'AP2_PRESENTATION_INVALID', 'Generated AP2 transaction authorization failed verification');
    }
    const paymentAuthorization = {
      id: authorizationId,
      attemptId,
      checkoutId: loaded.checkout.id,
      checkoutHash: loaded.checkout.checkoutHash.toString('base64url'),
      mandateVersionId: loaded.attempt.mandateVersionId,
      merchantId: loaded.checkout.merchantId,
      amountMinor: loaded.checkout.totalMinor,
      currency: loaded.checkout.currency,
      issuedAt,
      expiresAt,
      ap2Presentation: ap2Presentation.compact,
      ap2PresentationHash: ap2Presentation.hash.toString('base64url'),
    };
    const signedAuthorization = await this.mandateSigner.sign({
      vct: 'com.nextwave.payment-authorization.1',
      id: authorizationId,
      attemptId,
      checkoutId: loaded.checkout.id,
      checkoutHash: paymentAuthorization.checkoutHash,
      mandateVersionId: loaded.attempt.mandateVersionId,
      merchantId: loaded.checkout.merchantId,
      amountMinor: loaded.checkout.totalMinor.toString(),
      currency: loaded.checkout.currency,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    const credentialCheckout = {
      id: loaded.checkout.id,
      merchantId: loaded.checkout.merchantId,
      amountMinor: loaded.checkout.totalMinor,
      currency: loaded.checkout.currency,
      expiresAt: loaded.checkout.expiresAt,
    };
    const credential = await this.credentialProvider.issueCredential(paymentAuthorization, credentialCheckout);

    try {
      await this.database.db.transaction(async (transaction) => {
        await transaction.insert(paymentAuthorizations).values({
          id: authorizationId,
          attemptId,
          checkoutId: loaded.checkout.id,
          checkoutHash: loaded.checkout.checkoutHash,
          mandateVersionId: loaded.attempt.mandateVersionId,
          merchantId: loaded.checkout.merchantId,
          amountMinor: loaded.checkout.totalMinor,
          currency: loaded.checkout.currency,
          signedPayload: signedAuthorization.signedPayload,
          payloadHash: signedAuthorization.payloadHash,
          ap2CheckoutMandatePayload: ap2CheckoutMandate,
          ap2PaymentMandatePayload: ap2PaymentMandate,
          ap2Presentation: ap2Presentation.compact,
          ap2PresentationHash: ap2Presentation.hash,
          issuedAt,
          expiresAt,
        });
        await transaction.insert(paymentCredentials).values({
          id: credentialId,
          paymentAuthorizationId: authorizationId,
          provider: credential.provider,
          providerReference: credential.providerReference,
          tokenHash: credential.tokenHash,
          merchantId: credential.merchantId,
          checkoutId: credential.checkoutId,
          maxAmountMinor: credential.maxAmountMinor,
          currency: credential.currency,
          status: 'ISSUED',
          issuedAt: credential.issuedAt,
          expiresAt: credential.expiresAt,
        });
        await transaction.insert(transactions).values({
          id: transactionId,
          attemptId,
          credentialId,
          provider: credential.provider,
          status: 'PENDING',
          amountMinor: loaded.checkout.totalMinor,
          currency: loaded.checkout.currency,
        });
        await transaction.insert(mandateUsageReservations).values({
          mandateVersionId: loaded.attempt.mandateVersionId,
          attemptId,
          amountMinor: loaded.checkout.totalMinor,
          status: 'RESERVED',
          reservedAt: issuedAt,
          expiresAt,
        });
        await transaction.update(purchaseAttempts).set({ status: 'CREDENTIAL_ISSUED', updatedAt: issuedAt })
          .where(eq(purchaseAttempts.id, attemptId));
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, 'PAYMENT_EXECUTION_ALREADY_STARTED', 'Payment execution already started');
      }
      throw error;
    }

    try {
      const payment = await this.credentialProvider.consumeCredential(credential, credentialCheckout, new Date());
      const completion = await commerceProvider.completeCheckout({
        providerCheckoutId: loaded.checkout.providerCheckoutId,
        checkoutId: loaded.checkout.id,
        merchantId: loaded.checkout.merchantId,
        amountMinor: loaded.checkout.totalMinor,
        currency: loaded.checkout.currency,
        credentialProvider: credential.provider,
        credentialReference: credential.providerReference,
        ap2CheckoutMandate: ap2Presentation.compact,
      });
      const orderId = randomUUID();
      const receiptId = randomUUID();
      const receiptPayload = {
        vct: 'com.nextwave.order-receipt.1',
        receiptId,
        orderId,
        transactionId,
        attemptId,
        merchantOrderId: completion.merchantOrderId,
        merchantId: loaded.checkout.merchantId,
        checkoutId: loaded.checkout.id,
        checkoutHash: loaded.checkout.checkoutHash.toString('base64url'),
        mandateVersionId: loaded.attempt.mandateVersionId,
        totalMinor: loaded.checkout.totalMinor.toString(),
        currency: loaded.checkout.currency,
        issuedAt: payment.processedAt.toISOString(),
      };
      const signedReceipt = await this.mandateSigner.sign(receiptPayload);

      await this.database.db.transaction(async (transaction) => {
        await transaction.update(paymentCredentials).set({ status: 'CONSUMED', consumedAt: payment.processedAt })
          .where(and(eq(paymentCredentials.id, credentialId), eq(paymentCredentials.status, 'ISSUED')));
        await transaction.update(transactions).set({
          status: 'SUCCEEDED', providerReference: payment.providerReference, processedAt: payment.processedAt,
        }).where(eq(transactions.id, transactionId));
        await transaction.insert(orders).values({
          id: orderId,
          transactionId,
          merchantId: loaded.checkout.merchantId,
          merchantOrderId: completion.merchantOrderId,
          status: 'CONFIRMED',
          totalMinor: loaded.checkout.totalMinor,
          currency: loaded.checkout.currency,
          createdAt: completion.completedAt,
          updatedAt: completion.completedAt,
        });
        await transaction.insert(orderItems).values(loaded.lineItems.map((item) => ({
          orderId,
          merchantProductId: item.merchantProductId,
          productId: item.productId,
          productName: item.productName,
          category: item.category,
          quantity: item.quantity,
          unitPriceMinor: item.unitPriceMinor,
          totalMinor: item.totalMinor,
          currency: item.currency,
        })));
        await transaction.insert(receipts).values({
          id: receiptId,
          orderId,
          transactionId,
          receiptType: 'ORDER',
          signedPayload: signedReceipt.signedPayload,
          payloadHash: signedReceipt.payloadHash,
          rawPayload: signedReceipt.canonicalPayload,
          issuedAt: payment.processedAt,
        });
        await transaction.update(mandateUsageReservations).set({ status: 'CONSUMED', consumedAt: payment.processedAt })
          .where(eq(mandateUsageReservations.attemptId, attemptId));
        await transaction.update(checkoutSessions).set({ status: 'COMPLETED', completedAt: completion.completedAt })
          .where(eq(checkoutSessions.id, loaded.checkout.id));
        await transaction.update(purchaseAttempts).set({ status: 'SUCCEEDED', updatedAt: completion.completedAt })
          .where(eq(purchaseAttempts.id, attemptId));
        await transaction.update(purchaseIntents).set({ status: 'COMPLETED', updatedAt: completion.completedAt })
          .where(eq(purchaseIntents.id, loaded.attempt.intentId));
      });
      const auditBase = {
        intentId: loaded.attempt.intentId,
        mandateId: loaded.attempt.mandateId,
        mandateVersionId: loaded.attempt.mandateVersionId,
        attemptId,
        transactionId,
        correlationId: loaded.attempt.correlationId,
      };
      await this.audit.append({
        ...auditBase,
        eventType: 'PAYMENT_AUTHORIZATION_CREATED', actorType: 'SYSTEM',
        payload: {
          paymentAuthorizationId: authorizationId, checkoutId: loaded.checkout.id,
          checkoutHash: paymentAuthorization.checkoutHash,
          merchantId: loaded.checkout.merchantId, amountMinor: loaded.checkout.totalMinor.toString(),
          currency: loaded.checkout.currency, expiresAt: expiresAt.toISOString(),
          ap2CheckoutHash: checkoutHash,
          ap2PresentationHash: ap2Presentation.hash.toString('base64url'),
        },
      });
      await this.audit.append({
        ...auditBase,
        eventType: 'PAYMENT_CREDENTIAL_ISSUED', actorType: 'PAYMENT_PROVIDER',
        payload: {
          credentialId, provider: credential.provider, providerReference: credential.providerReference,
          merchantId: credential.merchantId, checkoutId: credential.checkoutId,
          maxAmountMinor: credential.maxAmountMinor.toString(), currency: credential.currency,
          expiresAt: credential.expiresAt.toISOString(),
        },
      });
      await this.audit.append({
        ...auditBase,
        eventType: 'PAYMENT_SUCCEEDED', actorType: 'PAYMENT_PROVIDER',
        payload: { provider: credential.provider, providerReference: payment.providerReference },
      });
      await this.audit.append({
        ...auditBase,
        eventType: 'ORDER_AND_RECEIPT_CREATED', actorType: 'MERCHANT',
        payload: {
          orderId, merchantOrderId: completion.merchantOrderId, receiptId,
          totalMinor: loaded.checkout.totalMinor.toString(), currency: loaded.checkout.currency,
          receiptHash: signedReceipt.payloadHash.toString('base64url'),
        },
      });
      return (await this.existingResult(userId, attemptId))!;
    } catch (error) {
      const failedAt = new Date();
      await this.database.db.transaction(async (transaction) => {
        await transaction.update(paymentCredentials).set({ status: 'REVOKED', revokedAt: failedAt })
          .where(and(eq(paymentCredentials.id, credentialId), eq(paymentCredentials.status, 'ISSUED')));
        await transaction.update(transactions).set({ status: 'FAILED', failureCode: 'PAYMENT_FAILED', processedAt: failedAt })
          .where(eq(transactions.id, transactionId));
        await transaction.update(mandateUsageReservations).set({ status: 'RELEASED', releasedAt: failedAt })
          .where(eq(mandateUsageReservations.attemptId, attemptId));
        await transaction.update(purchaseAttempts).set({ status: 'FAILED', reasonCode: 'PAYMENT_FAILED', updatedAt: failedAt })
          .where(eq(purchaseAttempts.id, attemptId));
      });
      throw error;
    }
  }

  private async existingResult(userId: string, attemptId: string) {
    const [record] = await this.database.db.select({
      transaction: transactions,
      order: orders,
      receipt: receipts,
      credential: paymentCredentials,
    }).from(transactions)
      .innerJoin(purchaseAttempts, eq(purchaseAttempts.id, transactions.attemptId))
      .innerJoin(purchaseIntents, eq(purchaseIntents.id, purchaseAttempts.intentId))
      .leftJoin(paymentCredentials, eq(paymentCredentials.id, transactions.credentialId))
      .leftJoin(orders, eq(orders.transactionId, transactions.id))
      .leftJoin(receipts, eq(receipts.transactionId, transactions.id))
      .where(and(eq(transactions.attemptId, attemptId), eq(purchaseIntents.userId, userId))).limit(1);
    if (!record) return undefined;
    if (record.transaction.status !== 'SUCCEEDED' || !record.order || !record.receipt || !record.credential) {
      throw new HttpError(409, 'PAYMENT_EXECUTION_ALREADY_STARTED', 'Payment execution already started');
    }
    const items = await this.database.db.select().from(orderItems).where(eq(orderItems.orderId, record.order.id));
    return {
      transaction: { ...record.transaction, amountMinor: record.transaction.amountMinor.toString() },
      order: { ...this.money(record.order), items: items.map((item) => ({
        ...this.money(item), unitPriceMinor: item.unitPriceMinor.toString(),
      })) },
      receipt: { ...record.receipt, payloadHash: record.receipt.payloadHash.toString('base64url') },
      credential: {
        id: record.credential.id,
        provider: record.credential.provider,
        providerReference: record.credential.providerReference,
        merchantId: record.credential.merchantId,
        checkoutId: record.credential.checkoutId,
        maxAmountMinor: record.credential.maxAmountMinor.toString(),
        currency: record.credential.currency,
        status: record.credential.status,
        issuedAt: record.credential.issuedAt,
        expiresAt: record.credential.expiresAt,
      },
    };
  }

  private async load(userId: string, attemptId: string) {
    const [record] = await this.database.db.select({
      attempt: purchaseAttempts, checkout: checkoutSessions, mandate: mandates, merchant: merchants,
    })
      .from(purchaseAttempts).innerJoin(purchaseIntents, eq(purchaseIntents.id, purchaseAttempts.intentId))
      .innerJoin(checkoutSessions, eq(checkoutSessions.attemptId, purchaseAttempts.id))
      .innerJoin(mandates, eq(mandates.id, purchaseAttempts.mandateId))
      .innerJoin(merchants, eq(merchants.id, checkoutSessions.merchantId))
      .where(and(eq(purchaseAttempts.id, attemptId), eq(purchaseIntents.userId, userId))).limit(1);
    if (!record) throw new HttpError(404, 'PURCHASE_ATTEMPT_NOT_FOUND', 'Purchase attempt not found');
    const lineItems = await this.database.db.select().from(checkoutLineItems)
      .where(eq(checkoutLineItems.checkoutId, record.checkout.id));
    return { ...record, lineItems };
  }

  private money<T extends { totalMinor: bigint }>(record: T) {
    return { ...record, totalMinor: record.totalMinor.toString() };
  }
}
