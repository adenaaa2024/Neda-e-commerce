-- SCANNER-QUANTITY-BATCH-BACKEND-PREP (Phase 1 — additive, backward compatible)
-- Canonical scanned unit table: public.return_items (1 row = 1 scan batch; scanned_quantity = unit count).
-- Apply on staging first; existing rows default scanned_quantity = 1 (same behavior as today).

BEGIN;

-- ── 1) Quantity column on return_items ───────────────────────────────────────
ALTER TABLE public.return_items
  ADD COLUMN IF NOT EXISTS scanned_quantity integer;

UPDATE public.return_items
SET scanned_quantity = 1
WHERE scanned_quantity IS NULL OR scanned_quantity < 1;

ALTER TABLE public.return_items
  ALTER COLUMN scanned_quantity SET DEFAULT 1;

ALTER TABLE public.return_items
  ALTER COLUMN scanned_quantity SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'return_items_scanned_quantity_positive_chk'
  ) THEN
    ALTER TABLE public.return_items
      ADD CONSTRAINT return_items_scanned_quantity_positive_chk
      CHECK (scanned_quantity >= 1);
  END IF;
END $$;

COMMENT ON COLUMN public.return_items.scanned_quantity IS
  'Physical units represented by this scan batch row. Default 1 preserves legacy one-row-per-unit behavior. Problem/damaged rows should remain separate rows with their own quantity and evidence.';

-- expiration_date / batch_number already exist on return_items (20260413). No rename to lot_number in this migration.

-- ── 2) Indexes for batch scans + progress views ───────────────────────────────
CREATE INDEX IF NOT EXISTS idx_return_items_package_id_active
  ON public.return_items (package_id)
  WHERE deleted_at IS NULL AND package_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_return_items_pallet_id_active
  ON public.return_items (pallet_id)
  WHERE deleted_at IS NULL AND pallet_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_return_items_resolved_product_id_active
  ON public.return_items (resolved_product_id)
  WHERE deleted_at IS NULL AND resolved_product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_return_items_expected_item_id_active
  ON public.return_items (expected_item_id)
  WHERE deleted_at IS NULL AND expected_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_return_items_expiration_date_active
  ON public.return_items (expiration_date)
  WHERE deleted_at IS NULL AND expiration_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_return_items_package_product_exp
  ON public.return_items (package_id, resolved_product_id, expiration_date)
  WHERE deleted_at IS NULL AND package_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_return_items_org_store_created_active
  ON public.return_items (organization_id, store_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- ── 3) Inventory views — SUM(scanned_quantity) not COUNT(*) ───────────────────
DROP VIEW IF EXISTS public.v_inventory_status CASCADE;
DROP VIEW IF EXISTS public.v_inventory_item_status CASCADE;
DROP VIEW IF EXISTS public.v_scanned_items_counted CASCADE;

CREATE VIEW public.v_scanned_items_counted AS
WITH scanned_grouped AS (
  SELECT r.organization_id,
    r.store_id,
    tn.operational AS tracking_number,
    p.id_slip_contents AS slip_code,
    max(p.package_code) AS package_code,
    r.sku,
    r.fnsku,
    r.asin,
    NULLIF(btrim(max(r.product_identifier)), ''::text) AS upc,
    car.operational AS carrier,
    max(COALESCE(p.created_at, r.created_at)) AS package_date,
    max(pl.order_id) AS order_id,
    sum(COALESCE(r.scanned_quantity, 1))::bigint AS total_scanned,
    count(*)::bigint AS scan_batch_count,
    CASE
      WHEN count(DISTINCT r.resolved_product_id) FILTER (WHERE r.resolved_product_id IS NOT NULL) > 1 THEN NULL::uuid
      ELSE max(r.resolved_product_id::text)::uuid
    END AS resolved_product_id,
    CASE
      WHEN count(DISTINCT r.resolved_catalog_product_id) FILTER (WHERE r.resolved_catalog_product_id IS NOT NULL) > 1 THEN NULL::uuid
      ELSE max(r.resolved_catalog_product_id::text)::uuid
    END AS resolved_catalog_product_id,
    CASE
      WHEN count(DISTINCT r.resolved_product_id) FILTER (WHERE r.resolved_product_id IS NOT NULL) > 1 THEN 'ambiguous'::text
      ELSE max(r.identifier_resolution_status)
    END AS identifier_resolution_status,
    max(r.identifier_resolution_confidence) AS identifier_resolution_confidence
  FROM public.return_items r
  INNER JOIN public.packages p ON r.package_id = p.id
  LEFT JOIN public.pallets pl ON COALESCE(r.pallet_id, p.pallet_id) = pl.id
  LEFT JOIN LATERAL normalize_removal_tracking_operational(COALESCE(p.tracking_number, pl.tracking_number)) tn(operational, status, token_count) ON true
  LEFT JOIN LATERAL normalize_removal_carrier_operational(p.carrier_name) car(operational, status, token_count) ON true
  WHERE r.deleted_at IS NULL AND r.package_id IS NOT NULL
  GROUP BY r.organization_id, r.store_id, tn.operational, p.id_slip_contents, r.sku, r.fnsku, r.asin, car.operational
), with_package_count AS (
  SELECT sg.*,
    CASE
      WHEN NULLIF(btrim(COALESCE(sg.slip_code, ''::text)), ''::text) IS NULL THEN 0::bigint
      ELSE count(*) OVER (PARTITION BY sg.organization_id, sg.store_id, sg.tracking_number, sg.slip_code)
    END AS package_count
  FROM scanned_grouped sg
)
SELECT organization_id,
  store_id,
  tracking_number,
  slip_code,
  slip_code AS id_slip_contents,
  package_code,
  sku,
  fnsku,
  asin,
  upc,
  carrier,
  package_date,
  order_id,
  total_scanned,
  scan_batch_count,
  package_count,
  resolved_product_id,
  resolved_product_id AS product_id,
  resolved_catalog_product_id,
  identifier_resolution_status,
  identifier_resolution_status AS product_linkage_status,
  identifier_resolution_confidence,
  NULL::text AS product_name
