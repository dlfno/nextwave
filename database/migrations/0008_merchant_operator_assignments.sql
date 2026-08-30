CREATE TABLE merchant_operator_assignments (
  merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, user_id)
);

CREATE INDEX merchant_operator_assignments_user_idx
  ON merchant_operator_assignments (user_id, merchant_id);
