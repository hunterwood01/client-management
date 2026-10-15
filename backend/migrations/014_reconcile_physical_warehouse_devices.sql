-- Reconcile physical warehouse devices entered without a hardware order.
-- The aggregate stock must never be lower than the number of individually tracked,
-- unassigned devices that are still available in the warehouse.
WITH physical AS (
  SELECT model_id AS device_model_id, stock_location_id, COUNT(*)::int AS quantity
  FROM devices
  WHERE purchase_profile_id IS NULL
    AND stock_location_id IS NOT NULL
    AND branch_id IS NULL
    AND status IN ('in_stock', 'to_activate')
    AND COALESCE(stock_consumed, FALSE) = FALSE
  GROUP BY model_id, stock_location_id
)
INSERT INTO product_stock(device_model_id, stock_location_id, quantity)
SELECT device_model_id, stock_location_id, quantity
FROM physical
ON CONFLICT(device_model_id, stock_location_id)
DO UPDATE SET quantity = GREATEST(product_stock.quantity, EXCLUDED.quantity),
              updated_at = NOW()
WHERE product_stock.quantity < EXCLUDED.quantity;
