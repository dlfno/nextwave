BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE user_role AS ENUM ('HUMAN', 'MERCHANT_OPERATOR', 'AUDITOR', 'ADMIN');
CREATE TYPE agent_status AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');
CREATE TYPE intent_status AS ENUM (
  'DRAFT', 'CLARIFYING', 'READY_FOR_MANDATE', 'MANDATE_AUTHORIZED',
  'SEARCHING', 'OFFER_SELECTED', 'PURCHASING', 'COMPLETED', 'FAILED', 'CANCELLED'
);
CREATE TYPE mandate_status AS ENUM ('DRAFT', 'ACTIVE', 'REVOKED', 'EXPIRED', 'CANCELLED');
CREATE TYPE mandate_version_status AS ENUM ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'REVOKED', 'EXPIRED', 'CANCELLED');
CREATE TYPE mandate_mode AS ENUM ('HUMAN_PRESENT', 'AUTONOMOUS');
CREATE TYPE usage_reservation_status AS ENUM ('RESERVED', 'CONSUMED', 'RELEASED', 'EXPIRED');
CREATE TYPE run_status AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE checkout_status AS ENUM ('CREATED', 'READY', 'COMPLETED', 'EXPIRED', 'CANCELLED', 'FAILED');
CREATE TYPE purchase_attempt_status AS ENUM (
  'CREATED', 'QUOTED', 'DENIED', 'APPROVAL_REQUIRED', 'APPROVED',
  'AUTHORIZED', 'CREDENTIAL_ISSUED', 'PAYMENT_SUBMITTED', 'SUCCEEDED', 'FAILED', 'CANCELLED'
);
CREATE TYPE mandate_decision AS ENUM ('ALLOW', 'DENY', 'REQUIRE_HUMAN_APPROVAL');
CREATE TYPE approval_decision AS ENUM ('APPROVED', 'DENIED');
CREATE TYPE payment_credential_status AS ENUM ('ISSUED', 'CONSUMED', 'REVOKED', 'EXPIRED');
CREATE TYPE transaction_status AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE order_status AS ENUM ('CREATED', 'CONFIRMED', 'CANCELLED', 'REFUNDED');
CREATE TYPE dispute_status AS ENUM ('OPEN', 'EVIDENCE_ASSEMBLED', 'RESOLVED_USER', 'RESOLVED_MERCHANT', 'CLOSED');
CREATE TYPE actor_type AS ENUM ('USER', 'AGENT', 'MERCHANT', 'SYSTEM', 'PAYMENT_PROVIDER', 'AUDITOR');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  role user_role NOT NULL DEFAULT 'HUMAN',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_not_blank CHECK (btrim(email::text) <> ''),
  CONSTRAINT users_display_name_not_blank CHECK (btrim(display_name) <> '')
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  csrf_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_expires_idx ON sessions (user_id, expires_at DESC);

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  status agent_status NOT NULL DEFAULT 'ACTIVE',
  current_key_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agents_name_not_blank CHECK (btrim(name) <> '')
);

CREATE INDEX agents_owner_idx ON agents (owner_user_id);

CREATE TABLE agent_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  key_id text NOT NULL,
  algorithm text NOT NULL DEFAULT 'ES256',
  public_jwk jsonb NOT NULL,
  private_key_ref text,
  active_from timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, key_id),
  CONSTRAINT agent_keys_revocation_after_activation CHECK (revoked_at IS NULL OR revoked_at >= active_from)
);

CREATE TABLE webauthn_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id bytea NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE TABLE payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_reference text NOT NULL,
  display_label text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_reference)
);

CREATE TABLE purchase_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id),
  status intent_status NOT NULL DEFAULT 'DRAFT',
  original_request text NOT NULL,
  search_specification jsonb,
  authorization_specification jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_intents_request_not_blank CHECK (btrim(original_request) <> '')
);

CREATE INDEX purchase_intents_user_created_idx ON purchase_intents (user_id, created_at DESC);

CREATE TABLE intent_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES purchase_intents(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('USER', 'AGENT', 'TOOL', 'SYSTEM')),
  content text NOT NULL,
  structured_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intent_messages_content_not_blank CHECK (btrim(content) <> '')
);

CREATE INDEX intent_messages_intent_created_idx ON intent_messages (intent_id, created_at);

CREATE TABLE merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  public_jwk jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchants_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT merchants_name_not_blank CHECK (btrim(name) <> '')
);

