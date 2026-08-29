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

## Purchase intent conversation

Milestone 2 exposes:

- `POST /api/v1/purchase-intents`
- `GET /api/v1/purchase-intents`
- `GET /api/v1/purchase-intents/:intentId`
- `POST /api/v1/purchase-intents/:intentId/messages`
- `POST /api/v1/purchase-intents/:intentId/finalize-specifications`

The P0 agent provider is deterministic and intentionally limited to the VuelaYa
flight demo. It clarifies origin, Córdoba country/airport, departure date,
passenger count, price currency, mandate validity, and final-confirmation policy.
For example:

```text
Depart from Mexico City (MEX) to Córdoba, Argentina (COR), departing
2026-09-15, one passenger, USD, valid until 2026-09-05. No final confirmation.
```

Finalization produces independent `searchSpecification` and
`authorizationSpecification` objects. Provider output is schema-validated before
it is persisted and never represents an authorization decision.

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
