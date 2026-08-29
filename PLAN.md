  # Agentic Commerce Hackathon Implementation Plan

  ## 1. Repository Assessment

  The repository has a skeleton already implemented for front and back end functionality. Currently on Next.js, need to change into Express.js.

  Chosen project layout:

  nextwave/
  ├── backend/                 # Independent NestJS application
  ├── frontend/                # Independent Angular application
  ├── docs/                    # Architecture, API, demo, and threat-model docs
  ├── compose.yaml             # Local PostgreSQL and supporting services
  └── README.md

  The frontend and backend will have independent manifests, lockfiles, builds, and deployments. VuelaYa will initially be an in-process backend adapter with a logical merchant
  trust boundary, not a third deployable application.

  ## 2. Recommended System Architecture

  Use a modular monolith for the platform API:

  - Angular standalone application with Tailwind CSS.
  - NestJS using the Fastify adapter.
  - PostgreSQL with Drizzle ORM and reviewed SQL migrations.
  - REST/OpenAPI for browser-to-backend communication.
  - Server-Sent Events for agent/discovery progress.
  - Generated Angular API client from the backend OpenAPI document.
  - Synchronous persisted workflows for P0; no Redis or distributed queue.
  - Provider interfaces around LLMs, discovery, commerce, and payment credentials.
  - A pure deterministic mandate engine with no database, network, or LLM calls.
  - A purchase orchestration service that loads authoritative state, invokes the engine, and coordinates adapters.
  - Append-only structured audit records written transactionally with state changes.

  flowchart LR
      subgraph Browser["Untrusted Browser"]
          UI["Angular Application"]
          TrustedUI["Deterministic Mandate / Approval UI"]
      end

      subgraph API["NestJS Modular Monolith"]
          Auth["Auth & Sessions"]
          Intent["Intent & Conversation"]
          Agent["Purchasing Agent"]
          Mandates["Mandates & Signatures"]
          Discovery["Discovery Engine"]
          Orchestrator["Purchase Orchestrator"]
          Policy["Pure Mandate Engine"]
          Approval["Human Approval"]
          Commerce["Commerce Provider Port"]
          Payment["Payment Credential Port"]
          Orders["Orders & Receipts"]
          Audit["Append-only Audit"]
          Disputes["Dispute Reconstruction"]
      end

      DB[("PostgreSQL")]
      LLM["LLM Provider\nMock P0 / Real P1"]
      VuelaYa["Mock VuelaYa\nUCP-shaped Adapter"]
      Stripe["Stripe SPT / PaymentIntent\nP1 if available"]

      UI --> Auth
      UI --> Intent
      TrustedUI --> Mandates
      Intent --> Agent
      Agent --> LLM
      Agent --> Discovery
      Discovery --> Commerce
      Orchestrator --> Commerce
      Orchestrator --> Policy
      Orchestrator --> Approval
      Orchestrator --> Payment
      Orchestrator --> Orders
      Commerce --> VuelaYa
      Payment --> Stripe

      Auth --> DB
      Intent --> DB
      Mandates --> DB
      Discovery --> DB
      Orchestrator --> DB
      Approval --> DB
      Orders --> DB
      Audit --> DB
      Disputes --> DB

      Mandates --> Audit
      Orchestrator --> Audit
      Payment --> Audit
      Orders --> Audit

  ### Backend modules

  - AuthModule: users, Argon2id passwords, sessions, CSRF protection.
  - AgentsModule: agent identities, keys, and allowed user-agent relationships.
  - PurchaseIntentsModule: intents, conversation messages, search and authorization specifications.
  - MandatesModule: drafts, immutable versions, authorization, signing, expiration, updates, and revocation.
  - PolicyEngineModule: pure deterministic evaluation and stable reason codes.
  - DiscoveryModule: discovery runs, provider fan-out, normalization, preliminary filtering, and ranking input.
  - MerchantsModule: merchant records, capabilities, keys, and access control.
  - CommerceModule: provider registry, quote, checkout, and completion adapters.
  - ApprovalsModule: checkout-bound human approvals.
  - PaymentsModule: payment authorizations, credential providers, and credential consumption.
  - OrdersModule: transaction results, orders, items, and receipts.
  - AuditModule: append-only events and hash-chain verification.
  - DisputesModule: disputes and deterministic evidence reconstruction.
  - PurchaseOrchestrationModule: the only module coordinating the complete purchase flow.

  Domain code will not import NestJS, Drizzle, Stripe, UCP, or LLM SDK types.

  ## 3. Key Technical Decisions

  ### Authorization

  - The natural-language request is never executable policy.
  - The agent produces independent SearchSpecification and AuthorizationSpecification objects validated against strict schemas.
  - Hard mandate violations always return DENY; final approval cannot override amount, merchant, category, product, expiry, or revocation restrictions.
  - REQUIRE_HUMAN_APPROVAL is returned only when every hard constraint passes but the mandate requires checkout-specific consent.
  - After approval, the system re-runs the entire policy evaluation. Approval is bound to the checkout hash, mandate version, amount, merchant, and expiration.
  - Revocation is online state, not merely a claim in a signed mandate. Every purchase attempt and credential issuance queries the authoritative revocation table.
  - Amounts use integer minor units in PostgreSQL BIGINT; API amounts are decimal strings to avoid JavaScript precision loss.
  - All timestamps are UTC and supplied to domain logic through an injectable clock.

  ### AP2-shaped evidence

  P0 will implement an AP2-shaped evidence chain rather than claim standards-complete AP2 compliance:

  - Platform Trusted Surface signs user-approved open mandate evidence with ES256.
  - The autonomous agent has a separate key and signs transaction-specific closed evidence.
  - Merchant checkouts are signed with the mock merchant key.
  - Closed checkout and payment authorizations bind to the exact signed checkout using SHA-256/base64url hashes.
  - JSON payloads are canonicalized with RFC 8785 JSON Canonicalization Scheme before hashing.
  - Compact signed artifacts and their hashes are retained for dispute evidence.
  - Full SD-JWT selective disclosure is P1.

  This follows the current AP2 separation between open/closed Checkout Mandates and Payment Mandates, while keeping P0 achievable. See the AP2 v0.2 specification
  (https://ap2-protocol.org/ap2/specification/) and implementation considerations (https://ap2-protocol.org/ap2/implementation_considerations/).

  ### Authentication and sessions

  - Email/password authentication using Argon2id.
  - Opaque random session token in a Secure, HttpOnly, SameSite=Lax cookie.
  - Only a hash of the session token is stored.
  - State-changing requests require allowed-origin validation and a CSRF token.
  - Mandate authorization, mandate replacement, revocation, and final approval require recent authentication.
  - User ownership is enforced server-side on every intent, mandate, attempt, transaction, and dispute.
  - Passkeys with @simplewebauthn/server are P1.

  ### Agent boundary

  - AgentProvider has a deterministic P0 implementation.
  - The mock returns schema-valid clarification questions, specifications, ranking results, and explanations.
  - Provider output is treated as hostile input: schema validation, length limits, allowlisted tools, timeouts, and no direct database or payment access.
  - The agent can recommend an offer but cannot set authorization decisions or issue credentials.

  ### Data integrity and concurrency

  - Mandate versions and audit events are immutable.
  - Activating a replacement version locks the mandate row, supersedes the prior version, and atomically changes current_version_id.
  - Usage limits use reservation rows and a database transaction to prevent concurrent overspend.
  - Checkouts, approvals, payment authorizations, and credentials are single-use and checkout-bound.
  - Idempotency-Key is required for purchase, approval, revocation, and payment execution commands.
  - Payment execution rechecks mandate status, revocation, expiry, checkout freshness, approval, and usage immediately before credential issuance.
  - Mock credentials are short-lived signed tokens with unique jti; only their hash and metadata are stored.

  ### Observability

  - Pino JSON logs with correlation ID, purchase-intent ID, purchase-attempt ID, mandate ID/version, and transaction ID.
  - Stable error taxonomy and policy reason codes.
  - Logs redact credentials, cookies, authorization headers, signed private evidence, and sensitive traveler data.
  - Audit events, not logs, are the evidence system.
  - OpenTelemetry traces and metrics are P1.

  ## 4. Core Domain and PostgreSQL Model

  ### Core entities

  - User: human principal and owner of purchasing authority.
  - Session: opaque browser session.
  - Agent: identity and public key of an authorized shopping agent.
  - PurchaseIntent: natural-language request and workflow state.
  - IntentMessage: conversation history with typed human/agent/tool messages.
  - SearchSpecification: discovery and ranking preferences.
  - AuthorizationSpecification: proposed enforceable mandate constraints.
  - Mandate: logical authorization family and current lifecycle state.
  - MandateVersion: immutable signed authorization.
  - MandateRevocation: authoritative live revocation record.
  - MandateUsageReservation: recurrence/budget reservation and consumption.
  - Merchant: merchant identity and verification key.
  - MerchantCapability: UCP/API/payment capabilities.
  - Product: normalized catalog item.
  - DiscoveryRun: one provider search execution.
  - Offer: non-authoritative observed discovery result.
  - Quote: refreshed merchant quote with expiry.
  - CheckoutSession: authoritative signed merchant checkout.
  - PurchaseAttempt: orchestration state for trying one selected offer.
  - MandateEvaluation: persisted structured policy result.
  - HumanApproval: explicit checkout-bound approval or rejection.
  - PaymentAuthorization: AP2-shaped closed payment authorization.
  - PaymentCredential: non-sensitive credential metadata and token hash only.
  - Transaction: payment execution outcome.
  - Order and OrderItem: purchased goods.
  - Receipt: signed merchant/payment evidence.
  - AuditEvent: immutable event with per-intent hash chaining.
  - Dispute: user challenge to a transaction.
  - DisputeEvidence: immutable reconstructed evidence bundle.
  - IdempotencyRecord: prior command result and request hash.

  ### Tables and important constraints


• Proposed Plan


  # Agentic Commerce Hackathon Implementation Plan

  ## 1. Repository Assessment

  The repository is a greenfield project:

  - Only .git exists; there are no commits, source files, manifests, database configuration, CI, tests, or conventions to preserve.
  - No frontend or backend framework is installed.
  - No existing database schema or integration code exists.
  - The implementation can therefore establish clean boundaries without rewriting functioning code.

  Chosen project layout:

  nextwave/
  ├── backend/                 # Independent NestJS application
  ├── frontend/                # Independent Angular application
  ├── docs/                    # Architecture, API, demo, and threat-model docs
  ├── compose.yaml             # Local PostgreSQL and supporting services
  └── README.md

  The frontend and backend will have independent manifests, lockfiles, builds, and deployments. VuelaYa will initially be an in-process backend adapter with a logical merchant
  trust boundary, not a third deployable application.

  ## 2. Recommended System Architecture

  Use a modular monolith for the platform API:

  - Angular standalone application with Tailwind CSS.
  - NestJS using the Fastify adapter.
  - PostgreSQL with Drizzle ORM and reviewed SQL migrations.
  - REST/OpenAPI for browser-to-backend communication.
  - Server-Sent Events for agent/discovery progress.
  - Generated Angular API client from the backend OpenAPI document.
  - Synchronous persisted workflows for P0; no Redis or distributed queue.
  - Provider interfaces around LLMs, discovery, commerce, and payment credentials.
  - A pure deterministic mandate engine with no database, network, or LLM calls.
  - A purchase orchestration service that loads authoritative state, invokes the engine, and coordinates adapters.
  - Append-only structured audit records written transactionally with state changes.

  flowchart LR
      subgraph Browser["Untrusted Browser"]
          UI["Angular Application"]
          TrustedUI["Deterministic Mandate / Approval UI"]
      end

      subgraph API["NestJS Modular Monolith"]
          Auth["Auth & Sessions"]
          Intent["Intent & Conversation"]
          Agent["Purchasing Agent"]
          Mandates["Mandates & Signatures"]
          Discovery["Discovery Engine"]
          Orchestrator["Purchase Orchestrator"]
          Policy["Pure Mandate Engine"]
          Approval["Human Approval"]
          Commerce["Commerce Provider Port"]
          Payment["Payment Credential Port"]
          Orders["Orders & Receipts"]
          Audit["Append-only Audit"]
          Disputes["Dispute Reconstruction"]
      end

      DB[("PostgreSQL")]
      LLM["LLM Provider\nMock P0 / Real P1"]
      VuelaYa["Mock VuelaYa\nUCP-shaped Adapter"]
      Stripe["Stripe SPT / PaymentIntent\nP1 if available"]

      UI --> Auth
      UI --> Intent
      TrustedUI --> Mandates
      Intent --> Agent
      Agent --> LLM
      Agent --> Discovery
      Discovery --> Commerce
      Orchestrator --> Commerce
      Orchestrator --> Policy
      Orchestrator --> Approval
      Orchestrator --> Payment
      Orchestrator --> Orders
      Commerce --> VuelaYa
      Payment --> Stripe

      Auth --> DB
      Intent --> DB
      Mandates --> DB
      Discovery --> DB
      Orchestrator --> DB
      Approval --> DB
      Orders --> DB
      Audit --> DB
      Disputes --> DB

      Mandates --> Audit
      Orchestrator --> Audit
      Payment --> Audit
      Orders --> Audit

  ### Backend modules

  - AuthModule: users, Argon2id passwords, sessions, CSRF protection.
  - AgentsModule: agent identities, keys, and allowed user-agent relationships.
  - PurchaseIntentsModule: intents, conversation messages, search and authorization specifications.
  - MandatesModule: drafts, immutable versions, authorization, signing, expiration, updates, and revocation.
  - PolicyEngineModule: pure deterministic evaluation and stable reason codes.
  - DiscoveryModule: discovery runs, provider fan-out, normalization, preliminary filtering, and ranking input.
  - MerchantsModule: merchant records, capabilities, keys, and access control.
  - CommerceModule: provider registry, quote, checkout, and completion adapters.
  - ApprovalsModule: checkout-bound human approvals.
  - PaymentsModule: payment authorizations, credential providers, and credential consumption.
  - OrdersModule: transaction results, orders, items, and receipts.
  - AuditModule: append-only events and hash-chain verification.
  - DisputesModule: disputes and deterministic evidence reconstruction.
  - PurchaseOrchestrationModule: the only module coordinating the complete purchase flow.

  Domain code will not import NestJS, Drizzle, Stripe, UCP, or LLM SDK types.

  ## 3. Key Technical Decisions

  ### Authorization

  - The natural-language request is never executable policy.
  - The agent produces independent SearchSpecification and AuthorizationSpecification objects validated against strict schemas.
  - Hard mandate violations always return DENY; final approval cannot override amount, merchant, category, product, expiry, or revocation restrictions.
  - REQUIRE_HUMAN_APPROVAL is returned only when every hard constraint passes but the mandate requires checkout-specific consent.
  - After approval, the system re-runs the entire policy evaluation. Approval is bound to the checkout hash, mandate version, amount, merchant, and expiration.
  - Revocation is online state, not merely a claim in a signed mandate. Every purchase attempt and credential issuance queries the authoritative revocation table.
  - Amounts use integer minor units in PostgreSQL BIGINT; API amounts are decimal strings to avoid JavaScript precision loss.
  - All timestamps are UTC and supplied to domain logic through an injectable clock.

  ### AP2-shaped evidence

  P0 will implement an AP2-shaped evidence chain rather than claim standards-complete AP2 compliance:

  - Platform Trusted Surface signs user-approved open mandate evidence with ES256.
  - The autonomous agent has a separate key and signs transaction-specific closed evidence.
  - Merchant checkouts are signed with the mock merchant key.
  - Closed checkout and payment authorizations bind to the exact signed checkout using SHA-256/base64url hashes.
  - JSON payloads are canonicalized with RFC 8785 JSON Canonicalization Scheme before hashing.
  - Compact signed artifacts and their hashes are retained for dispute evidence.
  - Full SD-JWT selective disclosure is P1.

  This follows the current AP2 separation between open/closed Checkout Mandates and Payment Mandates, while keeping P0 achievable. See the AP2 v0.2 specification
  (https://ap2-protocol.org/ap2/specification/) and implementation considerations (https://ap2-protocol.org/ap2/implementation_considerations/).

  ### Authentication and sessions

  - Email/password authentication using Argon2id.
  - Opaque random session token in a Secure, HttpOnly, SameSite=Lax cookie.
  - Only a hash of the session token is stored.
  - State-changing requests require allowed-origin validation and a CSRF token.
  - Mandate authorization, mandate replacement, revocation, and final approval require recent authentication.
  - User ownership is enforced server-side on every intent, mandate, attempt, transaction, and dispute.
  - Passkeys with @simplewebauthn/server are P1.

  ### Agent boundary

  - AgentProvider has a deterministic P0 implementation.
  - The mock returns schema-valid clarification questions, specifications, ranking results, and explanations.
  - Provider output is treated as hostile input: schema validation, length limits, allowlisted tools, timeouts, and no direct database or payment access.
  - The agent can recommend an offer but cannot set authorization decisions or issue credentials.

  ### Data integrity and concurrency

  - Mandate versions and audit events are immutable.
  - Activating a replacement version locks the mandate row, supersedes the prior version, and atomically changes current_version_id.
  - Usage limits use reservation rows and a database transaction to prevent concurrent overspend.
  - Checkouts, approvals, payment authorizations, and credentials are single-use and checkout-bound.
  - Idempotency-Key is required for purchase, approval, revocation, and payment execution commands.
  - Payment execution rechecks mandate status, revocation, expiry, checkout freshness, approval, and usage immediately before credential issuance.
  - Mock credentials are short-lived signed tokens with unique jti; only their hash and metadata are stored.

  ### Observability

  - Pino JSON logs with correlation ID, purchase-intent ID, purchase-attempt ID, mandate ID/version, and transaction ID.
  - Stable error taxonomy and policy reason codes.
  - Logs redact credentials, cookies, authorization headers, signed private evidence, and sensitive traveler data.
  - Audit events, not logs, are the evidence system.
  - OpenTelemetry traces and metrics are P1.

  ## 4. Core Domain and PostgreSQL Model

  ### Core entities

  - User: human principal and owner of purchasing authority.
  - Session: opaque browser session.
  - Agent: identity and public key of an authorized shopping agent.
  - PurchaseIntent: natural-language request and workflow state.
  - IntentMessage: conversation history with typed human/agent/tool messages.
  - SearchSpecification: discovery and ranking preferences.
  - AuthorizationSpecification: proposed enforceable mandate constraints.
  - Mandate: logical authorization family and current lifecycle state.
  - MandateVersion: immutable signed authorization.
  - MandateRevocation: authoritative live revocation record.
  - MandateUsageReservation: recurrence/budget reservation and consumption.
  - Merchant: merchant identity and verification key.
  - MerchantCapability: UCP/API/payment capabilities.
  - Product: normalized catalog item.
  - DiscoveryRun: one provider search execution.
  - Offer: non-authoritative observed discovery result.
  - Quote: refreshed merchant quote with expiry.
  - CheckoutSession: authoritative signed merchant checkout.
  - PurchaseAttempt: orchestration state for trying one selected offer.
  - MandateEvaluation: persisted structured policy result.
  - HumanApproval: explicit checkout-bound approval or rejection.
  - PaymentAuthorization: AP2-shaped closed payment authorization.
  - PaymentCredential: non-sensitive credential metadata and token hash only.
  - Transaction: payment execution outcome.
  - Order and OrderItem: purchased goods.
  - Receipt: signed merchant/payment evidence.
  - AuditEvent: immutable event with per-intent hash chaining.
  - Dispute: user challenge to a transaction.
  - DisputeEvidence: immutable reconstructed evidence bundle.
  - IdempotencyRecord: prior command result and request hash.

  ### Tables and important constraints

   Group                     Tables and principal fields
  ━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Identity                  users(id, email, password_hash, display_name, role, created_at); sessions(id, user_id, token_hash, csrf_hash, expires_at, last_seen_at);
                             agents(id, owner_user_id, name, status, public_jwk, key_id)
  ────────────────────────  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Intent                    purchase_intents(id, user_id, agent_id, status, original_request, search_spec_json, authorization_spec_json, created_at, updated_at);
                             intent_messages(id, intent_id, role, content, structured_payload, created_at)
  ────────────────────────  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Mandates                  mandates(id, user_id, agent_id, intent_id, status, mode, current_version_id, expires_at, revoked_at); mandate_versions(id, mandate_id, version,
                             status, max_total_minor, currency, valid_from, valid_until, requires_final_confirmation, max_uses, recurrence_period, budget_minor,
                             payment_method_ref, canonical_payload, payload_hash, signed_payload, signature_alg, key_id, signed_at)
  ────────────────────────  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Normalized constraints    mandate_product_constraints(version_id, match_type, product_ref, normalized_name, category_prefix, max_quantity);
                             mandate_merchant_allowlist(version_id, merchant_id)
  ────────────────────────  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Revocation/usage          mandate_revocations(id, mandate_id, revoked_by, revoked_at, reason) with unique mandate_id; mandate_usage_reservations(id, version_id, attempt_id,
                             amount_minor, status, reserved_at, consumed_at)
  ────────────────────────  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Merchants                 merchants(id, slug, name, status, public_jwk); merchant_capabilities(id, merchant_id, capability, protocol, protocol_version, configuration_json)
  ────────────────────────  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Discovery                 products(id, canonical_name, category, attributes_json); discovery_runs(id, intent_id, status, started_at, completed_at); offers(id,
                             discovery_run_id, provider, merchant_id, merchant_product_id, product_id, name, description, category, unit_price_minor, currency, availability,
                             shipping_json, source_type, source_reference, observed_at, confidence, supports_authoritative_checkout)
  ────────────────────────  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Checkout                  quotes(id, offer_id, merchant_id, total_minor, currency, payload_json, expires_at); checkout_sessions(id, attempt_id, quote_id, merchant_id,
                             provider_checkout_id, status, total_minor, currency, signed_checkout, checkout_hash, expires_at, completed_at); checkout_line_items(...) with
                             normalized product/category/quantity/amount fields
  ────────────────────────  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Authorization             purchase_attempts(id, intent_id, mandate_id, mandate_version_id, selected_offer_id, status, reason_code, correlation_id); mandate_evaluations(id,
                             attempt_id, decision, reason_code, checks_json, evaluated_at, input_hash); human_approvals(id, attempt_id, user_id, decision, checkout_hash,
                             mandate_version_id, expires_at, signed_evidence)
  ────────────────────────  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Payment/order             payment_authorizations(id, attempt_id, checkout_id, mandate_version_id, amount_minor, currency, payee_id, signed_payload, payload_hash,
                             expires_at); payment_credentials(id, authorization_id, provider, provider_reference, token_hash, merchant_id, max_amount_minor, status,
                             expires_at, consumed_at); transactions(id, attempt_id, provider, provider_reference, status, amount_minor, currency, failure_code, processed_at);
                             orders, order_items, receipts
  ────────────────────────  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Audit/dispute             audit_events(id, event_version, event_type, occurred_at, actor_type, actor_id, intent_id, mandate_id, mandate_version_id, attempt_id,
                             transaction_id, correlation_id, payload_json, previous_hash, event_hash); disputes; dispute_evidence
  ────────────────────────  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Safety                    idempotency_records(scope, actor_id, key, request_hash, response_code, response_json, expires_at) with a unique compound key

  Database rules:

  - UUID primary keys, foreign keys, UTC timestamptz, and useful PostgreSQL enums.
  - Unique (mandate_id, version) and at most one active version per mandate.
  - Unique checkout hash, credential token hash, provider references, and consumed authorization.
  - Check constraints for non-negative amounts, positive quantities, valid time windows, and ISO currency format.
  - Partial indexes for active mandates, pending attempts, unused credentials, and unresolved disputes.
  - Application DB role may insert audit events but cannot update or delete them; a trigger additionally rejects mutation.
  - JSONB stores external/raw protocol evidence and flexible attributes, while every policy-relevant value also has a normalized typed column.

  ## 5. Interfaces and Public API

  ### Provider/application interfaces

  interface DiscoveryProvider {
    readonly id: string;
    search(
      specification: SearchSpecification,
      context: DiscoveryContext,
    ): Promise<DiscoveredOffer[]>;
  }

  interface CommerceProvider {
    readonly id: string;
    getCapabilities(merchantId: string): Promise<MerchantCapabilities>;
    getLiveQuote(input: LiveQuoteRequest): Promise<AuthoritativeQuote>;
    createCheckout(input: CreateCheckoutRequest): Promise<SignedCheckout>;
    completeCheckout(input: CompleteCheckoutRequest): Promise<CheckoutResult>;
  }

  interface MandateEngine {
    evaluate(input: MandateEvaluationInput): MandateDecision;
  }

  interface PaymentCredentialProvider {
    readonly id: string;
    issueCredential(
      authorization: PaymentAuthorization,
      checkout: AuthoritativeCheckout,
    ): Promise<IssuedCredential>;
    revokeCredential?(providerReference: string): Promise<void>;
  }

  interface AuditService {
    append(event: NewAuditEvent, transaction?: DatabaseTransaction): Promise<AuditEvent>;
    listForIntent(intentId: string, viewer: AuditViewer): Promise<AuditEvent[]>;
    verifyChain(intentId: string): Promise<AuditIntegrityResult>;
  }

  MandateEvaluationInput contains already-loaded immutable values: mandate/version, signature verification result, agent, merchant, checkout, current time, revocation state,
  checkout state, prior usage, reservation state, and human approval. The engine itself performs no I/O.

  ### Decision contract

  {
    "decision": "ALLOW",
    "reasonCode": "ALL_CONSTRAINTS_SATISFIED",
    "mandateId": "uuid",
    "mandateVersion": 1,
    "checkoutHash": "base64url-sha256",
    "checks": [
      {
        "name": "MANDATE_NOT_REVOKED",
        "passed": true,
        "reasonCode": null
      }
    ],
    "evaluatedAt": "2026-08-29T18:00:00Z"
  }

  Stable denial codes include:

  - MANDATE_SIGNATURE_INVALID
  - AGENT_NOT_AUTHORIZED
  - MANDATE_NOT_ACTIVE
  - MANDATE_REVOKED
  - MANDATE_EXPIRED
  - MERCHANT_NOT_ALLOWED
  - CATEGORY_NOT_ALLOWED
  - PRODUCT_NOT_ALLOWED
  - QUANTITY_EXCEEDED
  - AMOUNT_EXCEEDS_MANDATE
  - CURRENCY_NOT_ALLOWED
  - USAGE_LIMIT_EXCEEDED
  - BUDGET_EXCEEDED
  - CHECKOUT_SIGNATURE_INVALID
  - CHECKOUT_EXPIRED
  - CHECKOUT_BINDING_MISMATCH
  - CHECKOUT_ALREADY_USED
  - HUMAN_APPROVAL_REQUIRED
  - HUMAN_APPROVAL_MISSING
  - HUMAN_APPROVAL_EXPIRED
  - HUMAN_APPROVAL_MISMATCH
  - PAYMENT_CREDENTIAL_REPLAYED

  ### REST endpoints

  All routes use /api/v1.

  Authentication

  - POST /auth/register
  - POST /auth/login
  - POST /auth/logout
  - GET /auth/me
  - POST /auth/reauthenticate

  Purchase intents and conversation

  - POST /purchase-intents
  - GET /purchase-intents
  - GET /purchase-intents/:intentId
  - POST /purchase-intents/:intentId/messages
  - POST /purchase-intents/:intentId/finalize-specifications
  - GET /purchase-intents/:intentId/events — SSE progress

  Mandates

  - POST /purchase-intents/:intentId/mandates/draft
  - GET /mandates
  - GET /mandates/:mandateId
  - POST /mandates/:mandateId/authorize
  - POST /mandates/:mandateId/versions
  - POST /mandates/:mandateId/versions/:version/authorize
  - POST /mandates/:mandateId/revoke

  Discovery and offers

  - POST /purchase-intents/:intentId/discovery-runs
  - GET /discovery-runs/:runId
  - GET /discovery-runs/:runId/offers
  - POST /purchase-intents/:intentId/select-offer

  Purchase execution

  - POST /purchase-intents/:intentId/purchase-attempts
  - GET /purchase-attempts/:attemptId
  - POST /purchase-attempts/:attemptId/approval
  - POST /purchase-attempts/:attemptId/execute
  - POST /purchase-attempts/:attemptId/cancel

  Records and role-specific views

  - GET /transactions
  - GET /transactions/:transactionId
  - GET /transactions/:transactionId/receipt
  - GET /transactions/:transactionId/audit
  - GET /merchant/verifications/:attemptId
  - GET /auditor/transactions/:transactionId/evidence
  - POST /transactions/:transactionId/disputes
  - GET /disputes/:disputeId
  - POST /disputes/:disputeId/resolve

  All command endpoints use request validation, ownership checks, CSRF protection, and idempotency where applicable.

  ## 6. Lifecycle and End-to-End Flow

  ### Mandate lifecycle

  stateDiagram-v2
      [*] --> DRAFT
      DRAFT --> ACTIVE: Human authorizes signed version
      DRAFT --> CANCELLED: Human abandons
      ACTIVE --> SUPERSEDED: Replacement version authorized
      ACTIVE --> REVOKED: Live revocation
      ACTIVE --> EXPIRED: validUntil reached
      SUPERSEDED --> [*]
      REVOKED --> [*]
      EXPIRED --> [*]
      CANCELLED --> [*]

  Rules:

  - Updating an active mandate creates a new draft version.
  - The old version remains active until the replacement is authorized.
  - Activating the replacement atomically supersedes the old version.
  - Revoked, expired, and superseded versions can never be reactivated.
  - Revocation applies to the entire mandate family.
  - Expiration is enforced from time comparison even if a background status update has not run.

  ### Purchase/payment lifecycle

  CREATED
  → QUOTED
  → DENIED
    or APPROVAL_REQUIRED → APPROVED → AUTHORIZED
    or AUTHORIZED
  → CREDENTIAL_ISSUED
  → PAYMENT_SUBMITTED
  → SUCCEEDED | FAILED

  A previously authorized attempt may transition to DENIED during execution if the mandate was revoked, expired, replaced, or exhausted before credential issuance.

  ### Primary sequence

  sequenceDiagram
      actor Human
      participant UI as Angular Trusted Surface
      participant API as Purchase Orchestrator
      participant Agent as Purchasing Agent
      participant DB as PostgreSQL
      participant Merchant as VuelaYa Commerce Adapter
      participant Policy as Deterministic Mandate Engine
      participant Pay as Credential Provider
      participant Audit as Audit Service

      Human->>UI: "Buy a flight to Córdoba below $150"
      UI->>API: Create purchase intent
      API->>Agent: Clarify ambiguous intent
      Agent-->>UI: Origin, Córdoba destination, dates, currency
      Human->>UI: Supplies missing details
      Agent->>API: SearchSpecification + AuthorizationSpecification
      API-->>UI: Render structured mandate
      Human->>UI: Re-authenticate and authorize
      UI->>API: Authorize exact canonical payload
      API->>DB: Store immutable signed open mandate
      API->>Audit: MANDATE_AUTHORIZED

      API->>Agent: Start discovery
      Agent->>Merchant: Search normalized catalog
      Merchant-->>Agent: Observed offers
      Agent->>API: Select and explain $130 offer
      API->>Merchant: Request live quote and checkout
      Merchant-->>API: Signed authoritative checkout
      API->>DB: Load mandate, revocation, usage, approval
      API->>Policy: Evaluate immutable inputs

      alt Hard constraint fails or mandate revoked
          Policy-->>API: DENY + reason/checks
          API->>Audit: PURCHASE_DENIED
          API-->>UI: Deterministic rejection
      else Final approval required
          Policy-->>API: REQUIRE_HUMAN_APPROVAL
          API-->>UI: Show checkout, mandate limit, and checks
          Human->>UI: Approves exact checkout
          UI->>API: Signed checkout-bound approval
          API->>DB: Re-read mandate and revocation state
          API->>Policy: Re-evaluate with approval
      else All checks pass
          Policy-->>API: ALLOW
      end

      API->>DB: Reserve mandate usage atomically
      API->>Pay: Issue checkout-specific credential
      Pay-->>API: Short-lived constrained credential
      API->>Merchant: Complete checkout
      Merchant-->>API: Payment result, order, signed receipt
      API->>DB: Consume reservation and store transaction/order
      API->>Audit: PAYMENT_SUCCEEDED + ORDER_CREATED + RECEIPT_CREATED
      API-->>UI: Receipt and readable evidence trail

  ### Live-revocation behavior

  1. Revocation command writes mandate_revocations, updates mandate status, and appends MANDATE_REVOKED in one transaction.
  2. The next purchase attempt loads that row before evaluating.
  3. The engine returns DENY / MANDATE_REVOKED.
  4. No credential is issued and the merchant is not called for completion.
  5. The same behavior is tested without process restart, fixture changes, or team intervention.

  ## 7. Protocol Responsibility Map

   Technology              Responsibility                                                              P0 treatment
  ━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   AP2                     Open/closed checkout and payment authorization evidence, agent              AP2-shaped ES256/JCS evidence chain; full SD-JWT deferred
                           delegation, checkout binding, receipts, dispute evidence
  ──────────────────────  ──────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────────
   UCP                     Merchant discovery/profile and authoritative checkout lifecycle             Mock VuelaYa adapter uses UCP-shaped checkout semantics; no external
                                                                                                       dependency
  ──────────────────────  ──────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────────
   ACP                     Secondary future commerce adapter                                           Interface compatibility only
  ──────────────────────  ──────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────────
   Stripe SPT              Narrow, time-limited, transaction-specific payment credential               Provider interface plus stub; unavailable access must not block demo
  ──────────────────────  ──────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────────
   Stripe PaymentIntent    Optional real test payment execution                                        P1 adapter
  ──────────────────────  ──────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────────
   MCP                     Optional future agent-facing tools                                          No internal dependency; P2 exposure
  ──────────────────────  ──────────────────────────────────────────────────────────────────────────  ──────────────────────────────────────────────────────────────────────────
   Web crawling            Non-authoritative discovery fallback                                        P2; never accepted for checkout or payment

  UCP’s current REST model uses merchant capability discovery and create/get/update/complete/cancel checkout operations, which the adapter boundary will mirror without leaking
  UCP DTOs into the domain: UCP REST binding (https://ucp.dev/2026-01-23/specification/checkout-rest/). Stripe documents SPTs as transaction-scoped and time-limited but still
  private preview, so mock credentials remain the P0 default: Stripe agentic commerce (https://docs.stripe.com/agentic-commerce).

  ## 8. Frontend Routes and Components

   Route                                 Primary components
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   /auth                                 LoginPage, RegisterPage
  ────────────────────────────────────  ────────────────────────────────────────────────────────────────
   /intents/new                          NewIntentPage, IntentComposer
  ────────────────────────────────────  ────────────────────────────────────────────────────────────────
   /intents/:id/conversation             ConversationPage, ClarificationCard, SpecificationPreview
  ────────────────────────────────────  ────────────────────────────────────────────────────────────────
   /mandates/:id/review                  MandateReviewPage, ConstraintSummary, AuthorizationCeremony
  ────────────────────────────────────  ────────────────────────────────────────────────────────────────
   /mandates                             MandateListPage, MandateStatusBadge
  ────────────────────────────────────  ────────────────────────────────────────────────────────────────
   /mandates/:id                         MandateDetailPage, VersionHistory, RevokeMandateDialog
  ────────────────────────────────────  ────────────────────────────────────────────────────────────────
   /intents/:id/search                   SearchProgressPage, ProviderProgress, AgentActivityTimeline
  ────────────────────────────────────  ────────────────────────────────────────────────────────────────
   /intents/:id/offers                   OfferComparisonPage, OfferCard, RankingExplanation
  ────────────────────────────────────  ────────────────────────────────────────────────────────────────
   /purchase-attempts/:id                SelectedDealPage, AuthoritativeCheckoutCard, PolicyChecksPanel
  ────────────────────────────────────  ────────────────────────────────────────────────────────────────
   /approvals/:attemptId                 HumanApprovalPage, CheckoutBindingSummary
  ────────────────────────────────────  ────────────────────────────────────────────────────────────────
   /purchases/:transactionId/success     PurchaseSuccessPage, ReceiptCard
  ────────────────────────────────────  ────────────────────────────────────────────────────────────────
   /history                              PurchaseHistoryPage
  ────────────────────────────────────  ────────────────────────────────────────────────────────────────
   /transactions/:id                     TransactionDetailPage, EvidenceSummary
  ────────────────────────────────────  ────────────────────────────────────────────────────────────────
   /transactions/:id/audit               AuditTrailPage, AuditEventTimeline, IntegrityBadge
  ────────────────────────────────────  ────────────────────────────────────────────────────────────────
   /transactions/:id/dispute             DisputePage, EvidenceBundleViewer
  ────────────────────────────────────  ────────────────────────────────────────────────────────────────
   /merchant/verifications/:attemptId    MerchantVerificationPage
  ────────────────────────────────────  ────────────────────────────────────────────────────────────────
   /auditor/transactions/:id             AuditorEvidencePage

  Every checkout UI displays current authoritative price, mandate cap, merchant, product/category, deterministic decision, individual checks, approval requirement, and agent
  ranking explanation as separate concepts.

  ## 9. Audit Events

  P0 event types:

  - USER_REGISTERED
  - SESSION_AUTHENTICATED
  - AGENT_REGISTERED
  - PURCHASE_INTENT_CREATED
  - INTENT_CLARIFICATION_REQUESTED
  - INTENT_CLARIFIED
  - SPECIFICATIONS_FINALIZED
  - MANDATE_DRAFTED
  - MANDATE_AUTHORIZED
  - MANDATE_VERSION_DRAFTED
  - MANDATE_UPDATED
  - MANDATE_SUPERSEDED
  - MANDATE_REVOKED
  - MANDATE_EXPIRED
  - DISCOVERY_STARTED
  - OFFER_DISCOVERED
  - DISCOVERY_COMPLETED
  - OFFER_SELECTED
  - QUOTE_REFRESHED
  - CHECKOUT_CREATED
  - CHECKOUT_SIGNATURE_VERIFIED
  - MANDATE_EVALUATED
  - PURCHASE_DENIED
  - HUMAN_APPROVAL_REQUESTED
  - HUMAN_APPROVAL_GRANTED
  - HUMAN_APPROVAL_DENIED
  - PAYMENT_AUTHORIZATION_CREATED
  - PAYMENT_CREDENTIAL_ISSUED
  - PAYMENT_CREDENTIAL_REVOKED
  - PAYMENT_ATTEMPTED
  - PAYMENT_SUCCEEDED
  - PAYMENT_FAILED
  - ORDER_CREATED
  - RECEIPT_CREATED
  - DISPUTE_OPENED
  - DISPUTE_EVIDENCE_ASSEMBLED
  - DISPUTE_RESOLVED

  Viewer projections redact fields rather than creating separate event histories:

  - Human: understandable intent, decision, purchase, receipt, and dispute details.
  - Merchant: checkout, agent, mandate verification, credential, and completion evidence.
  - Auditor: complete evidence with integrity checks and protocol artifacts.

  ## 10. Security Boundaries

  - Browser state is untrusted; frontend-submitted status or evaluation results are ignored.
  - The Trusted Surface renders a server-produced canonical mandate and records explicit, recent user consent.
  - LLM responses and tool arguments are untrusted structured input.
  - Only the backend orchestration service may invoke payment credential issuance.
  - The pure mandate engine is the authorization boundary.
  - Merchant quotes become authoritative only after signature, expiry, merchant identity, and checkout hash validation.
  - Provider secrets and signing keys remain server-side and are loaded from secrets, not committed configuration.
  - P0 development signing keys use protected environment secrets; production evolution moves keys to KMS/HSM.
  - Raw cards and raw reusable payment credentials are never accepted, stored, or logged.
  - Payment-provider references, last-four display metadata, token hashes, scope, and expiry may be stored.
  - Rate limits apply to login, intent messages, discovery, purchase attempts, approvals, and disputes.
  - Strict CORS allowlist, security headers, output encoding, Angular sanitization, and no rendering of arbitrary model HTML.
  - Replay protection uses nonces, checkout hashes, one-time credential jti, expiry, consumption markers, and idempotency records.
  - Signed evidence verification includes algorithm allowlists, issuer/key lookup, audience, time claims, canonical hashes, and checkout binding.
  - Audit payloads are canonicalized and hash-chained; mutation is denied at both DB privilege and trigger levels.

  ## 11. P0/P1/P2 Milestone Roadmap

  Each milestone is independently promptable as “Build milestone Mx.”

  ### P0 — Required live-demo path

   Milestone                             Purpose and likely modules/files       Dependencies         Acceptance criteria                    Required tests
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   M0: Database and project              Create root docs/Compose,              None                 Clean database migrates from zero;     Migration smoke test, FK/check/
   foundation                            standalone backend, PostgreSQL                              rollback strategy documented;          unique constraint tests
                                         connection, Drizzle schema,                                 Marta, agent, VuelaYa, and flight
                                         migrations, seed framework, data                            fixtures seed repeatably
                                         dictionary, and ERD
  ────────────────────────────────────  ─────────────────────────────────────  ───────────────────  ─────────────────────────────────────  ─────────────────────────────────────
   M1: Authentication and identities     auth, users, agents, session           M0                   User registers/logs in/out; only       Password/session/expiry/CSRF/
                                         middleware, CSRF/origin enforcement                         owners access their resources;         ownership integration tests
                                                                                                     seeded agent has distinct identity/
                                                                                                     key
  ────────────────────────────────────  ─────────────────────────────────────  ───────────────────  ─────────────────────────────────────  ─────────────────────────────────────
   M2: Intent conversation and two       purchase-intents, agent,               M1                   Natural-language intent can be         Schema, clarification, ownership,
   specifications                        deterministic mock provider, strict                         clarified and finalized into           prompt-injection/tool-input tests
                                         schemas                                                     separate search and authorization
                                                                                                     specs; malformed agent output fails
                                                                                                     closed
  ────────────────────────────────────  ─────────────────────────────────────  ───────────────────  ─────────────────────────────────────  ─────────────────────────────────────
   M3: Mandates, versions,               mandates, crypto utilities, Trusted    M2                   Draft can be authorized;               Canonicalization/signature,
   signatures, revocation                Surface authorization commands                              replacement creates immutable          transition, concurrent update,
                                                                                                     version; old version is superseded;    revocation tests
                                                                                                     revoke is immediately visible
  ────────────────────────────────────  ─────────────────────────────────────  ───────────────────  ─────────────────────────────────────  ─────────────────────────────────────
   M4: Deterministic mandate engine      Pure policy-engine package/module      M3                   Pure evaluation supports agent,        Exhaustive unit matrix including
                                         and reason-code catalog                                     status, expiry, revocation,            $130 allow and $300 deny
                                                                                                     merchant, category, product,
                                                                                                     quantity, amount, currency, usage,
                                                                                                     checkout binding, and approval
                                                                                                     rules
  ────────────────────────────────────  ─────────────────────────────────────  ───────────────────  ─────────────────────────────────────  ─────────────────────────────────────
   M5: VuelaYa discovery                 discovery, merchants, mock VuelaYa     M2                   Seeded flights are discovered and      Normalization, provider failure,
                                         provider, normalized offers                                 normalized; agent ranks them;          preliminary filtering, ranking
                                                                                                     discovery remains explicitly non-      fixture tests
                                                                                                     authoritative
  ────────────────────────────────────  ─────────────────────────────────────  ───────────────────  ─────────────────────────────────────  ─────────────────────────────────────
   M6: Authoritative checkout and        commerce, checkout, purchase-          M4–M5                Selected offer refreshes to an         Quote drift, signature, expiry,
   purchase attempts                     orchestration; merchant-signed UCP-                         expiring signed checkout; policy       binding, replay integration tests
                                         shaped checkout                                             evaluation is persisted; stale/
                                                                                                     tampered/reused checkout fails
  ────────────────────────────────────  ─────────────────────────────────────  ───────────────────  ─────────────────────────────────────  ─────────────────────────────────────
   M7: Human approval                    approvals and re-evaluation flow       M6                   Required approval pauses execution;    Approval missing/expired/mismatch,
                                                                                                     approval is checkout/version-bound;    re-evaluation, revocation race
                                                                                                     revocation after approval still        tests
                                                                                                     denies
  ────────────────────────────────────  ─────────────────────────────────────  ───────────────────  ─────────────────────────────────────  ─────────────────────────────────────
   M8: Mock credential, payment,         payments, mock credential provider,    M6–M7                Credential is no broader than          Scope, expiration, replay,
   order, receipt                        orders, transactions, signed                                checkout, short-lived and one-use;     idempotency, success/failure tests
                                         receipts                                                    successful mock payment stores
                                                                                                     transaction/order/receipt
  ────────────────────────────────────  ─────────────────────────────────────  ───────────────────  ─────────────────────────────────────  ─────────────────────────────────────
   M9: Audit and dispute backend         audit, hash chaining, role             M1–M8                Every security transition is           Append-only, chain tamper,
                                         projections, disputes evidence                              auditable; chain verifies; dispute     redaction, evidence reconstruction
                                         builder                                                     reconstructs the exact mandate/        tests
                                                                                                     version/checkout/evaluation/
                                                                                                     approval/payment/receipt
  ────────────────────────────────────  ─────────────────────────────────────  ───────────────────  ─────────────────────────────────────  ─────────────────────────────────────
   M10: Frontend foundation, auth,       Angular/Tailwind scaffold,             Stable M1–M2 API     Marta signs in, enters the flight      Angular component tests and auth/
   intent                                generated API client, shell, auth                           request, answers clarification, and    intent E2E
                                         and conversation routes                                     sees both specifications
  ────────────────────────────────────  ─────────────────────────────────────  ───────────────────  ─────────────────────────────────────  ─────────────────────────────────────
   M11: Frontend mandate management      Review, authorization, list/detail/    Stable M3–M4 API     User sees exact constraints,           Review rendering, reauth,
                                         version/revoke pages                                        authorizes, edits through a new        replacement, revocation E2E
                                                                                                     version, and revokes without hidden
                                                                                                     state
  ────────────────────────────────────  ─────────────────────────────────────  ───────────────────  ─────────────────────────────────────  ─────────────────────────────────────
   M12: Frontend purchase workflow       Search progress, comparison,           Stable M5–M9 API     Complete happy path and                Happy path, approval-required,
                                         checkout checks, approval, success/                         deterministic denials are              over-limit, expired tests
                                         history                                                     understandable; merchant and
                                                                                                     auditor projections render
  ────────────────────────────────────  ─────────────────────────────────────  ───────────────────  ─────────────────────────────────────  ─────────────────────────────────────
   M13: Trial-by-fire hardening          E2E suite, demo fixtures/control       All P0 milestones    Judges can authorize, buy, change a    Critical live-revocation and
                                         surface, rate limits, redaction,                            limit, revoke, retry, dispute, and     adversarial Playwright suites
                                         deployment docs                                             inspect all views without team
                                                                                                     intervention

  ### P1 — Important if time permits

  - Real configurable LLM provider while retaining the deterministic mock and JSON-schema validation.
  - Real HTTP UcpCommerceProvider using capability discovery and checkout lifecycle.
  - Stripe PaymentIntent test-mode provider.
  - Stripe SPT provider if preview access is granted.
  - WebAuthn/passkeys for mandate authorization, revocation, and approval.
  - Recurring mandates, rolling budgets, “up to three times per month,” and scheduled price monitoring.
  - Standards-complete AP2 SD-JWT selective disclosure and receipt verification.
  - OpenTelemetry, production rate-limit store, notification delivery, and richer merchant/auditor authentication.
  - Independent VuelaYa deployable service to demonstrate a physical merchant trust boundary.

  ### P2 — Post-hackathon extensibility

  - ACP commerce adapter.
  - MCP server exposing safe application tools.
  - Web discovery/crawling provider with provenance and confidence scoring.
  - Production KMS/HSM custody and key rotation.
  - Multi-tenant merchant onboarding and external verifier endpoints.
  - Distributed workers/outbox and independently scalable services.
  - Payment network dispute integration, refunds, chargebacks, and evidence submission.
  - Formal policy language/versioning and third-party protocol conformance suites.

  ## 12. Exact First Vertical Slice

  The first completed user-visible slice will use one fictional route:

  - User: Marta.
  - Agent: Marta’s personal travel agent with a distinct key.
  - Merchant: VuelaYa.
  - Trip: Mexico City to Córdoba, Argentina, one passenger, fictional dates.
  - Currency: USD.
  - Mandate: maximum $150.00, VuelaYa or any allowed merchant as selected in the draft, flight category only, fixed validity window, one use.
  - Offers: $130.00 and $300.00.
  - Payment: signed short-lived mock credential.
  - Commerce: mock UCP-shaped authoritative checkout.
  - Outcome: $130.00 succeeds with receipt and audit evidence; $300.00 returns AMOUNT_EXCEEDS_MANDATE.
  - Trial by fire: revoke the active mandate, submit a fresh otherwise-valid $130.00 attempt, and receive MANDATE_REVOKED before credential issuance.
  - Dispute: open a dispute on the successful transaction and reconstruct the signed mandate version, checkout, evaluation, payment authorization, result, and receipt.

  This slice deliberately excludes real money, external UCP availability, full AP2 SD-JWT, autonomous background monitoring, and a real LLM. Those integrations cannot weaken or
  alter the deterministic path.

  ## 13. First Files and Modules to Create

  The initial M0 work should create:

  README.md
  compose.yaml
  docs/architecture.md
  docs/database.md
  docs/threat-model.md
  docs/demo-script.md

  backend/package.json
  backend/tsconfig.json
  backend/nest-cli.json
  backend/.env.example
  backend/drizzle.config.ts
  backend/src/main.ts
  backend/src/app.module.ts
  backend/src/config/environment.schema.ts
  backend/src/database/database.module.ts
  backend/src/database/schema/index.ts
  backend/src/database/migrations/
  backend/src/database/seeds/
  backend/test/database/

  frontend/package.json
  frontend/angular.json
  frontend/src/
  frontend/tailwind.config.js

  M0 should not create broad empty feature modules. Each backend module is added only when its milestone begins, starting with Auth in M1 and proceeding feature by feature. The
  Angular scaffold begins in M10 after the backend contracts for the core workflow are stable.

  ## 14. Risks, Unknowns, and Explicit Defaults

  - Stripe SPT is private preview; P0 must never depend on access being granted.
  - No external UCP merchant has been selected; P0 uses a local provider with UCP-shaped behavior, not a claim of interoperability certification.
  - The in-process VuelaYa adapter provides only a logical merchant boundary. A separate deployment is P1.
  - AP2 is evolving. P0 preserves its responsibility boundaries and evidence concepts but will be labeled “AP2-shaped,” not fully compliant.
  - Flight booking normally requires traveler data, ticketing, refunds, and regulatory handling. P0 uses fictional inventory and minimal seeded passenger data.
  - Ambiguous locations, dates, currency, and trip direction must be clarified before the authorization specification can be finalized.
  - A hard mandate violation is denied, never overridden by a generic approval button. The human must authorize a new immutable mandate version to increase authority.
  - P0 uses backend-held Trusted Surface signing keys and platform-attested user consent. Passkey-backed authorization and production key custody are P1.
  - PostgreSQL is the only required infrastructure service for P0.
  - Frontend implementation starts after the database and P0 backend feature APIs are stable, matching the requested database → backend features → frontend sequence.
