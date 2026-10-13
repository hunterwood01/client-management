CREATE TABLE IF NOT EXISTS license_finance_monthly_snapshots (
  license_order_id INTEGER NOT NULL REFERENCES license_purchase_orders(id) ON DELETE CASCADE,
  month_start DATE NOT NULL,
  active_branches INTEGER NOT NULL DEFAULT 0 CHECK (active_branches >= 0),
  canone_per_branch NUMERIC(14,2) NOT NULL DEFAULT 0,
  allocated_cost_per_branch NUMERIC(14,6) NOT NULL DEFAULT 0,
  monthly_revenue NUMERIC(14,2) NOT NULL DEFAULT 0,
  monthly_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_contribution NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (license_order_id, month_start)
);

CREATE INDEX IF NOT EXISTS idx_license_finance_snapshots_month
  ON license_finance_monthly_snapshots(month_start);
