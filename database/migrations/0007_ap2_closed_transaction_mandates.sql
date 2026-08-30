ALTER TABLE payment_authorizations
  ADD COLUMN ap2_checkout_mandate_payload jsonb,
  ADD COLUMN ap2_payment_mandate_payload jsonb,
  ADD COLUMN ap2_presentation text,
  ADD COLUMN ap2_presentation_hash bytea;

ALTER TABLE payment_authorizations ADD CONSTRAINT payment_authorizations_ap2_closed_pair
  CHECK (
    (ap2_checkout_mandate_payload IS NULL AND ap2_payment_mandate_payload IS NULL
      AND ap2_presentation IS NULL AND ap2_presentation_hash IS NULL)
    OR
    (ap2_checkout_mandate_payload IS NOT NULL AND ap2_payment_mandate_payload IS NOT NULL
      AND ap2_presentation IS NOT NULL AND ap2_presentation_hash IS NOT NULL)
  );
