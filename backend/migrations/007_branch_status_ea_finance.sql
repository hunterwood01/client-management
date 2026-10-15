ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS active_since DATE NOT NULL DEFAULT DATE '2026-10-01';

UPDATE branches SET is_active = TRUE WHERE is_active IS NULL;

CREATE TABLE IF NOT EXISTS branch_active_history (
  id BIGSERIAL PRIMARY KEY,
  branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL,
  active_since DATE NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS branch_active_history_branch_date_idx
  ON branch_active_history(branch_id, active_since);

INSERT INTO branch_active_history(branch_id, is_active, active_since)
SELECT b.id, TRUE, COALESCE(b.active_since, DATE '2026-10-01')
FROM branches b
WHERE NOT EXISTS (SELECT 1 FROM branch_active_history h WHERE h.branch_id = b.id);

ALTER TABLE license_purchase_orders
  ADD COLUMN IF NOT EXISTS ea_monthly_revenue NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (ea_monthly_revenue >= 0),
  ADD COLUMN IF NOT EXISTS ea_monthly_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (ea_monthly_cost >= 0),
  ADD COLUMN IF NOT EXISTS ea_starts_on DATE NOT NULL DEFAULT DATE '2026-10-01';

UPDATE license_purchase_orders l
SET ea_monthly_revenue = COALESCE(g.monthly_amount, 0),
    ea_monthly_cost = COALESCE(g.monthly_cost, 0),
    ea_starts_on = COALESCE(g.starts_on, DATE '2026-10-01')
FROM (
  SELECT DISTINCT ON (license_order_id) license_order_id, monthly_amount, monthly_cost, starts_on
  FROM global_monthly_charges
  WHERE license_order_id IS NOT NULL
  ORDER BY license_order_id, starts_on DESC, created_at DESC
) g
WHERE g.license_order_id = l.id;

CREATE UNIQUE INDEX IF NOT EXISTS global_monthly_charges_one_per_license_order_idx
  ON global_monthly_charges(license_order_id) WHERE license_order_id IS NOT NULL;
