# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**MandatePay** — a hackathon demo of the full circuit of an AI-agent-made purchase done safely.
A human (Marta) asks for something in plain language; the wallet **scrapes the real web** for
that product, judges whether the request is achievable, and hands back a **ticket de mandato**
whose variables (brand, airline, weight, price…) she can edit, discuss or sign. Signing produces
an **Intent Mandate**; a merchant (VuelaYa) cryptographically verifies every purchase attempt
against it, and everything lands in a hash-chained audit trail. Guiding principle: **el LLM
propone, el mandato dispone** — the LLM interprets, researches and explains; verification and
the feasibility verdict are 100% deterministic. Nomenclature follows AP2 (Agent Payments
Protocol): Intent Mandate / Cart Mandate, keys bound to the mandate.

Design decisions and the real bugs that motivated them live in `DECISIONS.md` — read it before
changing verification order, the agent loop, the LLM guards, or the frontend polling behavior.
Code comments and docs are in Spanish; keep new ones in Spanish to match.

## Commands

```bash
# Backend — 3 Express services (better-sqlite3, shared DB). npm start runs all three
# with concurrently, staggered: wallet :3001, merchant :3002, agent :3003 (DECISIONS #33).
cd back && npm install && npm start
#   npm run start:wallet | start:merchant | start:agent   # one at a time
#   npm run start:mono                                     # legacy all-in-one on :3000

# Frontend — Angular 20 SPA, port 4200. proxy.conf.json routes /api/wallet + /api/audit
# + /api/disputes -> :3001, /api/merchant -> :3002, /api/agent -> :3003
cd front && npm install && npm start       # ng serve

# Smoke test the whole circuit over the API (all 3 services must be running)
cd back && ./demo.sh

# Backend tests for the verification engine (node:test, no deps)
cd back && npm test                        # node --test test/*.test.js

# Reset the demo from scratch
rm database/nextwave.db*                    # backend recreates + reseeds on next start
```

There is no linter configured. `front` has a Prettier config in its `package.json`
(100 cols, single quotes).

### LLM layer (optional)

Everything works with deterministic fallbacks and **no API key**. To enable natural-language
intent extraction, product extraction from unstructured pages, and the human wording of the
feasibility verdict: `cp back/.env.example back/.env` and set `OPENAI_API_KEY`. Model defaults
to `gpt-4o-mini` (`OPENAI_MODEL`).

### Data sources — no API keys

