ALTER TABLE branch_previous_company_names
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_branch_previous_company_names_company
  ON branch_previous_company_names (company_id);
