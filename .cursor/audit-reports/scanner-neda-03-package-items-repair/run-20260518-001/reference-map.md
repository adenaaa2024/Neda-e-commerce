# Reference map — package_items → live schema

## Search results (app/runtime)

| Symbol / string | Location | Repair |
|-----------------|----------|--------|
| `package_items` table reads | `operator-store-actions.ts` | Replaced with `return_items` |
| `package_items` insert | `operator-store-actions.ts` | Replaced with `insertReturn` → `return_items` |
| Migration guard error | `operator-store-actions.ts` | **Removed** |
| `listOperatorPackageItemsForPackageAction` | scan `page.tsx` hydration | Unchanged export; backend reads `return_items` |
| `insertOperatorPackageItemAction` | scan `page.tsx` save modal | Unchanged export; backend inserts `return_items` |
| `OperatorPackageItemRow` | UI adapter type | Kept; fields mapped from `return_items` + slip match |
| `packageItemsHydrationNonce` | scan `page.tsx` state name | Kept (internal name only) |
| `types/database.types.ts` `package_items` | Type map only | **Not applied** — table absent on live DB |
| `supabase/migrations/20260515190000_package_items.sql` | Repo migration | **Not run** per constraint |

## Canonical persistence (live DB)

| Concern | Table | Notes |
|---------|-------|-------|
| Per-unit item scan | `return_items` | One row per scanned unit; `package_id` FK; trigger syncs `packages.actual_item_count` |
| Slip expected lines | `slip_contents` | `id`, `upc`, `fnsku`, `description`, `quantity` per package |
| Package totals | `packages` | `expected_item_count`, `actual_item_count` |
| EP receive path (separate) | `expected_packages` + `operatorReceiveItem` | Unchanged |

## Field mapping (`package_items` concept → `return_items`)

| Legacy `package_items` | `return_items` |
|------------------------|----------------|
| `scanned_barcode` | `fnsku` / `sku` (by match kind) |
| `slip_content_id` | Derived on read via `resolveItemBarcodeAgainstSlipRows` |
| `discrepancy_tags` | `conditions` |
| `expiry_date` | `expiration_date` |
| `lot_number` | `batch_number` |
| `evidence_urls` | `photo_evidence.urls` (gallery) |
| `match_kind` | Inferred from which identifier column is set |
| `quantity` | Always 1 per row (N units → N inserts) |

## Empty / no-rows behavior

- List returns `{ ok: true, rows: [] }` when package has no `return_items` — UI shows neutral “Awaiting” slip lines (no crash).
- List errors on real DB failures only (no `package_items` schema-cache guard).
- Hydration effect clears counts when list fails or package changes.
