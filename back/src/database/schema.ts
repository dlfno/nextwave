import { customType, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
