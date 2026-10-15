CREATE TABLE IF NOT EXISTS device_fault_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  device_id BIGINT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  branch_id BIGINT REFERENCES branches(id) ON DELETE RESTRICT,
  fault_date DATE NOT NULL DEFAULT CURRENT_DATE,
  description TEXT NOT NULL,
  outcome VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','rma','sci','resolved')),
  rma_number VARCHAR(120),
  rma_status VARCHAR(40),
  replacement_device_id BIGINT REFERENCES devices(id) ON DELETE RESTRICT,
  replacement_stock_location_id BIGINT REFERENCES stock_locations(id) ON DELETE RESTRICT,
  additional_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (additional_cost >= 0),
  cost_description VARCHAR(300),
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  notes TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS device_fault_events_device_date_idx ON device_fault_events(device_id, fault_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS device_fault_events_branch_status_idx ON device_fault_events(branch_id, status, fault_date DESC);
CREATE INDEX IF NOT EXISTS device_fault_events_outcome_idx ON device_fault_events(outcome);
