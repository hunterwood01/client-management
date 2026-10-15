ALTER TABLE device_models ADD COLUMN IF NOT EXISTS sku VARCHAR(100);
CREATE UNIQUE INDEX IF NOT EXISTS device_models_sku_unique_idx ON device_models(sku) WHERE sku IS NOT NULL AND sku <> '';
ALTER TABLE purchase_profiles ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0);
ALTER TABLE purchase_profiles ADD COLUMN IF NOT EXISTS stock_location_id BIGINT REFERENCES stock_locations(id) ON DELETE RESTRICT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS sale_price NUMERIC(12,2) CHECK (sale_price IS NULL OR sale_price >= 0);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS activated_on DATE;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS deactivated_on DATE;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS stock_consumed BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS product_stock (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 device_model_id BIGINT NOT NULL REFERENCES device_models(id) ON DELETE RESTRICT,
 stock_location_id BIGINT NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,
 quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(device_model_id, stock_location_id)
);
CREATE TABLE IF NOT EXISTS product_stock_movements (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 device_model_id BIGINT NOT NULL REFERENCES device_models(id) ON DELETE RESTRICT,
 stock_location_id BIGINT NOT NULL REFERENCES stock_locations(id) ON DELETE RESTRICT,
 quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
 movement_type VARCHAR(30) NOT NULL CHECK (movement_type IN ('order','activation','adjustment','return')),
 purchase_profile_id BIGINT REFERENCES purchase_profiles(id) ON DELETE RESTRICT,
 device_id BIGINT REFERENCES devices(id) ON DELETE RESTRICT,
 notes TEXT,
 moved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
 moved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_stock_movements_date_idx ON product_stock_movements(moved_at DESC);
CREATE TABLE IF NOT EXISTS device_nol_history (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 device_id BIGINT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
 branch_id BIGINT REFERENCES branches(id) ON DELETE RESTRICT,
 activated_on DATE NOT NULL,
 deactivated_on DATE,
 monthly_fee NUMERIC(12,2) NOT NULL CHECK (monthly_fee >= 0),
 purchase_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (purchase_cost >= 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK (deactivated_on IS NULL OR deactivated_on >= activated_on)
);
CREATE INDEX IF NOT EXISTS device_nol_history_device_dates_idx ON device_nol_history(device_id, activated_on, deactivated_on);
