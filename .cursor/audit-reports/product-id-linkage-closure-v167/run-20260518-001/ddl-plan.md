# DDL plan — do not apply without separate operator approval

**Status:** Plan only. No migration was executed in this audit.

## Primary migration (already in repo)

Apply as a single approved changeset:

`supabase/migrations/20260717120000_scanner_product_linkage_columns.sql`

Adds (additive `IF NOT EXISTS`):

| Table | New columns (count) |
|-------|---------------------|
| `expected_packages` | 11 — `expected_product_id`, `resolved_product_id`, `resolved_catalog_product_id`, resolution metadata, match/review flags, audit timestamps |
| `return_items` | 9 additional — `expected_item_id`, `expected_product_id`, `scanned_product_id`, `identifier_resolution_source`, `identifier_resolution_meta`, `product_match_status`, `product_review_required`, `product_resolved_at`, `product_resolved_by` |
| `slip_contents` | 11 additional — OCR/parsed tokens, resolution source/meta, `product_review_required` |

Includes FK constraints (when `products` / `catalog_products` exist), indexes, `NOTIFY pgrst, 'reload schema'`.

### Post-apply verification SQL

```sql
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('expected_packages', 'return_items', 'slip_contents')
  AND column_name IN (
    'resolved_product_id', 'identifier_resolution_status',
    'identifier_resolution_source', 'expected_product_id', 'parsed_asin'
  )
ORDER BY 1, 2;
```

Re-run: `npx tsx scripts/product-id-linkage-closure-v167-probe.ts`

## Secondary migrations (optional, separate approval)

| Migration | Purpose | Staging probe |
|-----------|---------|---------------|
| `20260630_v_product_identity.sql` | `v_product_identity` read model | View missing (`PGRST205`) |
| `20260641130000_slip_contents_notes.sql` | `slip_contents.notes` | Not verified in v167 probe |

## Partial state note

`return_items` and `slip_contents` already have the **core quartet** on staging. Full migration is still safe (`ADD COLUMN IF NOT EXISTS`) and required for `identifier_resolution_source`, EP product FKs, and slip parsed columns.

## Explicitly out of scope (per audit constraints)

- Auto-creating `products` rows from scanner
- Creating `package_items`
- Production apply
- Amazon / OpenAI integration DDL
