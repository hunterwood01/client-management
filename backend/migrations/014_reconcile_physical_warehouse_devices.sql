-- Reconcile physical warehouse devices that were entered without a hardware order.
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
),
changes AS (
  INSERT INTO product_stock(device_model_id, stock_location_id, quantity)
  SELECT device_model_id, stock_location_id, quantity
  FROM physical
  ON CONFLICT(device_model_id, stock_location_id)
  DO UPDATE SET quantity = GREATEST(product_stock.quantity, EXCLUDED.quantity),
                updated_at = NOW()
  WHERE product_stock.quantity < EXCLUDED.quantity
  RETURNING device_model_id, stock_location_id, quantity
)
INSERT INTO product_stock_movements(device_model_id, stock_location_id, quantity_delta, movement_type, notes)
SELECT c.device_model_id, c.stock_location_id, c.quantity - COALESCE(old.quantity, 0), 'adjustment',
       'Riconciliazione iniziale device fisici senza ordine hardware'
FROM changes c
LEFT JOIN (
  SELECT device_model_id, stock_location_id, quantity
  FROM product_stock
) old USING (device_model_id, stock_location_id)
WHERE c.quantity > COALESCE(old.quantity, 0);
