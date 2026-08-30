import { bigint, boolean, customType, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

const bytea = customType<{ data: Buffer }>({
  dataType: () => 'bytea',
});

export const userRole = pgEnum('user_role', ['HUMAN', 'MERCHANT_OPERATOR', 'AUDITOR', 'ADMIN']);
export const agentStatus = pgEnum('agent_status', ['ACTIVE', 'SUSPENDED', 'REVOKED']);
export const intentStatus = pgEnum('intent_status', [
  'DRAFT',
  'CLARIFYING',
  'READY_FOR_MANDATE',
  'MANDATE_AUTHORIZED',
  'SEARCHING',
  'OFFER_SELECTED',
  'PURCHASING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export const mandateStatus = pgEnum('mandate_status', ['DRAFT', 'ACTIVE', 'REVOKED', 'EXPIRED', 'CANCELLED']);
export const mandateVersionStatus = pgEnum('mandate_version_status', [
  'DRAFT', 'ACTIVE', 'SUPERSEDED', 'REVOKED', 'EXPIRED', 'CANCELLED',
]);
export const mandateMode = pgEnum('mandate_mode', ['HUMAN_PRESENT', 'AUTONOMOUS']);
export const runStatus = pgEnum('run_status', ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']);
export const checkoutStatus = pgEnum('checkout_status', ['CREATED', 'READY', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'FAILED']);
export const purchaseAttemptStatus = pgEnum('purchase_attempt_status', [
  'CREATED', 'QUOTED', 'DENIED', 'APPROVAL_REQUIRED', 'APPROVED', 'AUTHORIZED',
  'CREDENTIAL_ISSUED', 'PAYMENT_SUBMITTED', 'SUCCEEDED', 'FAILED', 'CANCELLED',
]);
export const mandateDecision = pgEnum('mandate_decision', ['ALLOW', 'DENY', 'REQUIRE_HUMAN_APPROVAL']);
export const approvalDecision = pgEnum('approval_decision', ['APPROVED', 'DENIED']);
export const usageReservationStatus = pgEnum('usage_reservation_status', ['RESERVED', 'CONSUMED', 'RELEASED', 'EXPIRED']);
export const paymentCredentialStatus = pgEnum('payment_credential_status', ['ISSUED', 'CONSUMED', 'REVOKED', 'EXPIRED']);
export const transactionStatus = pgEnum('transaction_status', ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
export const orderStatus = pgEnum('order_status', ['CREATED', 'CONFIRMED', 'CANCELLED', 'REFUNDED']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  role: userRole('role').notNull().default('HUMAN'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: bytea('token_hash').notNull().unique(),
  csrfHash: bytea('csrf_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  reauthenticatedAt: timestamp('reauthenticated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerUserId: uuid('owner_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  status: agentStatus('status').notNull().default('ACTIVE'),
  currentKeyId: text('current_key_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const purchaseIntents = pgTable('purchase_intents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  status: intentStatus('status').notNull().default('DRAFT'),
  originalRequest: text('original_request').notNull(),
  searchSpecification: jsonb('search_specification'),
  authorizationSpecification: jsonb('authorization_specification'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const intentMessages = pgTable('intent_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  intentId: uuid('intent_id').notNull().references(() => purchaseIntents.id, { onDelete: 'cascade' }),
  role: text('role').notNull().$type<'USER' | 'AGENT' | 'TOOL' | 'SYSTEM'>(),
  content: text('content').notNull(),
  structuredPayload: jsonb('structured_payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const merchants = pgTable('merchants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: text('status').notNull().$type<'ACTIVE' | 'SUSPENDED' | 'REVOKED'>().default('ACTIVE'),
  publicJwk: jsonb('public_jwk'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  canonicalName: text('canonical_name').notNull(),
  category: text('category').notNull(),
  description: text('description'),
  attributes: jsonb('attributes').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mandates = pgTable('mandates', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  intentId: uuid('intent_id').references(() => purchaseIntents.id),
  status: mandateStatus('status').notNull().default('DRAFT'),
  mode: mandateMode('mode').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  currentVersionId: uuid('current_version_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mandateVersions = pgTable('mandate_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  mandateId: uuid('mandate_id').notNull().references(() => mandates.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  status: mandateVersionStatus('status').notNull().default('DRAFT'),
  maxTotalMinor: bigint('max_total_minor', { mode: 'bigint' }).notNull(),
  currency: customType<{ data: string }>({ dataType: () => 'char(3)' })('currency').notNull(),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
  validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
  requiresFinalConfirmation: boolean('requires_final_confirmation').notNull().default(false),
  maxUses: integer('max_uses'),
  recurrencePeriod: text('recurrence_period'),
  budgetMinor: bigint('budget_minor', { mode: 'bigint' }),
  paymentMethodId: uuid('payment_method_id'),
  allowedMerchantsAny: boolean('allowed_merchants_any').notNull().default(false),
  canonicalPayload: jsonb('canonical_payload').notNull(),
  payloadHash: bytea('payload_hash'),
  signedPayload: text('signed_payload'),
  signatureAlgorithm: text('signature_algorithm'),
  signingKeyId: text('signing_key_id'),
  signedAt: timestamp('signed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mandateProductConstraints = pgTable('mandate_product_constraints', {
  id: uuid('id').primaryKey().defaultRandom(),
  mandateVersionId: uuid('mandate_version_id').notNull().references(() => mandateVersions.id, { onDelete: 'cascade' }),
  matchType: text('match_type').notNull(),
  productId: uuid('product_id'),
  normalizedName: text('normalized_name'),
  categoryPrefix: text('category_prefix'),
  maxQuantity: integer('max_quantity').notNull().default(1),
});

export const mandateRevocations = pgTable('mandate_revocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  mandateId: uuid('mandate_id').notNull().references(() => mandates.id, { onDelete: 'cascade' }),
  revokedByUserId: uuid('revoked_by_user_id').notNull().references(() => users.id),
  revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull().defaultNow(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mandateMerchantAllowlist = pgTable('mandate_merchant_allowlist', {
  mandateVersionId: uuid('mandate_version_id').notNull().references(() => mandateVersions.id, { onDelete: 'cascade' }),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
});

export const discoveryRuns = pgTable('discovery_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  intentId: uuid('intent_id').notNull().references(() => purchaseIntents.id, { onDelete: 'cascade' }),
  status: runStatus('status').notNull().default('PENDING'),
  providerIds: text('provider_ids').array().notNull().default([]),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  failureCode: text('failure_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const offers = pgTable('offers', {
  id: uuid('id').primaryKey().defaultRandom(),
  discoveryRunId: uuid('discovery_run_id').notNull().references(() => discoveryRuns.id, { onDelete: 'cascade' }),
  providerId: text('provider_id').notNull(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  merchantProductId: text('merchant_product_id').notNull(),
  productId: uuid('product_id').references(() => products.id),
  productName: text('product_name').notNull(),
  description: text('description'),
  category: text('category').notNull(),
  unitPriceMinor: bigint('unit_price_minor', { mode: 'bigint' }).notNull(),
  currency: customType<{ data: string }>({ dataType: () => 'char(3)' })('currency').notNull(),
  availability: text('availability').notNull(),
  shippingEstimate: jsonb('shipping_estimate'),
  sourceType: text('source_type').notNull().$type<'UCP' | 'MERCHANT_API' | 'INTERNAL_CATALOG' | 'WEB' | 'MOCK'>(),
  sourceReference: text('source_reference').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  confidence: numeric('confidence', { precision: 5, scale: 4 }).notNull(),
  supportsAuthoritativeCheckout: boolean('supports_authoritative_checkout').notNull().default(false),
  rawPayload: jsonb('raw_payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('offers_run_price_idx').on(table.discoveryRunId, table.currency, table.unitPriceMinor)]);

export const quotes = pgTable('quotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  offerId: uuid('offer_id').notNull().references(() => offers.id),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  providerQuoteId: text('provider_quote_id').notNull(),
  totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
  currency: customType<{ data: string }>({ dataType: () => 'char(3)' })('currency').notNull(),
  payload: jsonb('payload').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const purchaseAttempts = pgTable('purchase_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  intentId: uuid('intent_id').notNull().references(() => purchaseIntents.id),
  mandateId: uuid('mandate_id').notNull().references(() => mandates.id),
  mandateVersionId: uuid('mandate_version_id').notNull().references(() => mandateVersions.id),
  selectedOfferId: uuid('selected_offer_id').notNull().references(() => offers.id),
  quoteId: uuid('quote_id').references(() => quotes.id),
  status: purchaseAttemptStatus('status').notNull().default('CREATED'),
  reasonCode: text('reason_code'),
  correlationId: uuid('correlation_id').notNull().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const checkoutSessions = pgTable('checkout_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  attemptId: uuid('attempt_id').notNull().unique().references(() => purchaseAttempts.id, { onDelete: 'cascade' }),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  providerCheckoutId: text('provider_checkout_id').notNull(),
  status: checkoutStatus('status').notNull().default('CREATED'),
  totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
  currency: customType<{ data: string }>({ dataType: () => 'char(3)' })('currency').notNull(),
  signedCheckout: text('signed_checkout').notNull(),
  checkoutHash: bytea('checkout_hash').notNull().unique(),
  rawPayload: jsonb('raw_payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const checkoutLineItems = pgTable('checkout_line_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  checkoutId: uuid('checkout_id').notNull().references(() => checkoutSessions.id, { onDelete: 'cascade' }),
  merchantProductId: text('merchant_product_id').notNull(),
  productId: uuid('product_id').references(() => products.id),
  productName: text('product_name').notNull(),
  category: text('category').notNull(),
  quantity: integer('quantity').notNull(),
  unitPriceMinor: bigint('unit_price_minor', { mode: 'bigint' }).notNull(),
  totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
  currency: customType<{ data: string }>({ dataType: () => 'char(3)' })('currency').notNull(),
});

export const mandateUsageReservations = pgTable('mandate_usage_reservations', {
  id: uuid('id').primaryKey().defaultRandom(),
  mandateVersionId: uuid('mandate_version_id').notNull().references(() => mandateVersions.id),
  attemptId: uuid('attempt_id').notNull().unique().references(() => purchaseAttempts.id),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  status: usageReservationStatus('status').notNull().default('RESERVED'),
  reservedAt: timestamp('reserved_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
});

export const mandateEvaluations = pgTable('mandate_evaluations', {
  id: uuid('id').primaryKey().defaultRandom(),
  attemptId: uuid('attempt_id').notNull().references(() => purchaseAttempts.id, { onDelete: 'cascade' }),
  mandateVersionId: uuid('mandate_version_id').notNull().references(() => mandateVersions.id),
  checkoutId: uuid('checkout_id').notNull().references(() => checkoutSessions.id),
  decision: mandateDecision('decision').notNull(),
  reasonCode: text('reason_code').notNull(),
  checks: jsonb('checks').notNull(),
  inputHash: bytea('input_hash').notNull(),
  evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const humanApprovals = pgTable('human_approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  attemptId: uuid('attempt_id').notNull().references(() => purchaseAttempts.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  mandateVersionId: uuid('mandate_version_id').notNull().references(() => mandateVersions.id),
  checkoutId: uuid('checkout_id').notNull().references(() => checkoutSessions.id),
  checkoutHash: bytea('checkout_hash').notNull(),
  decision: approvalDecision('decision').notNull(),
  signedEvidence: text('signed_evidence').notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const paymentAuthorizations = pgTable('payment_authorizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  attemptId: uuid('attempt_id').notNull().unique().references(() => purchaseAttempts.id),
  checkoutId: uuid('checkout_id').notNull().unique().references(() => checkoutSessions.id),
  checkoutHash: bytea('checkout_hash').notNull(),
  mandateVersionId: uuid('mandate_version_id').notNull().references(() => mandateVersions.id),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  currency: customType<{ data: string }>({ dataType: () => 'char(3)' })('currency').notNull(),
  signedPayload: text('signed_payload').notNull(),
  payloadHash: bytea('payload_hash').notNull().unique(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const paymentCredentials = pgTable('payment_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  paymentAuthorizationId: uuid('payment_authorization_id').notNull().unique().references(() => paymentAuthorizations.id),
  provider: text('provider').notNull(),
  providerReference: text('provider_reference').notNull(),
  tokenHash: bytea('token_hash').notNull().unique(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  checkoutId: uuid('checkout_id').notNull().unique().references(() => checkoutSessions.id),
  maxAmountMinor: bigint('max_amount_minor', { mode: 'bigint' }).notNull(),
  currency: customType<{ data: string }>({ dataType: () => 'char(3)' })('currency').notNull(),
  status: paymentCredentialStatus('status').notNull().default('ISSUED'),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  attemptId: uuid('attempt_id').notNull().unique().references(() => purchaseAttempts.id),
  credentialId: uuid('credential_id').references(() => paymentCredentials.id),
  provider: text('provider').notNull(),
  providerReference: text('provider_reference'),
  status: transactionStatus('status').notNull().default('PENDING'),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  currency: customType<{ data: string }>({ dataType: () => 'char(3)' })('currency').notNull(),
  failureCode: text('failure_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  transactionId: uuid('transaction_id').notNull().unique().references(() => transactions.id),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id),
  merchantOrderId: text('merchant_order_id').notNull(),
  status: orderStatus('status').notNull().default('CREATED'),
  totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
  currency: customType<{ data: string }>({ dataType: () => 'char(3)' })('currency').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  merchantProductId: text('merchant_product_id').notNull(),
  productId: uuid('product_id').references(() => products.id),
  productName: text('product_name').notNull(),
  category: text('category').notNull(),
  quantity: integer('quantity').notNull(),
  unitPriceMinor: bigint('unit_price_minor', { mode: 'bigint' }).notNull(),
  totalMinor: bigint('total_minor', { mode: 'bigint' }).notNull(),
  currency: customType<{ data: string }>({ dataType: () => 'char(3)' })('currency').notNull(),
});

export const receipts = pgTable('receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  transactionId: uuid('transaction_id').notNull().references(() => transactions.id),
  receiptType: text('receipt_type').notNull().$type<'CHECKOUT' | 'PAYMENT' | 'ORDER'>(),
  signedPayload: text('signed_payload').notNull(),
  payloadHash: bytea('payload_hash').notNull().unique(),
  rawPayload: jsonb('raw_payload').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
});
