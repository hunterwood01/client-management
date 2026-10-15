CREATE TABLE IF NOT EXISTS branch_previous_company_names (
  id BIGSERIAL PRIMARY KEY,
  branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  company_name VARCHAR(200) NOT NULL CHECK (length(trim(company_name)) > 0),
  created_by VARCHAR(160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_branch_previous_company_names_branch_created
  ON branch_previous_company_names (branch_id, created_at DESC, id DESC);

ALTER TABLE branch_previous_company_names
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_branch_previous_company_names_company
  ON branch_previous_company_names (company_id);
