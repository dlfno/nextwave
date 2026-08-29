BEGIN;

CREATE UNIQUE INDEX mandates_one_per_intent_idx
  ON mandates (intent_id)
  WHERE intent_id IS NOT NULL;

INSERT INTO schema_migrations (name) VALUES ('0003_mandate_intent_uniqueness.sql');

COMMIT;
