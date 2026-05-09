-- PIM / Amazon enrichment: allow product_prices rows without denormalized sku.
-- Canonical model (20260705120000_pim_model_stabilization) keys prices by product_id;
-- some legacy DBs added product_prices.sku as NOT NULL, which breaks inserts that only set org/store/product/amount/currency/observed_at/source/metadata.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'product_prices'
      AND column_name = 'sku'
  ) THEN
    ALTER TABLE public.product_prices
      ALTER COLUMN sku DROP NOT NULL;
    EXECUTE $c$
      COMMENT ON COLUMN public.product_prices.sku IS
        'Optional denormalized seller SKU at observation time; product_id is authoritative for PIM price history.'
    $c$;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
