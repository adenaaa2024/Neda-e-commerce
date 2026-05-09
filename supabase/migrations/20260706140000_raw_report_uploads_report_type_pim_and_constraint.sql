-- Restore PIM Product Master / catalog seed report types on raw_report_uploads.report_type.
--
-- Symptom: migration 20260637 rebuilt raw_report_uploads_report_type_check from a snapshot that
-- did not include PIM_CATALOG_SEED (added in 20260504120000). Inserts/updates with PIM report types
-- then failed with check_violation (23514).
--
-- This migration:
--   - Drops and recreates the CHECK with the full 20260637 Amazon/canonical set unchanged
--   - Adds legacy PIM_CATALOG_SEED plus lowercase pim_* discriminators for future import areas
--   - Documents PIM usage in the constraint comment
--
-- No new tables; no data deletion.

BEGIN;

ALTER TABLE public.raw_report_uploads
  DROP CONSTRAINT IF EXISTS raw_report_uploads_report_type_check;

ALTER TABLE public.raw_report_uploads
  ADD CONSTRAINT raw_report_uploads_report_type_check CHECK (
    report_type = ANY (ARRAY[
      -- Canonical smart-import types written by header classification.
      'FBA_RETURNS'::text,
      'REMOVAL_ORDER'::text,
      'REMOVAL_SHIPMENT'::text,
      'INVENTORY_LEDGER'::text,
      'REIMBURSEMENTS'::text,
      'SETTLEMENT'::text,
      'SAFET_CLAIMS'::text,
      'TRANSACTIONS'::text,
      'REPORTS_REPOSITORY'::text,
      'PRODUCT_IDENTITY'::text,
      -- Additional canonical types known to the application.
      'ALL_ORDERS'::text,
      'REPLACEMENTS'::text,
      'FBA_GRADE_AND_RESELL'::text,
      'MANAGE_FBA_INVENTORY'::text,
      'FBA_INVENTORY'::text,
      'INBOUND_PERFORMANCE'::text,
      'AMAZON_FULFILLED_INVENTORY'::text,
      'RESERVED_INVENTORY'::text,
      'FEE_PREVIEW'::text,
      'MONTHLY_STORAGE_FEES'::text,
      'UNKNOWN'::text,
      'CATEGORY_LISTINGS'::text,
      'ALL_LISTINGS'::text,
      'ACTIVE_LISTINGS'::text,
      -- Legacy slugs kept for backward compatibility with old rows.
      'fba_customer_returns'::text,
      'reimbursements'::text,
      'inventory_ledger'::text,
      'safe_t_claims'::text,
      'transaction_view'::text,
      'settlement_repository'::text,
      -- PIM (Product Information Management) — not Amazon marketplace raw reports.
      -- Prefer lowercase discriminators; keep PIM_CATALOG_SEED for older rows / TS union.
      'PIM_CATALOG_SEED'::text,
      'pim_catalog_seed'::text,
      'pim_product_master'::text,
      'pim_price_history'::text,
      'pim_identifier_map'::text,
      'pim_vendor_reference'::text,
      'pim_category_reference'::text
    ])
  );

COMMENT ON CONSTRAINT raw_report_uploads_report_type_check ON public.raw_report_uploads IS
  'Allowed values for report_type. Includes Amazon/listing canonical types (see 20260637), '
  'legacy lowercase slugs, and PIM types (pim_product_master, …). '
  'PIM jobs should also set metadata.module = ''pim'' and metadata.import_area for UI filtering. '
  'When adding a type, extend this CHECK and lib/raw-report-types.ts together.';

NOTIFY pgrst, 'reload schema';

COMMIT;