FROM with_package_count;

COMMENT ON VIEW public.v_scanned_items_counted IS
  'Scanned units = SUM(return_items.scanned_quantity). scan_batch_count = COUNT(rows) for operator batch visibility.';

-- Recreate v_inventory_item_status + v_inventory_status from latest parity definition (20260904120000)
-- with total_scanned sourced from v_scanned_items_counted (already quantity-aware).

CREATE VIEW public.v_inventory_item_status AS
WITH expected_totals AS (
  SELECT ep.organization_id,
    ep.store_id,
    tn.operational AS tracking_number,
    ep.id_slip_contents AS slip_code,
    NULL::text AS package_code,
    ep.sku,
    ep.fnsku,
    NULL::text AS asin,
    NULL::text AS upc,
    car.operational AS carrier,
    max(COALESCE(ep.shipment_date::timestamp with time zone, ep.created_at)) AS package_date,
    max(ep.order_id) AS order_id,
    sum(ep.expected_scan_quantity)::numeric AS total_expected,
    0::numeric AS total_scanned,
    CASE
      WHEN count(DISTINCT ep.resolved_product_id) FILTER (WHERE ep.resolved_product_id IS NOT NULL) > 1 THEN NULL::uuid
      ELSE max(ep.resolved_product_id::text)::uuid
    END AS resolved_product_id,
    CASE
      WHEN count(DISTINCT ep.resolved_catalog_product_id) FILTER (WHERE ep.resolved_catalog_product_id IS NOT NULL) > 1 THEN NULL::uuid
      ELSE max(ep.resolved_catalog_product_id::text)::uuid
    END AS resolved_catalog_product_id,
    CASE
      WHEN count(DISTINCT ep.resolved_product_id) FILTER (WHERE ep.resolved_product_id IS NOT NULL) > 1 THEN 'ambiguous'::text
      ELSE max(ep.identifier_resolution_status)
    END AS identifier_resolution_status,
    max(ep.identifier_resolution_confidence) AS identifier_resolution_confidence,
    CASE
      WHEN count(DISTINCT ep.id) > 1 THEN NULL::uuid
      ELSE max(ep.id::text)::uuid
    END AS expected_package_id
  FROM public.expected_packages ep
  LEFT JOIN LATERAL normalize_removal_tracking_operational(ep.tracking_number) tn(operational, status, token_count) ON true
  LEFT JOIN LATERAL normalize_removal_carrier_operational(ep.carrier) car(operational, status, token_count) ON true
  GROUP BY ep.organization_id, ep.store_id, tn.operational, ep.id_slip_contents, ep.sku, ep.fnsku, car.operational
), scanned_totals AS (
  SELECT s.organization_id,
    s.store_id,
    s.tracking_number,
    s.slip_code,
    s.package_code,
    s.sku,
    s.fnsku,
    s.asin,
    s.upc,
    s.carrier,
    s.package_date,
    s.order_id,
    0::numeric AS total_expected,
    s.total_scanned::numeric AS total_scanned,
    s.resolved_product_id,
    s.resolved_catalog_product_id,
    s.identifier_resolution_status,
    s.identifier_resolution_confidence,
    NULL::uuid AS expected_package_id
  FROM public.v_scanned_items_counted s
), combined_totals AS (
  SELECT * FROM expected_totals
  UNION ALL
  SELECT * FROM scanned_totals
), rolled AS (
  SELECT organization_id,
    store_id,
    tracking_number,
    slip_code,
    max(package_code) AS package_code,
    sku,
    fnsku,
    max(asin) AS asin,
    max(upc) AS upc,
    max(carrier) AS carrier,
    max(package_date) AS package_date,
    max(order_id) AS order_id,
    sum(total_expected) AS total_expected,
    sum(total_scanned) AS total_scanned,
    max(resolved_product_id::text)::uuid AS resolved_product_id,
    max(resolved_catalog_product_id::text)::uuid AS resolved_catalog_product_id,
    max(identifier_resolution_status) AS identifier_resolution_status,
    max(identifier_resolution_confidence) AS identifier_resolution_confidence,
    max(expected_package_id::text)::uuid AS expected_package_id
  FROM combined_totals
  GROUP BY organization_id, store_id, tracking_number, slip_code, sku, fnsku
)
SELECT *,
  GREATEST(total_expected - total_scanned, 0::numeric) AS remaining_to_scan
FROM rolled;

COMMENT ON VIEW public.v_inventory_item_status IS
  'Item-level expected vs scanned; scanned leg uses SUM(scanned_quantity) via v_scanned_items_counted.';

CREATE VIEW public.v_inventory_status AS
SELECT organization_id,
  store_id,
  tracking_number,
  slip_code,
  max(package_code) AS package_code,
  max(carrier) AS carrier,
  max(package_date) AS package_date,
  max(order_id) AS order_id,
  sum(total_expected) AS total_expected,
  sum(total_scanned) AS total_scanned,
  GREATEST(sum(total_expected) - sum(total_scanned), 0::numeric) AS remaining_to_scan,
  count(*) FILTER (WHERE total_scanned > 0) AS lines_with_scans,
  count(*) AS line_count
FROM public.v_inventory_item_status
GROUP BY organization_id, store_id, tracking_number, slip_code;

COMMENT ON VIEW public.v_inventory_status IS
  'Package/slip rollup; scanned totals are quantity-weighted.';

COMMIT;
