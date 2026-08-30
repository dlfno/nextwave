BEGIN;

ALTER TABLE purchase_intents
  ADD COLUMN client_context jsonb;

INSERT INTO schema_migrations (name) VALUES ('0004_purchase_intent_client_context.sql');

COMMIT;
