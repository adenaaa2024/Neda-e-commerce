-- Canonical slip-derived marketplace/removal order token from RMA/OCR (per slip snapshot row).
ALTER TABLE public.slip_contents
  ADD COLUMN IF NOT EXISTS order_id text DEFAULT NULL;

COMMENT ON COLUMN public.slip_contents.order_id IS
  'Order id token derived from slip RMA/reference (same on each line row for a replace snapshot). Source of truth for this slip vs pallet identity in `pallets.order_id`.';