CREATE TABLE merchant_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  capability text NOT NULL,
  protocol text NOT NULL,
  protocol_version text NOT NULL,
  configuration jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, capability, protocol, protocol_version)
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL,
  category text NOT NULL,
  description text,
  attributes jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_name_not_blank CHECK (btrim(canonical_name) <> ''),
  CONSTRAINT products_category_format CHECK (category ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$')
);

CREATE INDEX products_category_idx ON products (category);

CREATE TABLE merchant_catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  merchant_product_id text NOT NULL,
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  availability text NOT NULL DEFAULT 'IN_STOCK' CHECK (availability IN ('IN_STOCK', 'OUT_OF_STOCK', 'LIMITED')),
  attributes jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, merchant_product_id)
);

CREATE TABLE mandates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  intent_id uuid REFERENCES purchase_intents(id),
  status mandate_status NOT NULL DEFAULT 'DRAFT',
  mode mandate_mode NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mandates_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT mandates_revoked_state_consistent CHECK (
    (status = 'REVOKED' AND revoked_at IS NOT NULL) OR
    (status <> 'REVOKED' AND revoked_at IS NULL)
  )
);

CREATE INDEX mandates_user_status_idx ON mandates (user_id, status, expires_at);

CREATE TABLE mandate_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id uuid NOT NULL REFERENCES mandates(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status mandate_version_status NOT NULL DEFAULT 'DRAFT',
  max_total_minor bigint NOT NULL CHECK (max_total_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  requires_final_confirmation boolean NOT NULL DEFAULT false,
  max_uses integer CHECK (max_uses IS NULL OR max_uses > 0),
  recurrence_period text CHECK (recurrence_period IS NULL OR recurrence_period IN ('DAY', 'WEEK', 'MONTH', 'TOTAL')),
  budget_minor bigint CHECK (budget_minor IS NULL OR budget_minor >= 0),
  payment_method_id uuid REFERENCES payment_methods(id),
  allowed_merchants_any boolean NOT NULL DEFAULT false,
  canonical_payload jsonb NOT NULL,
  payload_hash bytea,
  signed_payload text,
  signature_algorithm text,
  signing_key_id text,
  signed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mandate_id, version),
  UNIQUE (id, mandate_id),
  CONSTRAINT mandate_versions_valid_window CHECK (valid_until > valid_from),
  CONSTRAINT mandate_versions_signature_complete CHECK (
    (status = 'DRAFT' AND signed_payload IS NULL AND signed_at IS NULL) OR
    (status <> 'DRAFT' AND signed_payload IS NOT NULL AND payload_hash IS NOT NULL AND
      signature_algorithm IS NOT NULL AND signing_key_id IS NOT NULL AND signed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX mandate_versions_one_active_idx
  ON mandate_versions (mandate_id) WHERE status = 'ACTIVE';

ALTER TABLE mandates ADD COLUMN current_version_id uuid;
ALTER TABLE mandates ADD CONSTRAINT mandates_current_version_same_mandate_fk
  FOREIGN KEY (current_version_id, id) REFERENCES mandate_versions(id, mandate_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE mandate_product_constraints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_version_id uuid NOT NULL REFERENCES mandate_versions(id) ON DELETE CASCADE,
  match_type text NOT NULL CHECK (match_type IN ('EXACT_PRODUCT', 'PRODUCT_NAME', 'CATEGORY')),
  product_id uuid REFERENCES products(id),
  normalized_name text,
  category_prefix text,
  max_quantity integer NOT NULL DEFAULT 1 CHECK (max_quantity > 0),
  CONSTRAINT mandate_product_constraint_match CHECK (
    (match_type = 'EXACT_PRODUCT' AND product_id IS NOT NULL AND normalized_name IS NULL AND category_prefix IS NULL) OR
    (match_type = 'PRODUCT_NAME' AND product_id IS NULL AND normalized_name IS NOT NULL AND category_prefix IS NULL) OR
    (match_type = 'CATEGORY' AND product_id IS NULL AND normalized_name IS NULL AND category_prefix IS NOT NULL)
  )
);

CREATE TABLE mandate_merchant_allowlist (
  mandate_version_id uuid NOT NULL REFERENCES mandate_versions(id) ON DELETE CASCADE,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  PRIMARY KEY (mandate_version_id, merchant_id)
);

CREATE TABLE mandate_revocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_id uuid NOT NULL UNIQUE REFERENCES mandates(id) ON DELETE CASCADE,
  revoked_by_user_id uuid NOT NULL REFERENCES users(id),
  revoked_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE discovery_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES purchase_intents(id) ON DELETE CASCADE,
  status run_status NOT NULL DEFAULT 'PENDING',
  provider_ids text[] NOT NULL DEFAULT '{}',
  started_at timestamptz,
  completed_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovery_runs_completion_after_start CHECK (
    completed_at IS NULL OR (started_at IS NOT NULL AND completed_at >= started_at)
  )
);

CREATE TABLE offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_run_id uuid NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  merchant_product_id text NOT NULL,
  product_id uuid REFERENCES products(id),
  product_name text NOT NULL,
  description text,
  category text NOT NULL,
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  availability text NOT NULL,
  shipping_estimate jsonb,
  source_type text NOT NULL CHECK (source_type IN ('UCP', 'MERCHANT_API', 'INTERNAL_CATALOG', 'WEB', 'MOCK')),
  source_reference text NOT NULL,
  observed_at timestamptz NOT NULL,
  confidence numeric(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  supports_authoritative_checkout boolean NOT NULL DEFAULT false,
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX offers_run_price_idx ON offers (discovery_run_id, currency, unit_price_minor);

CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id uuid NOT NULL REFERENCES offers(id),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  provider_quote_id text NOT NULL,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  payload jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (merchant_id, provider_quote_id),
  CONSTRAINT quotes_expiry_after_observation CHECK (expires_at > observed_at)
);

CREATE TABLE purchase_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id uuid NOT NULL REFERENCES purchase_intents(id),
  mandate_id uuid NOT NULL REFERENCES mandates(id),
  mandate_version_id uuid NOT NULL REFERENCES mandate_versions(id),
  selected_offer_id uuid NOT NULL REFERENCES offers(id),
  quote_id uuid REFERENCES quotes(id),
  status purchase_attempt_status NOT NULL DEFAULT 'CREATED',
  reason_code text,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE purchase_attempts ADD CONSTRAINT purchase_attempts_version_same_mandate_fk
  FOREIGN KEY (mandate_version_id, mandate_id) REFERENCES mandate_versions(id, mandate_id);

CREATE INDEX purchase_attempts_intent_created_idx ON purchase_attempts (intent_id, created_at DESC);

CREATE TABLE checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL UNIQUE REFERENCES purchase_attempts(id) ON DELETE CASCADE,
  quote_id uuid NOT NULL REFERENCES quotes(id),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  provider_checkout_id text NOT NULL,
  status checkout_status NOT NULL DEFAULT 'CREATED',
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  signed_checkout text NOT NULL,
  checkout_hash bytea NOT NULL UNIQUE,
  raw_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (merchant_id, provider_checkout_id),
  UNIQUE (id, checkout_hash),
  CONSTRAINT checkout_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT checkout_completion_after_creation CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE TABLE checkout_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id uuid NOT NULL REFERENCES checkout_sessions(id) ON DELETE CASCADE,
  merchant_product_id text NOT NULL,
  product_id uuid REFERENCES products(id),
  product_name text NOT NULL,
  category text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT checkout_line_total_matches CHECK (total_minor = unit_price_minor * quantity)
);

CREATE TABLE mandate_usage_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mandate_version_id uuid NOT NULL REFERENCES mandate_versions(id),
  attempt_id uuid NOT NULL UNIQUE REFERENCES purchase_attempts(id),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  status usage_reservation_status NOT NULL DEFAULT 'RESERVED',
  reserved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  released_at timestamptz,
  CONSTRAINT usage_reservation_expiry_after_reservation CHECK (expires_at > reserved_at),
  CONSTRAINT usage_reservation_terminal_time CHECK (
    (status = 'CONSUMED' AND consumed_at IS NOT NULL AND released_at IS NULL) OR
    (status IN ('RELEASED', 'EXPIRED') AND released_at IS NOT NULL AND consumed_at IS NULL) OR
    (status = 'RESERVED' AND consumed_at IS NULL AND released_at IS NULL)
  )
);

