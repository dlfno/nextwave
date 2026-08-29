BEGIN;

ALTER TABLE sessions
  ADD COLUMN reauthenticated_at timestamptz NOT NULL DEFAULT now();

INSERT INTO schema_migrations (name) VALUES ('0002_session_reauthentication.sql');

COMMIT;
