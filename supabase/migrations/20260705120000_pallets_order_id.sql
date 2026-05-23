-- Receiving pallets: canonical marketplace / removal order id (preferred for new operator writes over legacy amazon_order_id).
ALTER TABLE public.pallets
  ADD COLUMN IF NOT EXISTS order_id text DEFAULT NULL;

COMMENT ON COLUMN public.pallets.order_id IS
  'Marketplace or removal order id for this receiving pallet; use for shipment-first intake alongside tracking_number.';

CREATE INDEX IF NOT EXISTS idx_pallets_org_order_id
  ON public.pallets (organization_id, order_id)
  WHERE deleted_at IS NULL AND order_id IS NOT NULL;
