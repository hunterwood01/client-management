ALTER TABLE device_fault_events
  ADD COLUMN IF NOT EXISTS replacement_hardware_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (replacement_hardware_cost >= 0);