CREATE INDEX mandate_usage_active_idx ON mandate_usage_reservations (mandate_version_id, status, reserved_at);

CREATE TABLE mandate_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES purchase_attempts(id) ON DELETE CASCADE,
  mandate_version_id uuid NOT NULL REFERENCES mandate_versions(id),
  checkout_id uuid NOT NULL REFERENCES checkout_sessions(id),
  decision mandate_decision NOT NULL,
  reason_code text NOT NULL,
  checks jsonb NOT NULL,
  input_hash bytea NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mandate_evaluations_attempt_idx ON mandate_evaluations (attempt_id, evaluated_at DESC);

CREATE TABLE human_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES purchase_attempts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  mandate_version_id uuid NOT NULL REFERENCES mandate_versions(id),
  checkout_id uuid NOT NULL REFERENCES checkout_sessions(id),
  checkout_hash bytea NOT NULL,
  decision approval_decision NOT NULL,
  signed_evidence text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (attempt_id, checkout_hash),
  CONSTRAINT human_approvals_expiry_after_decision CHECK (expires_at > decided_at)
);

ALTER TABLE human_approvals ADD CONSTRAINT human_approvals_checkout_hash_fk
  FOREIGN KEY (checkout_id, checkout_hash) REFERENCES checkout_sessions(id, checkout_hash);

