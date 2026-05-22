# Database contract — Neda operator-mobile (read/write map)

**Staging ref:** `eiqfaapyumhixxoeltgu`  
**Original/current dev ref:** `kxsvedvpjldygtdbylsy` (not Neda active target)  
**Future production:** not created  
**Sync:** V195-NEDA-HANDOFF-FILE-SYNC-AND-USAGE

---

## Approved write path (BOX item scan)

| Action | Table | Notes |
|--------|-------|-------|
| `insertOperatorPackageItemAction` | `return_items` | Per-slip unit save; legacy action name |
| Slip vision / box intake | `packages`, `slip_contents`, pallets | Via `operator-store-actions.ts` server only |

**Never:** `package_items`, client-side `supabase` writes on `scan/page.tsx`

---

## Approved read paths

| Entity | Access | Module |
|--------|--------|--------|
| `expected_packages` | PostgREST select + fallback selects | `operator-tracking-expectations.ts` |
| `v_inventory_item_status` | View select | `v-inventory-status.ts` |
| `return_items` | `RETURN_ITEMS_TABLE`, scanner linkage select | `returns-constants.ts`, store actions |
| `slip_contents` | `listOperatorSlipContentsForPackageAction` | store actions |
| `products` | Name lookup by id only (`fetchProductNamesByResolvedIds`) | `product-linkage-display-contract.ts` |

---

## Table rename rules

| Forbidden | Use |
|-----------|-----|
| `returns` | `return_items` (`RETURN_ITEMS_TABLE`) |
| `package_items` | `return_items` via approved actions |

---

## `expected_packages` (live staging)

- Identifier/tracking model: `sku`, `fnsku`, `tracking_number`, `expected_scan_quantity`, `actual_scanned_count`
- **No** `identifier_resolution_status` on live DB — do not SELECT for scanner badges
- Extended product joins: gated on migration `20260717120000`; 42703 → base `EP_SELECT` fallback

---

## Product linkage columns (when migration applied)

| Table | Columns |
|-------|---------|
| `return_items` | `resolved_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence` |
| `slip_contents` | same pattern |

EP rows: **no** product FK on current staging (intentional).

---

## Forbidden SELECT patterns (scanner `app/scanner`)

Counts must stay **0** in stale scans:

- `package_items`
- `.from("returns")`
- `packages.package_number` in select chains
- `pallets.photo_url` scalar select

---

## Reference audits

- Forbidden list: `.cursor/audit-reports/scanner-backend-contract-sync-v165/run-20260518-001/forbidden-old-contracts.md`
- EP policy: `.cursor/audit-reports/product-id-linkage-closure-v167/run-20260518-001/expected-packages-policy.md`
