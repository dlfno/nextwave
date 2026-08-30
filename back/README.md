# Nextwave API

Express 5 and TypeScript API for the agentic commerce platform.

## Local development

Start PostgreSQL and prepare the database from the repository root:

```sh
docker compose up -d postgres
./database/scripts/migrate.sh
./database/scripts/seed.sh
```

Then start the API:

```sh
cd back
cp .env.example .env
npm install
npm run dev
```

The API listens on port 3000 by default. `GET /health` is unauthenticated.

## OpenAI purchasing agent

The real agent uses the OpenAI Responses API with Structured Outputs. Paste the
API key into `OPENAI_API_KEY` in `back/.env` for local development. When the key
is absent, the backend deliberately falls back to the deterministic mock provider
so tests and offline rehearsals remain usable.

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_CLARIFICATION_MODEL=gpt-5.6-luna
OPENAI_RESEARCH_MODEL=gpt-5.6-terra
OPENAI_TIMEOUT_MS=20000
```

When running `compose.demo.yaml`, put the key in the repository-root `.env`
instead. The key is passed only to the Express API container and is never bundled
into Angular. Both `.env` files are ignored by Git; restart the API after changing
one.

The LLM clarifies intent and produces separate structured search and authorization
specifications. It does not approve mandates, issue payment credentials, or run
the deterministic mandate engine.

The clarification provider uses Luna today. The research model setting reserves
Terra for the multi-merchant discovery/ranking milestone; configuring it now does
not cause research calls or spend until that provider is implemented and invoked.

Intent creation also records trusted browser context: IANA timezone, locale,
request time, and—only after browser permission—coarsened city-level coordinates.
This lets the agent resolve phrases such as `tomorrow` and `end of the month`
without repeatedly asking for timezone details. Coordinates are rounded before
leaving the browser. The context is a convenience signal, never purchasing
authority.

AP2 secures the mandate and payment evidence after intent is understood; it does
not gather a user profile. UCP can carry buyer, fulfillment, and provisional
context data to a merchant checkout, but Nextwave remains responsible for storing,
verifying, and selectively disclosing that information. Sensitive profile and
payment fields must not be placed in the LLM prompt merely to avoid a checkout
question.

## Purchase intent conversation

Milestone 2 exposes:

- `POST /api/v1/purchase-intents`
- `GET /api/v1/purchase-intents`
- `GET /api/v1/purchase-intents/:intentId`
- `POST /api/v1/purchase-intents/:intentId/messages`
- `POST /api/v1/purchase-intents/:intentId/finalize-specifications`

The offline fallback provider is deterministic and intentionally limited to the
VuelaYa flight demo. Both providers clarify origin, Córdoba country/airport, departure date,
passenger count, price currency, mandate validity, and final-confirmation policy.
For example:

```text
Depart from Mexico City (MEX) to Córdoba, Argentina (COR), departing
2026-09-15, one passenger, USD, valid until 2026-09-05. No final confirmation.
```

Finalization produces independent `searchSpecification` and
`authorizationSpecification` objects. Provider output is schema-validated before
it is persisted and never represents an authorization decision.

## Mandate signing and lifecycle

Generate a development ES256 signing key once:

```sh
npm run key:generate
```

Put the resulting one-line private JWK in `MANDATE_SIGNING_PRIVATE_JWK` and set a
stable `MANDATE_SIGNING_KEY_ID`. Do not commit the generated key. Production key
custody should move to KMS/HSM; the environment-backed key is the P0 Trusted
Surface implementation.

Mandate endpoints include:

- `POST /api/v1/purchase-intents/:intentId/mandates/draft`
- `GET /api/v1/mandates` and `GET /api/v1/mandates/:mandateId`
- `POST /api/v1/mandates/:mandateId/authorize`
- `POST /api/v1/mandates/:mandateId/versions`
- `POST /api/v1/mandates/:mandateId/versions/:version/authorize`
- `POST /api/v1/mandates/:mandateId/revoke`

Authorization and revocation require authentication within the last five minutes.
Signed evidence uses canonical JSON, SHA-256, and ES256 compact JWS. Replacements
remain drafts until authorized; activation atomically supersedes the prior version.

Autonomous authorization also issues the two AP2 v0.2 open credentials required
for delegation: `mandate.checkout.open.1` and `mandate.payment.open.1`. They use
ES256 compact SD-JWT serialization, bind to a separate Shopping Agent key through
`cnf.jwk`, and are stored with independent hashes for later closed-mandate and
dispute verification. The flight-specific checkout constraint is documented in
[`docs/ap2-flight-constraint.md`](docs/ap2-flight-constraint.md). AP2 supplies
authorization artifacts inside the commerce flow; it does not replace the UCP
merchant endpoints or require a standalone AP2 HTTP server.

At execution, the platform creates closed `mandate.checkout.1` and
`mandate.payment.1` content. Both are signed in one transaction authorization;
the checkout hash is SHA-256 over the exact serialized merchant checkout JWT and
the Payment Mandate uses that same hash as `transaction_id`. Successful mock
payments persist three distinct receipts: the user-facing order receipt, an
AP2 Checkout Receipt signed by the merchant, and an AP2 Payment Receipt signed
by the mock payment processor. Both AP2 receipts reference the exact closed
mandate presentation hash and are included in dispute reconstruction.

## Deterministic mandate policy engine

Milestone 4 adds a pure TypeScript `DeterministicMandateEngine`. Its caller must
load the current mandate, online revocation state, authoritative checkout,
reserved/consumed usage, and any human approval before evaluation. The engine
performs no I/O and makes no LLM calls.

The result is `ALLOW`, `DENY`, or `REQUIRE_HUMAN_APPROVAL`, accompanied by a
stable reason code and an ordered list of machine-readable checks. It validates
the mandate and checkout signatures, authorized agent, lifecycle and validity,
live revocation, checkout freshness and context binding, merchant/product/category,
quantity, amount, currency, recurrence, budget, and checkout-bound approval.
Approval evidence never overrides a failed mandate constraint.

## Discovery

Milestone 5 exposes:

- `POST /api/v1/purchase-intents/:intentId/discovery-runs`
- `GET /api/v1/discovery-runs/:runId`
- `GET /api/v1/discovery-runs/:runId/offers`

Discovery requires an authorized mandate. The P0 `MockVuelaYaDiscoveryProvider`
returns the fictional $130 and $300 MEX–COR offers for the demo search. Provider
results are runtime-validated, filtered for availability and currency, normalized,
ranked, and persisted. Every offer response includes `authoritative: false`:
discovery prices are evidence for comparison only. Milestone 6 must obtain a live
merchant quote and checkout before mandate evaluation or payment.

An opt-in `WebDiscoveryProvider` can crawl configured merchant search pages only
when every structured primary provider returns no usable offers. Configure at
most five HTTPS sources in `WEB_DISCOVERY_SOURCES_JSON`; templates may use
`{origin}`, `{destination}`, `{date}`, `{currency}`, and `{query}`. For example:

```dotenv
WEB_DISCOVERY_SOURCES_JSON=[{"id":"merchant-web","merchantId":"10000000-0000-4000-8000-000000000003","searchUrlTemplate":"https://merchant.example/flights?from={origin}&to={destination}&date={date}"}]
```

The crawler identifies itself, honors `robots.txt`, validates every redirect,
blocks loopback/private/link-local destinations, accepts HTML only, caps response
size and time, and extracts schema.org Flight/Offer JSON-LD without executing page
scripts. Pasted page instructions are data and never reach an authorization prompt.
Every result is labeled `sourceType: WEB`, has reduced confidence, and sets
`supportsAuthoritativeCheckout: false`; it therefore cannot be selected for
payment until a separate merchant adapter refreshes it into an authoritative
checkout.

### Live Duffel flight research

Set a Duffel access token to add current carrier offers to the structured primary
providers:

```dotenv
DUFFEL_ACCESS_TOKEN=duffel_live_...
DUFFEL_SUPPLIER_TIMEOUT_MS=10000
DUFFEL_SEARCH_TIMEOUT_MS=15000
DUFFEL_MAX_OFFERS=20
```

For Docker, put these values in the repository-root `.env`; for local API
development, use `back/.env`. The token is sent only from Express to Duffel and
must never be placed in Angular. An empty token leaves the provider disabled.

Duffel test tokens exercise the same adapter but return sandbox schedules and
prices. Only an activated account and live token return current airline data.
The account billing currency must match the mandate currency for results to pass
normalization; the demo expects USD.

The adapter requests one-way economy offers for the canonical route, date, and
adult passenger count. It stores only normalized itinerary metadata, explicitly
labels live versus sandbox data, and uses Duffel's total for all passengers as
the amount screened against the mandate. Duffel offers are research-only in this
milestone: `supportsAuthoritativeCheckout` remains false, so they cannot cross
into the AP2/UCP payment circuit. The local VuelaYa, AeroSur, and NubeVia offers
remain available as clearly labeled demo-checkout options.

Milestone 20 upgrades NubeVia to the UCP `2026-04-08` REST checkout and AP2
Mandates Extension boundary. In the
container demo, Compose starts the merchant automatically and configures
`NUBEVIA_UCP_BASE_URL=http://nubevia:3100`. NubeVia owns its catalog, authoritative
quote, checkout state, and persistent ES256 signing key. It advertises checkout
and `dev.ucp.common.payment.ap2_mandate` at `/.well-known/ucp`; Nextwave negotiates
those capabilities, verifies the detached `ap2.merchant_authorization`, and sends
the closed `ap2.checkout_mandate` on `complete_checkout`. NubeVia independently
verifies the mandate signature, expiry, merchant, amount, currency, and exact
merchant-signed checkout hash before creating an order. Product search and quote
refresh remain explicitly merchant-specific APIs because UCP checkout—not scraped
or discovery data—is the authoritative purchase boundary. For a
manual local run, configure `NUBEVIA_SIGNING_PRIVATE_JWK`, start
`npm run dev:nubevia`, and point the API at `http://localhost:3100`; leaving the
base URL empty retains the deterministic in-process fallback.

