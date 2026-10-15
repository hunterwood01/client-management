-- Allow deleting an unused hardware order while preserving stock movement history.
-- Historical movements are retained and simply lose the deleted order reference.
ALTER TABLE product_stock_movements
  DROP CONSTRAINT IF EXISTS product_stock_movements_purchase_profile_id_fkey;

ALTER TABLE product_stock_movements
  ADD CONSTRAINT product_stock_movements_purchase_profile_id_fkey
  FOREIGN KEY (purchase_profile_id)
  REFERENCES purchase_profiles(id)
  ON DELETE SET NULL;
