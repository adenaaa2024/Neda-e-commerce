-- PIM catalog seed (/etl/seed-products) audit rows: raw_report_uploads.report_type = PIM_CATALOG_SEED

BEGIN;

ALTER TABLE public.raw_report_uploads
  DROP CONSTRAINT IF EXISTS raw_report_uploads_report_type_check;

ALTER TABLE public.raw_report_uploads
  ADD CONSTRAINT raw_report_uploads_report_type_check CHECK (
    report_type = ANY (ARRAY[
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
      'fba_customer_returns'::text,
      'reimbursements'::text,
      'inventory_ledger'::text,
      'safe_t_claims'::text,
      'transaction_view'::text,
      'settlement_repository'::text,
      'PIM_CATALOG_SEED'::text
    ])
  );

COMMENT ON CONSTRAINT raw_report_uploads_report_type_check ON public.raw_report_uploads IS
  'Allowed report_type values. PIM_CATALOG_SEED: ETL quick catalog file import; metadata stores preview/apply metrics.';

NOTIFY pgrst, 'reload schema';

COMMIT;
