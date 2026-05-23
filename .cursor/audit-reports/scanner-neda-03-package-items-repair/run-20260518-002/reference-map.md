# Reference map — package_items → live schema

## Search: `package_items` / `packageItems` / `package_item` (app `*.ts` / `*.tsx`)

| Hit | Location | Disposition |
|-----|----------|-------------|
| `packageItemsHydrationNonce` | `scan/page.tsx` | Internal state name only — no DB |
| `package_items` type block | `types/database.types.ts` | Unused by runtime; table absent on live DB |
| `package_items` probe | `scripts/scanner-neda-04-operator-mobile-smoke.ts` | Intentional absence check — not app code |
| `from("package_items")` | **None** in `app/` or `lib/` | **Removed** |

## Search: `.from("returns")` / `.from('returns')` in `*.ts` / `*.tsx`

**No matches** — canonical table is `return_items` via `RETURN_ITEMS_TABLE`.

## Stale → current mapping

| Legacy `package_items` concept | Live persistence |
|-------------------------------|------------------|
| List scanned units | `return_items` filtered by `package_id` + org |
| Insert unit scan | `insertReturn` → `return_items` (qty>1 → N rows) |
| `slip_content_id` FK | Derived on read via `resolveItemBarcodeAgainstSlipRows` |
| `scanned_barcode` | `fnsku` / `sku` / `product_identifier` |
| `discrepancy_tags` | `conditions` |
| `expiry_date` / `lot_number` | `expiration_date` / `batch_number` |
| `evidence_urls` | `photo_evidence` gallery |
| Slip expected lines | `slip_contents` (unchanged) |
| Package totals | `packages.actual_item_count` (DB trigger on `return_items`) |
| EP receive path | `expected_packages` + `operatorReceiveItem` (unchanged) |

## Guard removed

Previous `listOperatorPackageItemsForPackageAction` / `insertOperatorPackageItemAction` returned:

`package_items table not available — apply database migrations.`

on PGRST205/schema-cache errors. **Removed** — real errors surface; empty list is `{ ok: true, rows: [] }`.

## Empty-state (no crash)

- Hydration failure or zero rows → `packageItemScanState` cleared; slip lines show **Awaiting**.
- No migration toast; no thrown error on missing `package_items` table.
