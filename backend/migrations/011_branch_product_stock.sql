CREATE TABLE IF NOT EXISTS branch_product_stock (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  device_model_id BIGINT NOT NULL REFERENCES device_models(id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (branch_id, device_model_id)
);

CREATE INDEX IF NOT EXISTS branch_product_stock_branch_idx
  ON branch_product_stock(branch_id);

INSERT INTO stock_locations(name, address)
VALUES ('Cespiti', NULL)
ON CONFLICT (name) DO NOTHING;
