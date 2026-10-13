ALTER TABLE global_monthly_charges
  ADD COLUMN IF NOT EXISTS license_order_id BIGINT REFERENCES license_purchase_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS monthly_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (monthly_cost >= 0);

CREATE INDEX IF NOT EXISTS global_monthly_charges_license_order_idx
  ON global_monthly_charges(license_order_id);
