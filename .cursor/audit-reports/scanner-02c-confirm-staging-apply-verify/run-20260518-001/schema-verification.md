# Schema verification (SCANNER-02C)

## Live verification status

**Not executed** — environment gate failed; no migration apply and no live `information_schema` query against the linked hosted project.

## Static verification (migration file vs checklist)

Cross-checked `supabase/migrations/20260717120000_scanner_product_linkage_columns.sql` against the SCANNER-02C column lists.

### `expected_packages` (11 columns)

All present with matching names: `expected_product_id`, `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence`, `identifier_resolution_source`, `identifier_resolution_meta`, `product_match_status`, `product_review_required`, `product_resolved_at`, `product_resolved_by`.

### `return_items` (13 checklist + 1 extra)

All checklist columns present. **Extra in migration:** `resolved_catalog_product_id` (listing bridge; documented in migration).

### `slip_contents` (14 checklist + 1 extra)

All checklist columns present. **Extra in migration:** `resolved_catalog_product_id`.

## SQL template (run after apply on confirmed dev/staging DB)

```sql
-- expected_packages — expect 11 rows
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'expected_packages'
  AND column_name IN (
    'expected_product_id','resolved_product_id','resolved_catalog_product_id',
    'identifier_resolution_status','identifier_resolution_confidence',
    'identifier_resolution_source','identifier_resolution_meta',
    'product_match_status','product_review_required','product_resolved_at','product_resolved_by'
  )
ORDER BY column_name;

-- return_items — expect 13 rows
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'return_items'
  AND column_name IN (
    'expected_item_id','expected_product_id','scanned_product_id','resolved_product_id','resolved_catalog_product_id',
    'identifier_resolution_status','identifier_resolution_confidence',
    'identifier_resolution_source','identifier_resolution_meta',
    'product_match_status','product_review_required','product_resolved_at','product_resolved_by'
  )
ORDER BY column_name;

-- slip_contents — expect 15 rows (includes resolved_catalog_product_id)
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'slip_contents'
  AND column_name IN (
    'ocr_text','ocr_product_name','ocr_confidence',
    'parsed_asin','parsed_fnsku','parsed_sku','parsed_upc',
    'resolved_product_id','resolved_catalog_product_id',
    'identifier_resolution_status','identifier_resolution_confidence',
    'identifier_resolution_source','identifier_resolution_meta',
    'product_review_required'
  )
ORDER BY column_name;
```

## Result summary

| Check | Result |
|-------|--------|
| Migration defines required columns | **Pass** (static) |
| Live DB columns exist | **Skipped (blocked)** |
