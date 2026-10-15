-- Legal-entity hierarchy: a company can have one parent company and multiple child companies.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS parent_company_id BIGINT
  REFERENCES companies(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_companies_parent_company_id
  ON companies(parent_company_id);