## Authoritative checkout

Milestone 6 adds the merchant commerce boundary and these endpoints:

- `POST /api/v1/purchase-intents/:intentId/select-offer`
- `POST /api/v1/purchase-intents/:intentId/purchase-attempts`
- `GET /api/v1/purchase-attempts/:attemptId`

Both command endpoints accept `{ "offerId": "..." }` and create a purchase
attempt from a fresh VuelaYa quote and merchant-signed checkout. The response
shows `priceDriftMinor` between discovery and the authoritative quote. Checkout
evidence is ES256-signed with a merchant-specific key and bound to the exact
attempt, quote, offer, mandate version, merchant, amount, currency, and expiry.
Configure `VUELAYA_SIGNING_PRIVATE_JWK` separately from the mandate key.

## Policy evaluation and human approval

Milestone 7 exposes:

- `POST /api/v1/purchase-attempts/:attemptId/evaluate`
- `POST /api/v1/purchase-attempts/:attemptId/approval`

Evaluation reloads current revocation, usage, mandate signature, merchant checkout
signature, checkout binding, and approval evidence before invoking the pure policy
engine. Results and their input hash are persisted. The approval command accepts
`APPROVED` or `DENIED`, requires recent authentication, and signs evidence bound
to the exact checkout hash and mandate version. It then runs a fresh evaluation;
approval never overrides a hard failure or a later mandate revocation.

