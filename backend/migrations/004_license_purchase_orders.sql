CREATE TABLE IF NOT EXISTS license_purchase_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  license_name VARCHAR(200) NOT NULL,
  supplier VARCHAR(200),
  reference VARCHAR(200),
  purchased_on DATE,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_cost NUMERIC(12,2) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  renewal_on DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS license_purchase_orders_date_idx ON license_purchase_orders(purchased_on DESC NULLS LAST, created_at DESC);