No product data source needs a key (DECISIONS.md #32). Do not reintroduce Amadeus: its
self-service portal shut down on 2026-07-17 (DECISIONS.md #31). Before adding any vendor
API, check it is not key-gated and cannot be switched off.

## Architecture

### Three Express services, talking over HTTP (DECISIONS #33)

`back/` runs as three independent processes (`back/apps/{wallet,merchant,agent}.js`, shared
middleware in `apps/base.js`, selected by `APP` in `bin/www`). The monolithic `back/app.js`
is kept for `start:mono` / debugging; `npm test` doesn't use it.

- **wallet :3001** — mounts `/api/wallet`, `/api/audit`, `/api/disputes`. Owns the DB:
  boots first, creates the schema and seeds. Exposes **`POST /api/wallet/verify`** — the
  live verification the merchant calls.
- **merchant :3002** — mounts `/api/merchant`. `services/checkout.js` calls
  `POST ${WALLET_URL}/api/wallet/verify` over HTTP (`lib/rpc.js`); a wallet it can't reach
  ⇒ `rejected` ("verificación no disponible"), never `approved`.
- **agent :3003** — mounts `/api/agent` + the runner loop. `agents/{runner,rogue}.js`
  buy by `POST`ing to `${MERCHANT_URL}/api/merchant/checkout`, not by an in-process call.

Cross-service URLs are in `back/config.js` (`WALLET_URL`, `MERCHANT_URL` env overrides).
**Deliberately kept shared** (DECISIONS #33): one SQLite file (WAL + `busy_timeout` set
first so simultaneous boot doesn't throw `SQLITE_BUSY`) and one audit hash-chain — all three
processes still `require('./db')` and `audit.append()` directly. Do not split the DB per
service or add a gateway without re-reading #33.

- `/api/wallet` (`routes/wallet.js`) — Autorizador "PagoSeguro": the **ticket flow**
  (`POST /tickets` → research → `PATCH /tickets/:id` → `POST /tickets/:id/chat` →
  `POST /tickets/:id/sign`), issues/revokes mandates, human-in-the-loop approvals, live limit
  edits for judges.
- `/api/merchant` (`routes/merchant.js`) — "VuelaYa": product catalog (`GET /products`),
  `POST /checkout` (delegates verification to the wallet over HTTP), live price edits,
  per-attempt verification view.
- `/api/agent` (`routes/agent.js`) — console + control for the agents.
- `/api/audit` (`routes/audit.js`) — the hash-chained trail and `/trail/verify`.
- `/api/disputes` (`routes/disputes.js`) — Marta disputes a purchase; resolved by
  deterministic replay of the trail, LLM only drafts the wording.

### The verification pipeline — `back/services/verify.js`

Runs inside the **wallet** process, reached by the merchant via `POST /api/wallet/verify`.
`verifyPurchase({ cart, agent_signature })` returns
`{ status: 'approved' | 'rejected' | 'pending_approval', reason, checks }`. Checks run in a
**deliberate order** (DECISIONS.md #8): mandate exists -> wallet Ed25519 signature over the
mandate -> agent signature over the cart (against the key *bound to the mandate*, anti-
impersonation) -> live status (not revoked) -> in validity window -> product type -> **per-purchase
limit (exceed => `pending_approval`, escalate to human, never silent reject)** -> total budget
(catches split purchases) -> the mandate's **spec** against the item's real attributes plus the
monthly frequency cap. Every check is recorded even on success. `services/checkout.js` persists
the attempt + an audit event; a nonexistent mandate is stored with `mandate_id = NULL`
(DECISIONS.md #10).

### The spec engine — `back/lib/spec.js`

A mandate's conditions are a typed list `[{attr, op, value}]` with
`eq/neq/lt/lte/gt/gte/in/contains/between`, evaluated against the cart's `attributes`
(price included as one more attribute). Attribute names go through an **alias table** to a
canonical form (`precio`/`price`, `destination`/`destino`, `gramaje`/`peso` → `gramaje_g`);
**never match by prefix** — that bug made `precio` resolve against `precio_observado`, a date
(DECISIONS.md #28). A missing attribute fails its check: nothing is approved that cannot be
checked. `sanitize()` drops anything the engine could not evaluate later, and every path that
accepts a spec (LLM output, ticket edits, `POST /mandates`) must run through it.
Covered by `back/test/spec.test.js` — run it after touching this file.

### The ticket flow — `back/services/tickets.js`

One row in `tickets` per NL request: intent (LLM, with a deterministic regex fallback) →
`scraper.research()` → `market.assess()` → editable draft → signature. Research runs in the
background; the route answers immediately with `status: 'researching'` and the front polls.
Attributes the user mentioned are **promoted to spec constraints** deterministically
(DECISIONS.md #27) — otherwise the signed mandate would not restrict brand or weight.
Feasibility is decided by `lib/market.js` (deterministic); the LLM only words it, and it
**never blocks signing** — signing against the recommendation is audited (DECISIONS.md #26).

### The scraper — `back/scraper/`

Real network calls with per-adapter (25s) and per-page (11s) budgets; a failing source is
reported as a failed source, never as missing data. `index.js` picks adapters by
`product_type`, runs them in parallel, converts every price to one currency (`fx.js`), and
hashes the snapshot — that hash goes inside the signed mandate payload so the auditor can
replay against exactly what the holder saw (DECISIONS.md #25). Adapters: `catalog` (the
merchant's own `products`, always on, the demo's offline floor), `openfoodfacts` (Open Prices
first, then the OFF catalog), `web` (DuckDuckGo lite → JSON-LD `schema.org/Product` → Open
Graph → LLM on cleaned text). No adapter may infer an attribute the page did not state, and a
candidate without a price is dropped. `scrape_cache` (TTL) keeps the 2s front-end poll from
hitting the network.

Candidates then pass `lib/relevance.js` — a deterministic filter requiring the candidate to
be the product actually asked for. Without it, "coffee, brand Carrefour" pulled in that
brand's mayonnaise and the market median came from it (DECISIONS.md #32). Any new adapter
that searches by a single term must use `relevance.terms(query)[0]` (the head noun), never
the longest word.

The web adapter's search step is the fragile link: DuckDuckGo rate-limits by IP and answers
200/202 with an anomaly page rather than an HTTP error. `buscar()` detects that and throws,
so a blocked search is reported as a failed source — never as an empty market. Keep that
distinction in any search backend you add.

### Crypto — `back/lib/crypto.js`

Native Node Ed25519. **Canonical serialization** (`canonical()`, recursively sorted keys) is
what makes signer and verifier see identical bytes — any payload that gets signed or verified
must go through it. Private keys for `wallet` / `agent-marta` / `agent-rogue` are generated
once and stored in the `keys` table (`db.js` `ensureKeys`). Changing a mandate's limits
invalidates its signature, so `PATCH /wallet/mandates/:id` **re-signs** with the wallet key
via `resignMandate()` (DECISIONS.md #7). The signed payload includes `product_type`, `spec`
and `evidence_hash`.

### Audit trail — `back/lib/audit.js`

`hash = sha256(prev_hash + actor + event + canonical(payload) + created_at)`, `prev_hash` of
the first row is `'GENESIS'`. `verifyChain()` walks the chain in one pass; any past-entry
tampering breaks every subsequent hash. `append(actor, event, payload)` is called from
services and routes at every state change — keep new state changes audited.

### Agents — `back/agents/`

- `runner.js` — Marta's legit agent: a `setInterval` loop every 3s watching flight prices.
  The buy decision is **deterministic** (`localFit` when the mandate is active, `basicFit`
  when revoked so the merchant-side rejection shows live — DECISIONS.md #14). Attempts are
  deduped by `mandateVersion` + flight price (DECISIONS.md #15). `forceAttempt()` powers the
  "simulate agent error" button (DECISIONS.md #16). `runner.start()` is called from
  `apps/agent.js` (and `app.js` in mono mode). Both agents `POST` to the merchant over HTTP.
- `rogue.js` — `attackAll()`: impersonation (wrong key), disguised category, split purchase,
  oversized amount, nonexistent mandate. All must be blocked with a reason.

### LLM layer — `back/lib/llm.js`

Every call has a deterministic fallback and a 6s timeout; callers catch and fall back, and the
UI badges "llm" vs "fallback" so it never lies about what ran. `fixValidUntil` is the
**deterministic guard** that rolls a past `valid_until` year forward so a mandate is never born
expired (DECISIONS.md #18) and formats the date in local time to avoid a timezone off-by-one;
both `parseMandate` (one shot) and `chatMandate` (multi-turn) run their output through it.
`chatMandate` converses to build the mandate but **never decides it is complete** — the route
computes `ready` from the required fields and overrides the model (DECISIONS.md #21).
`draftDisputeVerdict` is told never to contradict the already-decided `verdict`.

### Database

`database/schema.sql` is `exec`'d on every backend start (all `CREATE TABLE IF NOT EXISTS`);
`db.js` then runs `migrate()` (legacy `category`/`conditions_json`/`flights` → `product_type`/
`spec_json`/`products`, re-signing migrated mandates) and seeds one user, payment method, two
agents, and five flight products only if `users` is empty. Table rebuilds must set
`PRAGMA legacy_alter_table = ON` — otherwise `ALTER TABLE RENAME` rewrites *other* tables' FKs
(DECISIONS.md #23). The `.db` file is gitignored. `better-sqlite3` is synchronous — DB calls are
not awaited.

### Frontend — `front/`

Angular 20 standalone SPA, **SSR removed** (DECISIONS.md #3). Four pages under
`src/app/pages/` (`human`, `merchant`, `agent`, `auditor`), one per route, templates inline,
all styles in the global `src/styles.css`. `human` authorizes through a **chat** that opens a
**ticket de mandato**: an editable table of the product variables, the market evidence with
its sources and links, the feasibility verdict, and the sign button (DECISIONS.md #21, #24).
Ticket inputs bind with `[value]` + `(change)`, not `(ngModelChange)` — the latter fired a
PATCH per keystroke and the response repainted the field mid-typing.
Change detection runs with `eventCoalescing`, so a plain field bound with `[(ngModel)]` and
cleared in code may not repaint — keep template-bound state in signals (DECISIONS.md #22).
`src/app/services/api.ts` provides the thin
`Api` HTTP wrapper plus two helpers used everywhere:
- `poll(fn, ms = 2000)` — refresh on an interval while a component lives.
- `setIfChanged(signal, data)` — JSON-compares before `signal.set()` so the 2s poll does not
  wipe an input a judge is typing into (DECISIONS.md #19). Use it for every polled signal.
