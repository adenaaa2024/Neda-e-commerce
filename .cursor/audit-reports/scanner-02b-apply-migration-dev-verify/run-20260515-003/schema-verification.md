# Schema verification

## Status this run

**Not executed** — no migration apply and no live database query was run against a confirmed dev/staging instance.

## Expected columns vs migration (static diff)

Cross-checked `supabase/migrations/20260717120000_scanner_product_linkage_columns.sql` against the SCANNER-02B checklist.

### `expected_packages`

All requested columns are created by the migration with the **same names**:

`expected_product_id`, `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence`, `identifier_resolution_source`, `identifier_resolution_meta`, `product_match_status`, `product_review_required`, `product_resolved_at`, `product_resolved_by`.

### `return_items`

All requested columns are present **with the same names**, plus one **additional** column in the migration (not in the prompt checklist):

- **Extra (by design):** `resolved_catalog_product_id` — optional listing-bridge id; documented in migration comments.

### `slip_contents`

All requested columns are present **with the same names**, plus **extra:**

- **Extra:** `resolved_catalog_product_id`

### Naming differences

None relative to the migration file and the checklist column names above.

## SQL template (run after apply on confirmed DB)

```sql
-- expected_packages
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

-- return_items
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

-- slip_contents
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

Expect row counts: 11 for `expected_packages`; 13 for `return_items` (includes `resolved_catalog_product_id`); 15 for `slip_contents` (includes `resolved_catalog_product_id`).
