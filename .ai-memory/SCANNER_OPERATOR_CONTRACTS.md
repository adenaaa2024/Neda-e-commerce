# Scanner & operator contracts

**Authoritative Neda backend:** `NEDA_FINAL_BACKEND_HANDOFF_V193.md`  
**Contract guard:** `npm run check:product-resolution-contract-v192`

## Inventory views

| View | Role | Product linkage |
|------|------|-----------------|
| **`v_inventory_item_status`** | Item-level expected vs scanned | **YES** — line linkage via read enrich + V193 product columns |
| **`v_inventory_status`** | Package-level aggregate / status chip | **NO** — chip only |
| **`v_scanned_items_counted`** | Active scan counts | Counters; `return_items.deleted_at IS NULL` (V189) |

**V205/V206:** `package_code` from `packages.package_code` exposed on item + status views (staging + original).

## Approved read paths (Neda)

| Function | Surface |
|----------|---------|
| `fetchInventoryItemStatusForNeda` | Item rows + hydrated `ProductLinkageDisplayContract` |
| `fetchExpectedPackagesNedaRead` | Expected packages + `product_comparison` |
| Filters | `organizationId`, `storeId`, `trackingNumber`, `slipCode`, **`packageCode`** |

Package chip: optional `packageStatusOnly` → `v_inventory_status` only.

## Scanner search behavior

**Gate table:** `v_inventory_item_status` (via `lib/scanner/v-inventory-status.ts`)

| Match field (exact equality, priority order) | Column |
|---------------------------------------------|--------|
| 1 | `fnsku` (slip “ASIN” values often stored here) |
| 2 | `sku` |
| 3 | `tracking_number` |
| 4 | `id_slip_contents` / slip_code |

- Merges duplicate lines by expected-package line id.  
- Visual status: view `status` when present; else derived from expected/scanned totals (`new`, `in_progress`, `completed`, `over_scanned`, `unexpected`, `manual_new`).  
- Demo mode: mock rows from `mockExpectedPackageDetailRows` when enabled.

**Product input lookup:** `lookupProductInputForReturnItem` — local resolver first; backend enrichment gated; evidence-only may set `backend_evidence` when `PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED=true`.

## Operator-mobile workflow

| Action | Path |
|--------|------|
| Add item | `insertReturn` — resolver-on-save |
| Edit item | `updateReturn` — re-resolve on identifier change |
| Scanner save | Server action only — no browser DB writes |
| Product detail | `/pim/products/<product_id>` when resolved |
| Operator product drill-down | `/scanner/operator-mobile/products/<id>` |
| Unresolved UI | “No product link yet” / “Needs review” / mismatch — never fake resolved |

## Display contract

`ProductLinkageDisplayContract` + `ProductLinkageDisplayBlock` — all product-aware UI (scanner, expected, inventory panels, claims inbox).

## Forbidden

- Browser Supabase writes for linkage/catalog  
- Client-side catalog queries for resolution  
- Inferring product from title/OCR in UI  
- `package_items`; legacy `.from("returns")` for lines  

## Evidence

`inventory-views-product-linkage-contract-v179/` · `inventory-views-return-items-deleted-at-filter-v189/` · `main-v206-package-code-inventory-views-original-parity-apply/` · `product-linkage-browser-proof-signoff-v202/`
