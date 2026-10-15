CREATE TABLE IF NOT EXISTS branch_company_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  from_company_id BIGINT,
  from_company_name VARCHAR(200) NOT NULL,
  to_company_id BIGINT,
  to_company_name VARCHAR(200) NOT NULL,
  changed_by VARCHAR(200) NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_branch_company_history_branch_changed
  ON branch_company_history(branch_id, changed_at DESC);
