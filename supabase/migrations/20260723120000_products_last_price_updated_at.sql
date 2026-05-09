-- PIM: bump when enrichment appends product_prices (UI + freshness).

BEGIN;

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS last_price_updated_at timestamptz;

COMMENT ON COLUMN public.products.last_price_updated_at IS
  'Last time a price row was appended for this product (e.g. Amazon enrichment → product_prices).';

COMMIT;
