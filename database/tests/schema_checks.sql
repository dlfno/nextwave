BEGIN;

DO $$
DECLARE
  missing_tables text[];
BEGIN
  SELECT array_agg(required.name ORDER BY required.name)
  INTO missing_tables
  FROM (
    VALUES
      ('users'), ('sessions'), ('agents'), ('purchase_intents'), ('mandates'),
      ('mandate_versions'), ('mandate_revocations'), ('merchants'), ('offers'),
      ('checkout_sessions'), ('payment_credentials'), ('transactions'), ('orders'),
      ('audit_events'), ('disputes')
  ) AS required(name)
  WHERE to_regclass('public.' || required.name) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION 'missing required tables: %', missing_tables;
  END IF;
END;
$$;

DO $$
DECLARE
  user_id uuid := gen_random_uuid();
  agent_id uuid := gen_random_uuid();
  mandate_id uuid := gen_random_uuid();
  version_id uuid := gen_random_uuid();
  current_status mandate_status;
BEGIN
  INSERT INTO users (id, email, password_hash, display_name)
  VALUES (user_id, 'schema-test@example.com', 'not-a-real-password-hash', 'Schema Test');

  INSERT INTO agents (id, owner_user_id, name)
  VALUES (agent_id, user_id, 'Schema Test Agent');

  INSERT INTO mandates (id, user_id, agent_id, status, mode, expires_at)
  VALUES (mandate_id, user_id, agent_id, 'DRAFT', 'AUTONOMOUS', now() + interval '1 day');

  BEGIN
    INSERT INTO mandate_versions (
      mandate_id, version, status, max_total_minor, currency, valid_from, valid_until,
      canonical_payload
    ) VALUES (
      mandate_id, 1, 'DRAFT', -1, 'USD', now(), now() + interval '1 day', '{}'::jsonb
    );
    RAISE EXCEPTION 'negative mandate amount was accepted';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  INSERT INTO mandate_versions (
    id, mandate_id, version, status, max_total_minor, currency, valid_from, valid_until,
    max_uses, canonical_payload, payload_hash, signed_payload, signature_algorithm,
    signing_key_id, signed_at
  ) VALUES (
    version_id, mandate_id, 1, 'ACTIVE', 15000, 'USD', now(), now() + interval '1 day',
    1, '{"maxTotalMinor":"15000","currency":"USD"}'::jsonb,
    digest('mandate-test', 'sha256'), 'signed.mandate.test', 'ES256', 'test-key', now()
  );

  UPDATE mandates SET status = 'ACTIVE', current_version_id = version_id WHERE id = mandate_id;

  BEGIN
    UPDATE mandate_versions SET max_total_minor = 30000 WHERE id = version_id;
    RAISE EXCEPTION 'authorized mandate evidence was mutable';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'authorized mandate evidence is immutable' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO mandate_versions (
      mandate_id, version, status, max_total_minor, currency, valid_from, valid_until,
      canonical_payload, payload_hash, signed_payload, signature_algorithm, signing_key_id, signed_at
    ) VALUES (
      mandate_id, 2, 'ACTIVE', 15000, 'USD', now(), now() + interval '1 day',
      '{}'::jsonb, digest('second-active', 'sha256'), 'signed.second.active', 'ES256', 'test-key', now()
    );
    RAISE EXCEPTION 'multiple active mandate versions were accepted';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;

  INSERT INTO mandate_revocations (mandate_id, revoked_by_user_id, reason)
  VALUES (mandate_id, user_id, 'schema test');

  SELECT status INTO current_status FROM mandates WHERE id = mandate_id;
  IF current_status <> 'REVOKED' THEN
    RAISE EXCEPTION 'live revocation did not update mandate state';
  END IF;

  INSERT INTO audit_events (
    event_type, actor_type, actor_id, correlation_id, payload, event_hash
  ) VALUES (
    'SCHEMA_TEST_EVENT', 'SYSTEM', user_id, gen_random_uuid(), '{}'::jsonb,
    digest(gen_random_uuid()::text, 'sha256')
  );

  BEGIN
    UPDATE audit_events SET payload = '{"tampered":true}'::jsonb
    WHERE event_type = 'SCHEMA_TEST_EVENT' AND actor_id = user_id;
    RAISE EXCEPTION 'audit event update was accepted';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'audit_events are append-only' THEN
        RAISE;
      END IF;
  END;
END;
$$;

ROLLBACK;

SELECT 'database schema checks passed' AS result;
