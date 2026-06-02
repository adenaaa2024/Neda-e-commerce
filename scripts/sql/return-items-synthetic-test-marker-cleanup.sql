-- READ-ONLY AUDIT / MANUAL CLEANUP — do not run from application code.
-- Staging-only operator approval required before any DELETE/UPDATE.
--
-- Targets: active return_items with null raw_return_data and script/smoke/parity markers.
-- Review counts first; prefer soft-delete to match bulk-orphan remediation style.

-- 1) Census
SELECT COUNT(*)::int AS synthetic_test_marker_active
FROM public.return_items ri
WHERE ri.deleted_at IS NULL
  AND ri.raw_return_data IS NULL
  AND public.return_items_row_has_test_marker(
    ri.item_name, ri.sku, ri.fnsku, ri.notes, ri.product_identifier
  );

-- 2) Sample (first 50)
SELECT ri.id, ri.organization_id, ri.store_id, ri.item_name, ri.sku, ri.notes, ri.created_at
FROM public.return_items ri
WHERE ri.deleted_at IS NULL
  AND ri.raw_return_data IS NULL
  AND public.return_items_row_has_test_marker(
    ri.item_name, ri.sku, ri.fnsku, ri.notes, ri.product_identifier
  )
ORDER BY ri.created_at DESC
LIMIT 50;

-- 3) Soft-delete (run only after explicit staging approval)
-- UPDATE public.return_items ri
-- SET deleted_at = now(), updated_at = now()
-- WHERE ri.deleted_at IS NULL
--   AND ri.raw_return_data IS NULL
--   AND public.return_items_row_has_test_marker(
--     ri.item_name, ri.sku, ri.fnsku, ri.notes, ri.product_identifier
--   );

-- 4) Bulk-orphan EP rows (separate lane — existing predicate)
-- SELECT COUNT(*) FROM public.return_items ri
-- WHERE ri.deleted_at IS NULL
--   AND ri.expected_item_id IS NOT NULL
--   AND ri.package_id IS NULL
--   AND ri.pallet_id IS NULL;
