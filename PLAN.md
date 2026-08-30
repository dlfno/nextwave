 # Agentic Commerce Plan — Express.js Revision

  ## Summary

  Replace NestJS with a standalone Express 5 + TypeScript backend. Angular remains the frontend framework.

  The repository is still empty, so no existing implementation is affected. The implementation order remains:

  1. PostgreSQL schema and migrations.
  2. Express backend, one feature at a time.
  3. Angular frontend after core backend contracts stabilize.
  4. Full trial-by-fire and adversarial testing.

  No files have been changed yet because this session remains constrained to Plan Mode. Milestone M0 below is the first implementation task once execution is enabled.

  ## 1. Project Architecture

  nextwave/
  ├── backend/                 # Express 5 + TypeScript
  ├── frontend/                # Angular + Tailwind CSS
  ├── docs/
  ├── compose.yaml             # PostgreSQL
  └── README.md

  The frontend and backend have independent manifests, lockfiles, builds, and deployments.

  ### Backend foundation

  - Express 5 with TypeScript strict mode and ESM.
  - Zod schemas for runtime request, response, environment, and provider validation.
  - OpenAPI generated from the same Zod contracts.
  - Drizzle ORM with PostgreSQL and committed SQL migrations.
  - pg connection pool.
  - Vitest and Supertest.
  - Pino structured logging.
  - Explicit dependency construction; no framework service locator.
  - Express routers limited to HTTP concerns.
  - Domain and application services independent from Express and Drizzle.

  Express 5 supports rejected-promise forwarding from async handlers, but the application will still have a final typed error middleware and stable error responses. See the
  Express 5 error-handling guide (https://expressjs.com/en/5x/guide/error-handling/).

  ### Backend module structure

  backend/src/
  ├── app.ts                       # Configures and returns an Express app
  ├── server.ts                    # Starts HTTP server and handles shutdown
  ├── bootstrap/
  │   └── container.ts             # Explicit dependency construction
  ├── config/
  ├── database/
  │   ├── client.ts
  │   ├── schema/
  │   ├── migrations/
  │   └── seeds/
  ├── http/
  │   ├── middleware/
  │   ├── errors/
  │   └── openapi/
  ├── modules/
  │   ├── auth/
  │   ├── users/
  │   ├── agents/
  │   ├── purchase-intents/
  │   ├── mandates/
  │   ├── policy-engine/
  │   ├── discovery/
  │   ├── merchants/
  │   ├── commerce/
  │   ├── approvals/
  │   ├── payments/
  │   ├── orders/
  │   ├── audit/
  │   ├── disputes/
  │   └── purchase-orchestration/
  └── shared/
      ├── crypto/
      ├── money/
      ├── time/
      └── types/

  Each feature module may contain:

  domain/          # Entities, value objects, policies, ports
  application/     # Commands, queries, use cases
  infrastructure/  # Drizzle repositories and provider adapters
  http/            # Express router, Zod schemas, HTTP mapping

  ### Middleware order

  1. Trusted proxy configuration.
  2. Correlation/request ID.
  3. Pino request logging with redaction.
  4. Helmet security headers.
  5. CORS allowlist.
  6. Cookie and bounded JSON parsing.
  7. Rate limiting.
  8. Session authentication.
  9. Origin and CSRF enforcement.
  10. Feature routers under /api/v1.
  11. Not-found handler.
  12. Typed error handler.

  ## 2. Component Architecture

  flowchart LR
      subgraph Browser["Untrusted Browser"]
          Angular["Angular Application"]
          TrustedUI["Mandate and Approval UI"]
      end

      subgraph Express["Express Platform API"]
          HTTP["Routers + Zod Validation"]
          Intent["Intent / Agent"]
          Mandates["Mandate Service"]
          Orchestrator["Purchase Orchestrator"]
          Policy["Pure Mandate Engine"]
          Discovery["Discovery Engine"]
          Commerce["Commerce Provider Port"]
          Payment["Credential Provider Port"]
          Orders["Orders / Receipts"]
          Audit["Append-only Audit"]
          Disputes["Dispute Reconstruction"]
      end

      DB[("PostgreSQL")]
      MockLLM["Deterministic Agent Provider"]
      VuelaYa["Mock VuelaYa\nUCP-shaped Adapter"]
      Stripe["Stripe SPT / PaymentIntent\nP1"]

      Angular --> HTTP
      TrustedUI --> HTTP
      HTTP --> Intent
      HTTP --> Mandates
      HTTP --> Orchestrator

      Intent --> MockLLM
      Orchestrator --> Discovery
      Orchestrator --> Commerce
      Orchestrator --> Policy
      Orchestrator --> Payment
      Orchestrator --> Orders

      Commerce --> VuelaYa
      Payment -.-> Stripe

      Intent --> DB
      Mandates --> DB
      Orchestrator --> DB
      Orders --> DB
      Audit --> DB
      Disputes --> DB

  The purchase orchestrator coordinates modules but does not contain policy rules. The deterministic mandate engine remains a pure TypeScript component with no HTTP, database,
  provider, or LLM access.

  ## 3. Database-First Domain Model

  ### Identity and authentication

  - users
  - sessions
  - agents
  - agent_keys
  - webauthn_credentials — P1-ready table, not used in P0

  ### Purchase intent

  - purchase_intents
  - intent_messages
  - discovery_runs
  - offers

  ### Mandates

  - mandates
  - mandate_versions
  - mandate_product_constraints
  - mandate_merchant_allowlist
  - mandate_revocations
  - mandate_usage_reservations

  ### Merchant and checkout

  - merchants
  - merchant_capabilities
  - products
  - quotes
  - checkout_sessions
  - checkout_line_items

  ### Purchase and payment

  - purchase_attempts
  - mandate_evaluations
  - human_approvals
  - payment_authorizations
  - payment_credentials
  - transactions
  - orders
  - order_items
  - receipts

  ### Audit and disputes

  - audit_events
  - disputes
  - dispute_evidence
  - idempotency_records

  ### Important columns and constraints


• Proposed Plan


  # Agentic Commerce Plan — Express.js Revision

  ## Summary

  Replace NestJS with a standalone Express 5 + TypeScript backend. Angular remains the frontend framework.

  The repository is still empty, so no existing implementation is affected. The implementation order remains:

  1. PostgreSQL schema and migrations.
  2. Express backend, one feature at a time.
  3. Angular frontend after core backend contracts stabilize.
  4. Full trial-by-fire and adversarial testing.

  No files have been changed yet because this session remains constrained to Plan Mode. Milestone M0 below is the first implementation task once execution is enabled.

  ## 1. Project Architecture

  nextwave/
  ├── backend/                 # Express 5 + TypeScript
  ├── frontend/                # Angular + Tailwind CSS
  ├── docs/
  ├── compose.yaml             # PostgreSQL
  └── README.md

  The frontend and backend have independent manifests, lockfiles, builds, and deployments.

  ### Backend foundation

  - Express 5 with TypeScript strict mode and ESM.
  - Zod schemas for runtime request, response, environment, and provider validation.
  - OpenAPI generated from the same Zod contracts.
  - Drizzle ORM with PostgreSQL and committed SQL migrations.
  - pg connection pool.
  - Vitest and Supertest.
  - Pino structured logging.
  - Explicit dependency construction; no framework service locator.
  - Express routers limited to HTTP concerns.
  - Domain and application services independent from Express and Drizzle.

  Express 5 supports rejected-promise forwarding from async handlers, but the application will still have a final typed error middleware and stable error responses. See the
  Express 5 error-handling guide (https://expressjs.com/en/5x/guide/error-handling/).

  ### Backend module structure

  backend/src/
  ├── app.ts                       # Configures and returns an Express app
  ├── server.ts                    # Starts HTTP server and handles shutdown
  ├── bootstrap/
  │   └── container.ts             # Explicit dependency construction
  ├── config/
  ├── database/
  │   ├── client.ts
  │   ├── schema/
  │   ├── migrations/
  │   └── seeds/
  ├── http/
  │   ├── middleware/
  │   ├── errors/
  │   └── openapi/
  ├── modules/
  │   ├── auth/
  │   ├── users/
  │   ├── agents/
  │   ├── purchase-intents/
  │   ├── mandates/
  │   ├── policy-engine/
  │   ├── discovery/
  │   ├── merchants/
  │   ├── commerce/
  │   ├── approvals/
  │   ├── payments/
  │   ├── orders/
  │   ├── audit/
  │   ├── disputes/
  │   └── purchase-orchestration/
  └── shared/
      ├── crypto/
      ├── money/
      ├── time/
      └── types/

  Each feature module may contain:

  domain/          # Entities, value objects, policies, ports
  application/     # Commands, queries, use cases
  infrastructure/  # Drizzle repositories and provider adapters
  http/            # Express router, Zod schemas, HTTP mapping

  ### Middleware order

  1. Trusted proxy configuration.
  2. Correlation/request ID.
  3. Pino request logging with redaction.
  4. Helmet security headers.
  5. CORS allowlist.
  6. Cookie and bounded JSON parsing.
  7. Rate limiting.
  8. Session authentication.
  9. Origin and CSRF enforcement.
  10. Feature routers under /api/v1.
  11. Not-found handler.
  12. Typed error handler.

  ## 2. Component Architecture

  flowchart LR
      subgraph Browser["Untrusted Browser"]
          Angular["Angular Application"]
          TrustedUI["Mandate and Approval UI"]
      end

      subgraph Express["Express Platform API"]
          HTTP["Routers + Zod Validation"]
          Intent["Intent / Agent"]
          Mandates["Mandate Service"]
          Orchestrator["Purchase Orchestrator"]
          Policy["Pure Mandate Engine"]
          Discovery["Discovery Engine"]
          Commerce["Commerce Provider Port"]
          Payment["Credential Provider Port"]
          Orders["Orders / Receipts"]
          Audit["Append-only Audit"]
          Disputes["Dispute Reconstruction"]
      end

      DB[("PostgreSQL")]
      MockLLM["Deterministic Agent Provider"]
      VuelaYa["Mock VuelaYa\nUCP-shaped Adapter"]
      Stripe["Stripe SPT / PaymentIntent\nP1"]

      Angular --> HTTP
      TrustedUI --> HTTP
      HTTP --> Intent
      HTTP --> Mandates
      HTTP --> Orchestrator

      Intent --> MockLLM
      Orchestrator --> Discovery
      Orchestrator --> Commerce
      Orchestrator --> Policy
      Orchestrator --> Payment
      Orchestrator --> Orders

      Commerce --> VuelaYa
      Payment -.-> Stripe

      Intent --> DB
      Mandates --> DB
      Orchestrator --> DB
      Orders --> DB
      Audit --> DB
      Disputes --> DB

  The purchase orchestrator coordinates modules but does not contain policy rules. The deterministic mandate engine remains a pure TypeScript component with no HTTP, database,
  provider, or LLM access.

  ## 3. Database-First Domain Model

  ### Identity and authentication

  - users
  - sessions
  - agents
  - agent_keys
  - webauthn_credentials — P1-ready table, not used in P0

  ### Purchase intent

  - purchase_intents
  - intent_messages
  - discovery_runs
  - offers

  ### Mandates

  - mandates
  - mandate_versions
  - mandate_product_constraints
  - mandate_merchant_allowlist
  - mandate_revocations
  - mandate_usage_reservations

  ### Merchant and checkout

  - merchants
  - merchant_capabilities
  - products
  - quotes
  - checkout_sessions
  - checkout_line_items

  ### Purchase and payment

  - purchase_attempts
  - mandate_evaluations
  - human_approvals
  - payment_authorizations
  - payment_credentials
  - transactions
  - orders
  - order_items
  - receipts

  ### Audit and disputes

  - audit_events
  - disputes
  - dispute_evidence
  - idempotency_records

  ### Important columns and constraints

   Table                          Important fields and rules
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   users                          UUID, case-insensitive unique email, Argon2id password hash, display name, role, timestamps
  ─────────────────────────────  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   sessions                       User FK, unique token hash, CSRF hash, expiry, last-used time; never store the raw cookie token
  ─────────────────────────────  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   agents                         Owner user, status, display name, current key ID; distinct from the user identity
  ─────────────────────────────  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   purchase_intents               User, agent, state, original request, separate search and authorization specifications
  ─────────────────────────────  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   mandates                       User, authorized agent, mode, lifecycle status, current version, expiry, revocation timestamp
  ─────────────────────────────  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   mandate_versions               Immutable version number, normalized spend/usage fields, canonical payload, payload hash, signed evidence, algorithm and key ID
  ─────────────────────────────  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   mandate_product_constraints    Product matching mode, product reference/name, category prefix, maximum quantity
  ─────────────────────────────  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   mandate_merchant_allowlist     Version and allowed merchant; absence represents ANY only when the version explicitly allows it
  ─────────────────────────────  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   mandate_revocations            One authoritative revocation per mandate family with actor, timestamp, and reason
  ─────────────────────────────  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   mandate_usage_reservations     Amount, attempt, status, reservation and consumption timestamps for concurrency-safe budgets
  ─────────────────────────────  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   offers                         Normalized discovery data, source, observation time, confidence, and authoritative-checkout capability
  ─────────────────────────────  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   checkout_sessions              Merchant checkout ID, signed checkout, hash, exact total, currency, expiry, status, completion time
  ─────────────────────────────  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   mandate_evaluations            Decision, reason code, complete structured checks, input hash, evaluation time
  ─────────────────────────────  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   human_approvals                User decision bound to checkout hash and mandate version with short expiry
  ─────────────────────────────  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   payment_credentials            Provider reference, token hash, scope, status, expiry and consumption; no raw credential
  ─────────────────────────────  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   audit_events                   Actor, aggregates, event type/version, structured payload, previous hash, event hash
  ─────────────────────────────  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   dispute_evidence               Immutable reconstruction referencing exact signed artifacts and verification results

  Database conventions:

  - PostgreSQL UUID primary keys using gen_random_uuid().
  - timestamptz for all timestamps.
  - Monetary amounts stored in integer minor units using BIGINT.
  - Monetary API fields serialized as decimal strings.
  - ISO 4217 currencies validated and stored as three uppercase characters.
  - Foreign keys and check constraints for all relationships and invariants.
  - PostgreSQL enums for stable lifecycle states.
  - JSONB only for raw provider payloads, signed protocol payloads, and flexible attributes.
  - Every policy-relevant value also receives a normalized typed column.
  - Unique (mandate_id, version) constraint.
  - Partial unique index allowing one active mandate version.
  - Unique checkout hash and consumed credential identifier.
  - Partial indexes for active mandates, pending attempts, unconsumed credentials, and unresolved disputes.
  - Audit events reject UPDATE and DELETE through a database trigger.
  - mandates.current_version_id is nullable during initial draft creation and added as a deferred foreign key after mandate_versions exists.

  ### Initial migration sequence

  0000_extensions_and_enums.sql
  0001_identity_and_sessions.sql
  0002_purchase_intents.sql
  0003_mandates_and_revocations.sql
  0004_merchants_discovery_checkout.sql
  0005_purchase_payment_orders.sql
  0006_audit_disputes_and_integrity.sql

  Required extensions:

  - pgcrypto for UUID generation.
  - citext for normalized unique email addresses.

  Drizzle TypeScript schemas are the application source of truth, while generated SQL migrations are reviewed and committed. Custom SQL migrations handle partial indexes,
  deferred relationships, and audit immutability. Drizzle records applied migrations in PostgreSQL as described in its official migration documentation
  (https://orm.drizzle.team/docs/migrations).

  ## 4. Core Interfaces

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
    getLiveQuote(request: LiveQuoteRequest): Promise<AuthoritativeQuote>;
    createCheckout(request: CreateCheckoutRequest): Promise<SignedCheckout>;
    completeCheckout(request: CompleteCheckoutRequest): Promise<CheckoutResult>;
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
    append(event: NewAuditEvent, tx?: DatabaseTransaction): Promise<AuditEvent>;
    listForIntent(intentId: string, viewer: AuditViewer): Promise<AuditEvent[]>;
    verifyChain(intentId: string): Promise<AuditIntegrityResult>;
  }

  The application layer loads current revocation, usage, signature, checkout, and approval state before invoking MandateEngine. The engine performs no I/O and makes no LLM
  calls.

  ## 5. Authorization Decisions

  Stable decisions:

  - ALLOW
  - DENY
  - REQUIRE_HUMAN_APPROVAL

  Required denial reason codes:

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

  Human approval never overrides a hard failure. Increasing a limit or allowing another merchant requires a newly signed immutable mandate version.

  ## 6. State Lifecycles

  ### Mandate

  stateDiagram-v2
      [*] --> DRAFT
      DRAFT --> ACTIVE: Human authorizes
      DRAFT --> CANCELLED: Human abandons
      ACTIVE --> SUPERSEDED: Replacement version authorized
      ACTIVE --> REVOKED: Human revokes
      ACTIVE --> EXPIRED: Validity ends
      SUPERSEDED --> [*]
      REVOKED --> [*]
      EXPIRED --> [*]
      CANCELLED --> [*]

  - Editing creates a new draft version.
  - The previous version remains active until replacement authorization succeeds.
  - Activating the replacement atomically supersedes the old version.
  - Revocation applies to the whole mandate family.
  - Revoked, expired, and superseded authorization cannot be reactivated.

  ### Purchase/payment attempt

  CREATED
  → QUOTED
  → DENIED
    or APPROVAL_REQUIRED → APPROVED → AUTHORIZED
    or AUTHORIZED
  → CREDENTIAL_ISSUED
  → PAYMENT_SUBMITTED
  → SUCCEEDED | FAILED

  Execution always rechecks current mandate and revocation state. An approved attempt can therefore become DENIED / MANDATE_REVOKED before credential issuance.

  ## 7. Primary End-to-End Flow

  sequenceDiagram
      actor Human
      participant UI as Angular Trusted Surface
      participant API as Express API
      participant Agent as Purchasing Agent
      participant DB as PostgreSQL
      participant Merchant as VuelaYa Adapter
      participant Policy as Mandate Engine
      participant Pay as Credential Provider

      Human->>UI: Request flight below $150
      UI->>API: Create intent
      API->>Agent: Clarify route, date, currency
      Agent-->>UI: Clarification questions
      Human->>UI: Supply missing constraints
      Agent->>API: Search spec + authorization spec
      API-->>UI: Render canonical mandate
      Human->>UI: Reauthenticate and authorize
      API->>DB: Store signed immutable mandate version

      API->>Merchant: Discover offers
      Merchant-->>API: $130 and $300 observed offers
      API->>Merchant: Obtain live signed checkout
      API->>DB: Load mandate, revocation and usage
      API->>Policy: Evaluate immutable inputs

      alt Hard failure
          Policy-->>API: DENY with checks
          API-->>UI: Deterministic rejection
      else Approval required
          Policy-->>API: REQUIRE_HUMAN_APPROVAL
          API-->>UI: Display bound checkout
          Human->>UI: Approve exact checkout
          API->>DB: Reload live authorization state
          API->>Policy: Re-evaluate
      else Allowed
          Policy-->>API: ALLOW
      end

      API->>DB: Reserve mandate usage
      API->>Pay: Issue checkout-specific credential
      Pay-->>API: Short-lived credential
      API->>Merchant: Complete checkout
      Merchant-->>API: Order and signed receipt
      API->>DB: Store transaction, order and evidence
      API-->>UI: Receipt and audit trail

  ## 8. REST API

  All routes are under /api/v1.

  ### Authentication

  - POST /auth/register
  - POST /auth/login
  - POST /auth/logout
  - GET /auth/me
  - POST /auth/reauthenticate

  ### Intent and conversation

  - POST /purchase-intents
  - GET /purchase-intents
  - GET /purchase-intents/:intentId
  - POST /purchase-intents/:intentId/messages
  - POST /purchase-intents/:intentId/finalize-specifications
  - GET /purchase-intents/:intentId/events — SSE

  ### Mandates

  - POST /purchase-intents/:intentId/mandates/draft
  - GET /mandates
  - GET /mandates/:mandateId
  - POST /mandates/:mandateId/authorize
  - POST /mandates/:mandateId/versions
  - POST /mandates/:mandateId/versions/:version/authorize
  - POST /mandates/:mandateId/revoke

  ### Discovery and execution

  - POST /purchase-intents/:intentId/discovery-runs
  - GET /discovery-runs/:runId
  - GET /discovery-runs/:runId/offers
  - POST /purchase-intents/:intentId/select-offer
  - POST /purchase-intents/:intentId/purchase-attempts
  - GET /purchase-attempts/:attemptId
  - POST /purchase-attempts/:attemptId/approval
  - POST /purchase-attempts/:attemptId/execute
  - POST /purchase-attempts/:attemptId/cancel

  ### Records, merchant, auditor and dispute views

  - GET /transactions
  - GET /transactions/:transactionId
  - GET /transactions/:transactionId/receipt
  - GET /transactions/:transactionId/audit
  - GET /merchant/verifications/:attemptId
  - GET /auditor/transactions/:transactionId/evidence
  - POST /transactions/:transactionId/disputes
  - GET /disputes/:disputeId
  - POST /disputes/:disputeId/resolve

  ## 9. Security and Audit

  - Argon2id passwords and opaque database-backed sessions.
  - Secure, HttpOnly, SameSite cookies; only token hashes stored.
  - CSRF token and allowed-origin checks for commands.
  - Recent authentication for authorization, replacement, revocation, and final approval.
  - Strict Zod validation with unknown fields rejected.
  - Server-side ownership and role enforcement.
  - Request body and conversation length limits.
  - Idempotency keys for revocation, purchase, approval, and execution.
  - ES256 signed evidence with RFC 8785 canonical JSON and SHA-256/base64url hashes.
  - Algorithm allowlists and key IDs; no trust in payload-provided verification keys.
  - Short-lived, merchant- and checkout-bound mock credentials.
  - No raw card details or reusable credentials.
  - Append-only audit events with per-intent previous/event hashes.
  - Credentials, secrets, cookies and sensitive traveler information redacted from logs.
  - Rate limiting for login, agent messages, discovery, purchase, approval, and disputes.

  Core audit events include intent creation/clarification, mandate drafting/authorization/versioning/revocation, discovery, offer selection, checkout creation/verification,
  policy evaluation, approval, credential issuance, payment, order, receipt, and dispute reconstruction.

  ## 10. Protocol Responsibilities

   Protocol                Responsibility                                             Hackathon implementation
  ━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   AP2                     Open/closed checkout and payment authorization evidence    Signed open credentials and checkout-bound closed mandate presentation
  ──────────────────────  ─────────────────────────────────────────────────────────  ─────────────────────────────────────────────────
   UCP                     Merchant checkout lifecycle                                UCP 2026-04-08 REST + AP2 extension against external NubeVia simulator
  ──────────────────────  ─────────────────────────────────────────────────────────  ─────────────────────────────────────────────────
   ACP                     Future alternate commerce adapter                          Interface only
  ──────────────────────  ─────────────────────────────────────────────────────────  ─────────────────────────────────────────────────
   Stripe SPT              Constrained payment credential                             Opt-in test adapter; mock default without preview access
  ──────────────────────  ─────────────────────────────────────────────────────────  ─────────────────────────────────────────────────
   Stripe PaymentIntent    Optional test payment                                      Implemented behind Stripe SPT test provider
  ──────────────────────  ─────────────────────────────────────────────────────────  ─────────────────────────────────────────────────
   MCP                     Optional external agent tools                              P2
  ──────────────────────  ─────────────────────────────────────────────────────────  ─────────────────────────────────────────────────
   Crawling                Discovery fallback only                                    Safe opt-in HTML/JSON-LD fallback; never authoritative
  ──────────────────────  ─────────────────────────────────────────────────────────  ─────────────────────────────────────────────────
   Duffel                  Live carrier discovery                                     Optional server-side live/sandbox search; discovery-only until booking adapter

  ## 11. Milestones

  ### P0 backend and database

   Milestone                       Purpose                                         Acceptance criteria                             Tests
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   M0 Database foundation          Create Compose, Express project foundation,     Empty database migrates successfully; all       Migration smoke, schema constraint, audit
                                   Drizzle schema, migrations, seed framework      tables, constraints and indexes exist; seeds    immutability and clean-reset tests
                                   and database docs                               are repeatable
  ──────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────
   M1 Authentication               Users, agents, sessions, CSRF and ownership     Marta can authenticate securely and can         Password, session, expiry, CSRF and
                                                                                   access only her resources                       ownership integration tests
  ──────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────
   M2 Intent and specifications    Conversation plus separate search/              Valid structured specifications are             Schema, clarification and malicious input
                                   authorization outputs using deterministic       persisted; malformed output fails closed        tests
                                   agent
  ──────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────
   M3 Mandates                     Draft, authorize, version, sign, expire and     Immutable signed versions and immediate         Signature, lifecycle, replacement,
                                   revoke                                          revocation work                                 concurrency and revocation tests
  ──────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────
   M4 Mandate engine               Pure deterministic policy checks                $130 allows, $300 denies, and all required      Exhaustive unit decision matrix
                                                                                   restrictions are enforced
  ──────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────
   M5 Discovery                    Mock VuelaYa catalog, normalization and         Offers are normalized and clearly non-          Provider, normalization, filtering and
                                   ranking                                         authoritative                                   ranking tests
  ──────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────
   M6 Checkout                     Live quote, signed checkout and purchase        Tampered, expired, mismatched or reused         Signature, binding, price drift and replay
                                   attempt                                         checkout fails                                  tests
  ──────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────
   M7 Human approval               Checkout-specific approval flow                 Execution pauses and re-evaluates after         Missing, expired, mismatched and post-
                                                                                   approval                                        approval revocation tests
  ──────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────
   M8 Payment and order            Mock credential, mock payment, order and        Credential is narrow, short-lived and           Scope, expiry, replay, idempotency and
                                   receipt                                         single-use                                      payment tests
  ──────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────  ──────────────────────────────────────────────
   M9 Audit and disputes           Event chain, projections and evidence           Human, merchant and auditor views derive        Hash-chain, redaction and dispute tests
                                   reconstruction                                  from one valid history

  ### P0 frontend

  - M10: Angular/Tailwind foundation, authentication and intent conversation.
  - M11: Mandate review, authorization, version management and revocation.
  - M12: Discovery, offer comparison, authoritative checkout and approval.
  - M13: Purchase history, receipts, audit views, merchant verification and disputes.
  - M14: Playwright trial-by-fire suite and deployable demo.

  ### Implemented extensions

  - Real OpenAI Responses API clarification provider with schema-constrained output.
  - Multi-merchant discovery with merchant API, mock, and external HTTP/UCP adapters.
  - Separately deployed NubeVia UCP 2026-04-08 merchant with AP2 mandate verification.
  - Optional Stripe PaymentIntent/SPT test provider when private-preview access is available.
  - Safe, opt-in web discovery fallback with SSRF and robots protections; results cannot pay.
  - Optional Duffel carrier search with truthful live/sandbox labeling and a hard discovery-only boundary.

  ### Remaining P1

  - Passkeys/WebAuthn.
  - Scheduled price monitoring.
  - Recurrence and rolling-budget policies.
  - Standards-complete AP2 SD-JWT.
  - OpenTelemetry and production key management.

  ### P2

  - ACP and MCP interfaces.
  - Multi-tenant merchant onboarding.
  - Distributed jobs and outbox.
  - External dispute/chargeback integrations.
  - Production KMS/HSM and protocol conformance testing.

  ## 12. Exact First Vertical Slice

  - Marta logs in.
  - She requests a Mexico City to Córdoba, Argentina flight below $150.
  - The deterministic agent produces separate search and authorization specifications.
  - Marta authorizes a signed, one-use mandate.
  - VuelaYa exposes fictional $130 and $300 offers.
  - The selected offer becomes a signed authoritative checkout.
  - The $130 checkout passes deterministic evaluation.
  - A short-lived mock credential is issued and consumed.
  - An order, receipt and complete audit history are stored.
  - The $300 checkout is denied with AMOUNT_EXCEEDS_MANDATE.
  - Marta revokes the mandate.
  - A fresh $130 attempt is denied with MANDATE_REVOKED before credential issuance.
  - A dispute reconstructs the exact mandate version, checkout, evaluation, approval state, payment authorization and receipt.

  ## 13. First Files for M0

  README.md
  compose.yaml
  docs/architecture.md
  docs/database.md
  docs/threat-model.md

  backend/package.json
  backend/package-lock.json
  backend/tsconfig.json
  backend/.env.example
  backend/drizzle.config.ts
  backend/src/app.ts
  backend/src/server.ts
  backend/src/config/environment.ts
  backend/src/database/client.ts
  backend/src/database/schema/enums.ts
  backend/src/database/schema/identity.ts
  backend/src/database/schema/intents.ts
  backend/src/database/schema/mandates.ts
  backend/src/database/schema/commerce.ts
  backend/src/database/schema/payments.ts
  backend/src/database/schema/audit.ts
  backend/src/database/schema/index.ts
  backend/src/database/migrations/
  backend/src/database/seeds/demo.ts
  backend/test/database/migrations.test.ts
  backend/test/database/constraints.test.ts

  M0 implements the complete baseline database but does not create empty feature routers or placeholder business services. Backend features begin individually with M1 after
  migrations and schema tests pass.