CREATE TABLE payment_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL UNIQUE REFERENCES purchase_attempts(id),
  checkout_id uuid NOT NULL UNIQUE REFERENCES checkout_sessions(id),
  checkout_hash bytea NOT NULL,
  mandate_version_id uuid NOT NULL REFERENCES mandate_versions(id),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  signed_payload text NOT NULL,
  payload_hash bytea NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT payment_authorization_expiry_after_issue CHECK (expires_at > issued_at)
);

ALTER TABLE payment_authorizations ADD CONSTRAINT payment_authorizations_checkout_hash_fk
  FOREIGN KEY (checkout_id, checkout_hash) REFERENCES checkout_sessions(id, checkout_hash);

CREATE TABLE payment_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_authorization_id uuid NOT NULL UNIQUE REFERENCES payment_authorizations(id),
  provider text NOT NULL,
  provider_reference text NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  checkout_id uuid NOT NULL UNIQUE REFERENCES checkout_sessions(id),
  max_amount_minor bigint NOT NULL CHECK (max_amount_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status payment_credential_status NOT NULL DEFAULT 'ISSUED',
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (provider, provider_reference),
  CONSTRAINT payment_credentials_expiry_after_issue CHECK (expires_at > issued_at),
  CONSTRAINT payment_credentials_terminal_state CHECK (
    (status = 'ISSUED' AND consumed_at IS NULL AND revoked_at IS NULL) OR
    (status = 'CONSUMED' AND consumed_at IS NOT NULL AND revoked_at IS NULL) OR
    (status = 'REVOKED' AND revoked_at IS NOT NULL AND consumed_at IS NULL) OR
    (status = 'EXPIRED' AND consumed_at IS NULL)
  )
);

CREATE INDEX payment_credentials_active_idx ON payment_credentials (expires_at) WHERE status = 'ISSUED';

CREATE TABLE transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL UNIQUE REFERENCES purchase_attempts(id),
  credential_id uuid REFERENCES payment_credentials(id),
  provider text NOT NULL,
  provider_reference text,
  status transaction_status NOT NULL DEFAULT 'PENDING',
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, provider_reference),
  CONSTRAINT transactions_failure_code_consistent CHECK (
    (status = 'FAILED' AND failure_code IS NOT NULL) OR status <> 'FAILED'
  )
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL UNIQUE REFERENCES transactions(id),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  merchant_order_id text NOT NULL,
  status order_status NOT NULL DEFAULT 'CREATED',
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, merchant_order_id)
);

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  merchant_product_id text NOT NULL,
  product_id uuid REFERENCES products(id),
  product_name text NOT NULL,
  category text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT order_items_total_matches CHECK (total_minor = unit_price_minor * quantity)
);

CREATE TABLE receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  transaction_id uuid NOT NULL REFERENCES transactions(id),
  receipt_type text NOT NULL CHECK (receipt_type IN ('CHECKOUT', 'PAYMENT', 'ORDER')),
  signed_payload text NOT NULL,
  payload_hash bytea NOT NULL UNIQUE,
  raw_payload jsonb NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, receipt_type)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_version integer NOT NULL DEFAULT 1 CHECK (event_version > 0),
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type actor_type NOT NULL,
  actor_id uuid,
  intent_id uuid REFERENCES purchase_intents(id),
  mandate_id uuid REFERENCES mandates(id),
  mandate_version_id uuid REFERENCES mandate_versions(id),
  attempt_id uuid REFERENCES purchase_attempts(id),
  transaction_id uuid REFERENCES transactions(id),
  correlation_id uuid NOT NULL,
  payload jsonb NOT NULL,
  previous_hash bytea,
  event_hash bytea NOT NULL UNIQUE,
  CONSTRAINT audit_events_type_not_blank CHECK (btrim(event_type) <> '')
);

CREATE INDEX audit_events_intent_order_idx ON audit_events (intent_id, occurred_at, id);
CREATE INDEX audit_events_transaction_idx ON audit_events (transaction_id, occurred_at);
CREATE INDEX audit_events_correlation_idx ON audit_events (correlation_id);

