-- RA-derived marketplace token that disagrees with `pallets.order_id` (BOX slip conflict).
ALTER TABLE public.slip_contents
  ADD COLUMN IF NOT EXISTS conflicting_order_id text DEFAULT NULL;

COMMENT ON COLUMN public.slip_contents.conflicting_order_id IS
  'When slip RMA embeds an order id that differs from the parent pallet''s `order_id`, that extracted token is stored here (same value on each line row for the replace snapshot).';
