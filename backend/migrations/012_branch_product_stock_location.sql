ALTER TABLE branch_product_stock
  ADD COLUMN IF NOT EXISTS stock_location_id INTEGER
  REFERENCES stock_locations(id) ON DELETE SET NULL;