CREATE TABLE disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES transactions(id),
  opened_by_user_id uuid NOT NULL REFERENCES users(id),
  status dispute_status NOT NULL DEFAULT 'OPEN',
  reason_code text NOT NULL,
  statement text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolution_summary text,
  CONSTRAINT disputes_resolution_consistent CHECK (
    (status IN ('RESOLVED_USER', 'RESOLVED_MERCHANT', 'CLOSED') AND resolved_at IS NOT NULL) OR
    (status IN ('OPEN', 'EVIDENCE_ASSEMBLED') AND resolved_at IS NULL)
  )
);

CREATE INDEX disputes_transaction_idx ON disputes (transaction_id, opened_at DESC);

CREATE TABLE dispute_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id uuid NOT NULL UNIQUE REFERENCES disputes(id) ON DELETE CASCADE,
  evidence_version integer NOT NULL DEFAULT 1 CHECK (evidence_version > 0),
  bundle jsonb NOT NULL,
  bundle_hash bytea NOT NULL UNIQUE,
  verification_result jsonb NOT NULL,
  assembled_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  actor_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL,
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (scope, actor_id, idempotency_key),
  CONSTRAINT idempotency_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX idempotency_records_expiry_idx ON idempotency_records (expires_at);

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER agents_set_updated_at BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER purchase_intents_set_updated_at BEFORE UPDATE ON purchase_intents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER merchants_set_updated_at BEFORE UPDATE ON merchants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER mandates_set_updated_at BEFORE UPDATE ON mandates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER purchase_attempts_set_updated_at BEFORE UPDATE ON purchase_attempts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION reject_audit_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END;
$$;

CREATE TRIGGER audit_events_reject_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

CREATE FUNCTION protect_mandate_version_evidence() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'authorized mandate versions cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status <> 'DRAFT' AND (
    NEW.mandate_id IS DISTINCT FROM OLD.mandate_id OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.max_total_minor IS DISTINCT FROM OLD.max_total_minor OR
    NEW.currency IS DISTINCT FROM OLD.currency OR
    NEW.valid_from IS DISTINCT FROM OLD.valid_from OR
    NEW.valid_until IS DISTINCT FROM OLD.valid_until OR
    NEW.requires_final_confirmation IS DISTINCT FROM OLD.requires_final_confirmation OR
    NEW.max_uses IS DISTINCT FROM OLD.max_uses OR
    NEW.recurrence_period IS DISTINCT FROM OLD.recurrence_period OR
    NEW.budget_minor IS DISTINCT FROM OLD.budget_minor OR
    NEW.payment_method_id IS DISTINCT FROM OLD.payment_method_id OR
    NEW.allowed_merchants_any IS DISTINCT FROM OLD.allowed_merchants_any OR
    NEW.canonical_payload IS DISTINCT FROM OLD.canonical_payload OR
    NEW.payload_hash IS DISTINCT FROM OLD.payload_hash OR
    NEW.signed_payload IS DISTINCT FROM OLD.signed_payload OR
    NEW.signature_algorithm IS DISTINCT FROM OLD.signature_algorithm OR
    NEW.signing_key_id IS DISTINCT FROM OLD.signing_key_id OR
    NEW.signed_at IS DISTINCT FROM OLD.signed_at OR
    NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'authorized mandate evidence is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER mandate_versions_protect_evidence
  BEFORE UPDATE OR DELETE ON mandate_versions
  FOR EACH ROW EXECUTE FUNCTION protect_mandate_version_evidence();

CREATE FUNCTION apply_mandate_revocation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mandate_owner_id uuid;
BEGIN
  SELECT user_id INTO mandate_owner_id
  FROM mandates
  WHERE id = NEW.mandate_id
  FOR UPDATE;

  IF mandate_owner_id IS DISTINCT FROM NEW.revoked_by_user_id THEN
    RAISE EXCEPTION 'only the mandate owner can revoke this mandate';
  END IF;

  UPDATE mandate_versions
  SET status = 'REVOKED'
  WHERE mandate_id = NEW.mandate_id AND status = 'ACTIVE';

  UPDATE mandates
  SET status = 'REVOKED', revoked_at = NEW.revoked_at
  WHERE id = NEW.mandate_id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER mandate_revocations_apply_state
  AFTER INSERT ON mandate_revocations
  FOR EACH ROW EXECUTE FUNCTION apply_mandate_revocation();

CREATE TRIGGER mandate_revocations_reject_update_delete
  BEFORE UPDATE OR DELETE ON mandate_revocations
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

INSERT INTO schema_migrations (name) VALUES ('0001_initial.sql');

COMMIT;
