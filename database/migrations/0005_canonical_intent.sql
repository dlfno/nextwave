ALTER TABLE purchase_intents ADD COLUMN IF NOT EXISTS intent_draft jsonb;
ALTER TABLE purchase_intents ADD COLUMN IF NOT EXISTS intent_draft_hash text;

ALTER TABLE intent_messages ADD COLUMN IF NOT EXISTS sequence integer;
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY intent_id ORDER BY created_at, id) - 1 AS sequence
  FROM intent_messages
)
UPDATE intent_messages SET sequence = ranked.sequence FROM ranked
WHERE intent_messages.id = ranked.id AND intent_messages.sequence IS NULL;
ALTER TABLE intent_messages ALTER COLUMN sequence SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE intent_messages ADD CONSTRAINT intent_messages_intent_sequence_unique UNIQUE (intent_id, sequence);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

ALTER TABLE mandate_product_constraints ADD COLUMN IF NOT EXISTS origin_iata char(3);
ALTER TABLE mandate_product_constraints ADD COLUMN IF NOT EXISTS destination_iata char(3);
ALTER TABLE mandate_product_constraints ADD COLUMN IF NOT EXISTS departure_date date;

ALTER TABLE checkout_line_items ADD COLUMN IF NOT EXISTS origin_iata char(3);
ALTER TABLE checkout_line_items ADD COLUMN IF NOT EXISTS destination_iata char(3);
ALTER TABLE checkout_line_items ADD COLUMN IF NOT EXISTS departure_date date;
