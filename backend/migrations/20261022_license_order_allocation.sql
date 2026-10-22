ALTER TABLE license_purchase_orders
  ADD COLUMN IF NOT EXISTS allocation_mode VARCHAR(32) NOT NULL DEFAULT 'none';

-- Keep the existing behavior for orders already recorded: their investment
-- was already allocated across active branches in Finance.
UPDATE license_purchase_orders
SET allocation_mode = 'active_branches'
WHERE allocation_mode = 'none'
  AND created_at < NOW();
