ALTER TABLE mandate_versions
  ADD COLUMN IF NOT EXISTS ap2_open_checkout_payload jsonb,
  ADD COLUMN IF NOT EXISTS ap2_open_checkout_credential text,
  ADD COLUMN IF NOT EXISTS ap2_open_checkout_hash bytea,
  ADD COLUMN IF NOT EXISTS ap2_open_payment_payload jsonb,
  ADD COLUMN IF NOT EXISTS ap2_open_payment_credential text,
  ADD COLUMN IF NOT EXISTS ap2_open_payment_hash bytea;

DO $$ BEGIN
  ALTER TABLE mandate_versions ADD CONSTRAINT mandate_versions_ap2_open_pair
    CHECK (
      (ap2_open_checkout_payload IS NULL AND ap2_open_checkout_credential IS NULL
        AND ap2_open_checkout_hash IS NULL AND ap2_open_payment_payload IS NULL
        AND ap2_open_payment_credential IS NULL AND ap2_open_payment_hash IS NULL)
      OR
      (ap2_open_checkout_payload IS NOT NULL AND ap2_open_checkout_credential IS NOT NULL
        AND ap2_open_checkout_hash IS NOT NULL AND ap2_open_payment_payload IS NOT NULL
        AND ap2_open_payment_credential IS NOT NULL AND ap2_open_payment_hash IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
