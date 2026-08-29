# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**MandatePay** — a hackathon demo of the full circuit of an AI-agent-made purchase done safely.
A human (Marta) authorizes her agent with a signed **Intent Mandate**, a merchant (VuelaYa)
cryptographically verifies every purchase attempt, and everything lands in a hash-chained
audit trail. Guiding principle: **el LLM propone, el mandato dispone** — the LLM interprets and
explains; verification is 100% deterministic and cryptographic. Nomenclature follows AP2
(Agent Payments Protocol): Intent Mandate / Cart Mandate, keys bound to the mandate.

Design decisions and the real bugs that motivated them live in `DECISIONS.md` — read it before
changing verification order, the agent loop, the LLM guards, or the frontend polling behavior.
Code comments and docs are in Spanish; keep new ones in Spanish to match.

## Commands

```bash
# Backend — Express + better-sqlite3, port 3000
cd back && npm install && npm start        # node ./bin/www

# Frontend — Angular 20 SPA, port 4200, proxies /api -> :3000
cd front && npm install && npm start       # ng serve

# Smoke test the whole circuit over the API (backend must be running on :3000)
cd back && ./demo.sh

# Frontend unit tests (Karma/Jasmine) — no backend test suite exists
cd front && npm test                       # ng test
cd front && ng test --include='**/api.spec.ts'   # single spec

# Reset the demo from scratch
rm database/nextwave.db*                    # backend recreates + reseeds on next start
```

There is no linter configured. `front` has a Prettier config in its `package.json`
(100 cols, single quotes).

### LLM layer (optional)

Everything works with deterministic fallbacks and **no API key**. To enable natural-language
mandate parsing and agent explanations: `cp back/.env.example back/.env` and set
`OPENAI_API_KEY`. Model defaults to `gpt-4o-mini` (`OPENAI_MODEL`).

## Architecture

### One Express process simulates three parties

`back/` is a single server; the three parties are separated only by route namespace
(see `back/app.js`). The merchant "knows" the wallet only through `services/verify.js`
(representing a live query). Do not collapse that boundary.

- `/api/wallet` (`routes/wallet.js`) — Autorizador "PagoSeguro": issues/revokes mandates,
  turns NL text into a mandate (one-shot `POST /parse-mandate` and the multi-turn
  `POST /mandate-chat`), human-in-the-loop approvals, live limit edits for judges.
- `/api/merchant` (`routes/merchant.js`) — "VuelaYa": flight catalog, `POST /checkout`
  (where all verification happens), live price edits, per-attempt verification view.
- `/api/agent` (`routes/agent.js`) — console + control for the agents.
- `/api/audit` (`routes/audit.js`) — the hash-chained trail and `/trail/verify`.
- `/api/disputes` (`routes/disputes.js`) — Marta disputes a purchase; resolved by
  deterministic replay of the trail, LLM only drafts the wording.

### The verification pipeline — `back/services/verify.js`

`verifyPurchase({ cart, agent_signature })` returns
`{ status: 'approved' | 'rejected' | 'pending_approval', reason, checks }`. Checks run in a
**deliberate order** (DECISIONS.md #8): mandate exists -> wallet Ed25519 signature over the
mandate -> agent signature over the cart (against the key *bound to the mandate*, anti-
impersonation) -> live status (not revoked) -> in validity window -> category -> **per-purchase
limit (exceed => `pending_approval`, escalate to human, never silent reject)** -> total budget
(catches split purchases) -> rich conditions (`lib/conditions.js`: `price_below`, `destination`,
`max_uses_per_month`). Every check is recorded even on success. `services/checkout.js` persists
the attempt + an audit event; a nonexistent mandate is stored with `mandate_id = NULL`
(DECISIONS.md #10).

### Crypto — `back/lib/crypto.js`

Native Node Ed25519. **Canonical serialization** (`canonical()`, recursively sorted keys) is
what makes signer and verifier see identical bytes — any payload that gets signed or verified
must go through it. Private keys for `wallet` / `agent-marta` / `agent-rogue` are generated
once and stored in the `keys` table (`db.js` `ensureKeys`). Changing a mandate's limits
invalidates its signature, so `PATCH /wallet/mandates/:id` **re-signs** with the wallet key
(DECISIONS.md #7).

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
  "simulate agent error" button (DECISIONS.md #16). `runner.start()` is called from `app.js`.
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
`db.js` seeds one user, payment method, two agents, and five flights only if `users` is empty.
The `.db` file is gitignored. `better-sqlite3` is synchronous — DB calls are not awaited.

### Frontend — `front/`

Angular 20 standalone SPA, **SSR removed** (DECISIONS.md #3). Four pages under
`src/app/pages/` (`human`, `merchant`, `agent`, `auditor`), one per route, templates inline,
all styles in the global `src/styles.css`. `human` authorizes through a **chat** plus a
confirmation **modal** whose summary is built locally from the draft (DECISIONS.md #21).
Change detection runs with `eventCoalescing`, so a plain field bound with `[(ngModel)]` and
cleared in code may not repaint — keep template-bound state in signals (DECISIONS.md #22).
`src/app/services/api.ts` provides the thin
`Api` HTTP wrapper plus two helpers used everywhere:
- `poll(fn, ms = 2000)` — refresh on an interval while a component lives.
- `setIfChanged(signal, data)` — JSON-compares before `signal.set()` so the 2s poll does not
  wipe an input a judge is typing into (DECISIONS.md #19). Use it for every polled signal.
