CREATE TABLE IF NOT EXISTS companies (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  legal_name VARCHAR(200) NOT NULL UNIQUE,
  tax_code VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS branches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id BIGINT NOT NULL REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  country VARCHAR(100) NOT NULL DEFAULT 'Italia',
  street VARCHAR(300) NOT NULL,
  nomenclature VARCHAR(100),
  previous_nomenclature VARCHAR(100),
  network VARCHAR(100),
  phone_prefix VARCHAR(30),
  wlc VARCHAR(200),
  status VARCHAR(30) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS branches_company_id_idx ON branches(company_id);

CREATE TABLE IF NOT EXISTS stock_locations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(160) NOT NULL UNIQUE,
  address VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_models (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  manufacturer VARCHAR(120) NOT NULL,
  model_name VARCHAR(160) NOT NULL,
  category VARCHAR(100) NOT NULL,
  ownership_type VARCHAR(20) NOT NULL DEFAULT 'sale' CHECK (ownership_type IN ('sale', 'rental')),
  default_purchase_cost NUMERIC(12,2) CHECK (default_purchase_cost IS NULL OR default_purchase_cost >= 0),
  default_monthly_fee NUMERIC(12,2) CHECK (default_monthly_fee IS NULL OR default_monthly_fee >= 0),
  useful_life_months INTEGER CHECK (useful_life_months IS NULL OR useful_life_months > 0),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(manufacturer, model_name)
);

CREATE TABLE IF NOT EXISTS purchase_profiles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_model_id BIGINT NOT NULL REFERENCES device_models(id) ON DELETE RESTRICT,
  supplier VARCHAR(200),
  reference VARCHAR(200),
  purchased_on DATE,
  unit_cost NUMERIC(12,2) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  monthly_fee NUMERIC(12,2) CHECK (monthly_fee IS NULL OR monthly_fee >= 0),
  useful_life_months INTEGER CHECK (useful_life_months IS NULL OR useful_life_months > 0),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS purchase_profiles_model_date_idx ON purchase_profiles(device_model_id, purchased_on DESC);

CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username VARCHAR(120) NOT NULL UNIQUE,
  display_name VARCHAR(160) NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(30) NOT NULL CHECK (role IN ('admin', 'technician', 'sales', 'warehouse', 'finance')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS user_sessions_expiry_idx ON user_sessions(expires_at);

CREATE TABLE IF NOT EXISTS devices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_id BIGINT NOT NULL REFERENCES device_models(id) ON DELETE RESTRICT,
  branch_id BIGINT REFERENCES branches(id) ON DELETE RESTRICT,
  stock_location_id BIGINT REFERENCES stock_locations(id) ON DELETE RESTRICT,
  purchase_profile_id BIGINT REFERENCES purchase_profiles(id) ON DELETE SET NULL,
  asset_tag VARCHAR(100) UNIQUE,
  serial_number VARCHAR(200),
  status VARCHAR(30) NOT NULL DEFAULT 'in_stock' CHECK (status IN ('to_activate', 'operational', 'fault', 'decommissioned', 'in_stock')),
  ownership_type VARCHAR(20) NOT NULL DEFAULT 'sale' CHECK (ownership_type IN ('sale', 'rental')),
  purchase_cost NUMERIC(12,2) CHECK (purchase_cost IS NULL OR purchase_cost >= 0),
  monthly_fee NUMERIC(12,2) CHECK (monthly_fee IS NULL OR monthly_fee >= 0),
  purchased_on DATE,
  installed_on DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS devices_branch_id_idx ON devices(branch_id);
CREATE INDEX IF NOT EXISTS devices_model_id_idx ON devices(model_id);
CREATE INDEX IF NOT EXISTS devices_status_idx ON devices(status);

CREATE TABLE IF NOT EXISTS checklists (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed')),
  notes TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  checklist_id BIGINT NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
  label VARCHAR(300) NOT NULL,
  is_checked BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  checked_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  checked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS checklist_items_checklist_idx ON checklist_items(checklist_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id BIGINT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  from_location_id BIGINT REFERENCES stock_locations(id) ON DELETE RESTRICT,
  to_location_id BIGINT REFERENCES stock_locations(id) ON DELETE RESTRICT,
  branch_id BIGINT REFERENCES branches(id) ON DELETE RESTRICT,
  movement_type VARCHAR(40) NOT NULL,
  notes TEXT,
  moved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  moved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS stock_movements_device_date_idx ON stock_movements(device_id, moved_at DESC);

CREATE TABLE IF NOT EXISTS finance_entries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id BIGINT REFERENCES branches(id) ON DELETE RESTRICT,
  device_id BIGINT REFERENCES devices(id) ON DELETE RESTRICT,
  entry_type VARCHAR(40) NOT NULL CHECK (entry_type IN ('purchase', 'rental', 'service', 'other')),
  description VARCHAR(300) NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  occurred_on DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS finance_entries_branch_date_idx ON finance_entries(branch_id, occurred_on DESC);

CREATE TABLE IF NOT EXISTS clients (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_name VARCHAR(200) NOT NULL,
  contact_name VARCHAR(200),
  email VARCHAR(320),
  phone VARCHAR(50),
  vat_number VARCHAR(50),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
