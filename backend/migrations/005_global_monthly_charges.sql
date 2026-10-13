CREATE TABLE IF NOT EXISTS global_monthly_charges (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  description VARCHAR(200) NOT NULL,
  monthly_amount NUMERIC(12,2) NOT NULL CHECK (monthly_amount >= 0),
  starts_on DATE NOT NULL,
  duration_months INTEGER NOT NULL DEFAULT 60 CHECK (duration_months > 0 AND duration_months <= 600),
  apply_to_all BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS global_monthly_charge_branches (
  charge_id BIGINT NOT NULL REFERENCES global_monthly_charges(id) ON DELETE CASCADE,
  branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (charge_id, branch_id)
);

CREATE INDEX IF NOT EXISTS global_monthly_charges_starts_on_idx
  ON global_monthly_charges(starts_on);
