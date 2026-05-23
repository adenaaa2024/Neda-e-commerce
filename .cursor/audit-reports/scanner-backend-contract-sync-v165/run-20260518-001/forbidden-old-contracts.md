# Forbidden / old contracts — do not use

Neda and backend agents must **not** reintroduce these patterns. Violations caused production incidents (package_items 42703, wrong table names).

---

## 1. `package_items` table

| | |
|---|---|
| **Status** | Absent on live DB (`PGRST205` / “Could not find the table”) |
| **Why forbidden** | Operator-mobile migrated to `return_items`; ORM types may still mention `package_items` in `types/database.types.ts` — **ignore for runtime** |
| **Use instead** | `insertOperatorPackageItemAction` → `return_items` |
| **Hydrate instead** | `listOperatorPackageItemsForPackageAction` (name is legacy; reads `return_items`) |

---

## 2. `returns` table name

| | |
|---|---|
| **Status** | Renamed to `return_items` |
| **Use** | `RETURN_ITEMS_TABLE` from `app/returns/returns-constants.ts` |
| **Never** | `.from("returns")` in new code |

---

## 3. `expected_item_id`

| | |
|---|---|
| **Status** | Legacy column name / concept |
| **Use** | `expected_package_id` on EP flows only |
| **Never SELECT on return_items** | Comment in `returns-constants.ts`: omit from scanner linkage reads |
| **operator item scan** | Does not set EP FK on insert |

---

## 4. `expected_packages.identifier_resolution_status`

| | |
|---|---|
| **Status** | Not part of operator scanner contract |
| **Linkage lives on** | `return_items` and `slip_contents`: `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence` |
| **Never** | Read or write EP resolution status for scanner UI badges |

---

## 5. Product auto-create from OCR / title

| | |
|---|---|
| **Forbidden** | `products.insert`, create-from-slip-title, Amazon catalog fetch |
| **Allowed** | `resolveProductForScannerItem` → existing rows only |
| **Allowed** | `manualOverrideReturnItemProductResolution` → pick existing `products.id` |
| **OCR routes** | `/api/scanner/extract-box-slip`, `/api/scanner/extract-slip` — out of scope for Neda v165 |

`resolveProductForScannerItem` explicitly sets `meta.ocr_ignored = true` when OCR/title passed.

---

## 6. Writing linkage on wrong entity

| Wrong | Right |
|-------|-------|
| EP row product columns (not on live DB) | `return_items` / `slip_contents` patch via `updateRowWithScannerLinkagePatch` |
| `package_items.resolved_product_id` | `return_items.resolved_product_id` |

---

## 7. `operatorReceiveItem` for BOX slip scan

| | |
|---|---|
| **Forbidden** | Calling EP receive when UI is on slip-line BOX item scan |
| **Effect** | Double counting `expected_packages.actual_scanned_count` |
| **Use** | `insertOperatorPackageItemAction` only for per-slip unit saves |

---

## 8. Migrations / env / external APIs (task constraints)

Do not, as part of Neda integration work:

- Run Supabase migrations
- Switch app to staging without ENV-06 approval
- Call Amazon SP-API
- Call OpenAI / vision API routes for product or slip identity

---

## 9. Deprecated SELECT fields (historical audits)

Do not add to server SELECTs:

- `expected_product_id` on return_items
- `identifier_resolution_meta` (removed)
- Legacy `returns` photo column names on packages

---

## Safe degradation checklist

When a forbidden column/table is missing:

1. Prefer server action fallback chains (`listOperatorSlipContentsForPackageAction`).
2. Omit badges; show barcode + slip text.
3. Never fall back to `package_items` or `returns` table.
4. Log PostgREST error once; show user-friendly toast.
