-- Add an auditable stock movement for manually censused physical devices
-- that predate stock movement tracking. Safe to run once after migration 014;
-- the device-specific note makes this operation idempotent if manually re-run.
INSERT INTO product_stock_movements(
  device_model_id, stock_location_id, quantity_delta, movement_type, device_id, notes
)
SELECT d.model_id, d.stock_location_id, 1, 'adjustment', d.id,
       'Riconciliazione device fisico #' || d.id || ' senza ordine hardware'
FROM devices d
WHERE d.purchase_profile_id IS NULL
  AND d.stock_location_id IS NOT NULL
  AND d.branch_id IS NULL
  AND d.status IN ('in_stock', 'to_activate')
  AND COALESCE(d.stock_consumed, FALSE) = FALSE
  AND NOT EXISTS (
    SELECT 1
    FROM product_stock_movements m
    WHERE m.device_id = d.id
      AND m.movement_type = 'adjustment'
      AND m.quantity_delta = 1
      AND m.notes = 'Carico device censito manualmente #' || d.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM product_stock_movements m
    WHERE m.device_id = d.id
      AND m.movement_type = 'adjustment'
      AND m.quantity_delta = 1
      AND m.notes = 'Riconciliazione device fisico #' || d.id || ' senza ordine hardware'
  );
