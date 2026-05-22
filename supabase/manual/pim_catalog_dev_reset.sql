-- =============================================================================
-- PIM catalog DEV reset — manual only (do NOT add as a migration; do NOT auto-run)
-- =============================================================================
-- Removes imported catalog data for one organization + store (re-test imports).
-- Edit UUIDs in the INSERT below, run BEGIN + script, read NOTICE lines, then
-- run COMMIT; or ROLLBACK; explicitly.
--
-- Order: optional ledger pointer clear, product_prices, product_identifier_map,
--   optional backlog/staging, catalog_products, products, optional PIM seed uploads.
-- No DROP TABLE. Vendors and categories are kept.
-- =============================================================================

BEGIN;

CREATE TEMP TABLE _pim_dev_reset_scope (
  organization_id uuid NOT NULL,
  store_id uuid NOT NULL
);

INSERT INTO _pim_dev_reset_scope (organization_id, store_id) VALUES
  ('00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid);

DO $$
DECLARE
  v_org uuid;
  v_sto uuid;
  n bigint;
BEGIN
  SELECT organization_id, store_id INTO STRICT v_org, v_sto FROM _pim_dev_reset_scope LIMIT 1;

  IF to_regclass('public.amazon_inventory_ledger') IS NOT NULL THEN
    UPDATE public.amazon_inventory_ledger ail
    SET resolved_product_id = NULL
    WHERE ail.resolved_product_id IS NOT NULL
      AND ail.organization_id = v_org
      AND EXISTS (
        SELECT 1 FROM public.products p
        WHERE p.id = ail.resolved_product_id
          AND p.organization_id = v_org
          AND p.store_id = v_sto
      );
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'amazon_inventory_ledger rows updated (resolved_product_id cleared): %', n;
  END IF;

  DELETE FROM public.product_prices WHERE organization_id = v_org AND store_id = v_sto;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'product_prices deleted: %', n;

  DELETE FROM public.product_identifier_map WHERE organization_id = v_org AND store_id = v_sto;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'product_identifier_map deleted: %', n;

  IF to_regclass('public.catalog_identity_unresolved_backlog') IS NOT NULL THEN
    DELETE FROM public.catalog_identity_unresolved_backlog WHERE organization_id = v_org AND store_id = v_sto;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'catalog_identity_unresolved_backlog deleted: %', n;
  END IF;

  IF to_regclass('public.product_identity_staging_rows') IS NOT NULL THEN
    DELETE FROM public.product_identity_staging_rows WHERE organization_id = v_org AND store_id = v_sto;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'product_identity_staging_rows deleted: %', n;
  END IF;

  DELETE FROM public.catalog_products WHERE organization_id = v_org AND store_id = v_sto;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'catalog_products deleted: %', n;

  DELETE FROM public.products WHERE organization_id = v_org AND store_id = v_sto;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'products deleted: %', n;

  IF to_regclass('public.raw_report_uploads') IS NOT NULL THEN
    DELETE FROM public.raw_report_uploads ru
    WHERE ru.organization_id = v_org
      AND ru.report_type = 'PIM_CATALOG_SEED'
      AND (
        (ru.metadata ->> 'store_id') = v_sto::text
        OR (ru.metadata #>> '{pim,store_id}') = v_sto::text
      );
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE 'raw_report_uploads PIM_CATALOG_SEED deleted (metadata store match): %', n;
  END IF;
END $$;

-- COMMIT;
-- ROLLBACK;
