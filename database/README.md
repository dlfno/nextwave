# Database

PostgreSQL is the system of record for identity, purchase intent, mandates, live
revocation, commerce, payment metadata, orders, audit evidence, and disputes.

## Local setup

From the repository root:

```sh
docker compose up -d postgres
./database/scripts/migrate.sh
./database/scripts/seed.sh
./database/scripts/test.sh
```

The scripts use `DATABASE_URL` when it is set and otherwise connect to the local
development database configured in `compose.yaml`.

## Migration policy

- Never edit an applied migration. Add a new numbered SQL file instead.
- Keep policy-relevant fields normalized; JSONB is for external evidence and
  flexible provider payloads.
- Store monetary values as integer minor units and timestamps as `timestamptz`.
- Mandate versions and audit events are immutable evidence.
- Revocation is an online database state checked for every purchase execution.

The baseline migration creates `schema_migrations`. Each later migration must
insert its own filename into that table in the same transaction.

## Seed data

The idempotent demo seed creates VuelaYa, its mock UCP checkout capability, and
two fictional Mexico City-to-Córdoba catalog items priced at USD 130 and USD 300.
It intentionally does not seed login credentials.