## Payment and order

Milestone 8 exposes `POST /api/v1/purchase-attempts/:attemptId/execute`.
Execution always performs a fresh online mandate evaluation before issuing a
credential. The mock credential is restricted to the exact merchant, checkout,
amount, and currency, expires within 60 seconds, and is single-use. Only its hash
and provider reference are stored. Successful execution consumes mandate usage,
completes the merchant checkout, and persists a transaction, confirmed order,
line items, and signed receipt. Repeating execution for the same successful
attempt returns the original result without issuing another credential.

Milestone 19 adds an opt-in Stripe SPT test provider. Stripe currently documents
Shared Payment Tokens as a private-preview feature, so the hackathon stack keeps
`PAYMENT_CREDENTIAL_PROVIDER=mock` by default. If your Stripe account has access,
put a test secret in the root `.env` (Compose) or `back/.env` (local API) and set:

```dotenv
PAYMENT_CREDENTIAL_PROVIDER=stripe-spt-test
STRIPE_SECRET_KEY=sk_test_...
STRIPE_SPT_TEST_PAYMENT_METHOD=pm_card_visa
```

The provider uses Stripe's test helper to obtain an amount-, currency-, seller-,
and expiry-constrained SPT, then confirms one idempotent PaymentIntent. The SPT
itself exists only in process memory during execution; PostgreSQL and audit events
receive an internal reference and SHA-256 hash, never the bearer credential or a
PaymentIntent client secret. If SPT preview access is absent, leave the provider
set to `mock` so the full demo continues to work offline.

## Audit, records, and disputes

Milestone 9 records security and commerce actions in an append-only SHA-256 hash
chain per purchase intent. Human, merchant, and auditor projections are derived
from that same event history. Record endpoints include transaction history/detail,
receipt, human audit, merchant verification, auditor evidence, and dispute opening,
viewing, and resolution. Dispute evidence reconstructs the exact signed mandate
version, checkout, evaluations, approval, constrained payment authorization,
credential metadata, transaction, order, and receipt; raw credential hashes are
excluded from the evidence bundle.

## Authentication and CSRF

Registration and login set two cookies:

- `nextwave_session`: opaque, `HttpOnly` session token.
- `nextwave_csrf`: readable CSRF token.

For authenticated `POST`, `PUT`, `PATCH`, and `DELETE` requests, the Angular
client must send the CSRF cookie value in `X-CSRF-Token`. Requests must also use
the configured `FRONTEND_ORIGIN` and include credentials.

## Tests

Integration tests require a migrated, disposable PostgreSQL database:

```sh
TEST_DATABASE_URL=postgresql://nextwave:nextwave_dev@localhost:5432/nextwave_test npm test
```

The test suite truncates user-owned data. Never point `TEST_DATABASE_URL` at a
database containing data that must be retained.
