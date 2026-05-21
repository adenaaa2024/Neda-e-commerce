# Product ID / linkage mapping status

**Probe audit:** `product-id-linkage-closure-v167` (run-20260518-001)  
**Migration reference:** `supabase/migrations/20260717120000_scanner_product_linkage_columns.sql`  
**Staging verdict (2026-05-18):** **partial** — linkage on `return_items` / `slip_contents`; EP remains SKU/tracking-only

---

## Live staging (at last closure probe)

| Table | Product FK / resolution columns |
|-------|----------------------------------|
| `return_items` | Partial — `resolved_product_id`, resolution fields when migration applied |
| `slip_contents` | Partial — same |
| `expected_packages` | **No** `resolved_product_id` / `identifier_resolution_*` — intentional |

---

## App contract status

| Component | Status |
|-----------|--------|
| `ProductLinkageDisplayContract` | **In repo** — `lib/scanner/product-linkage-display-contract.ts` |
| Server action wiring (NEDA-15/16) | **PASS** audits |
| EP extended select `EP_*_WITH_SCANNER_PRODUCT_SELECT` | **42703 fallback** until migration applied |
| `db_ep_linkage_select` (NEDA-17) | **FAIL** on staging — column `expected_packages.identifier_resolution_status` absent (expected) |

---

## UI labels (stable)

| Status | User-facing label |
|--------|-------------------|
| Unresolved | No product link yet |
| Ambiguous | Needs review |
| Resolved | Catalog `product_name` via `productLinkagePrimaryLabel` |

---

## What Neda should not do

- Apply `20260717120000` without operator-approved migration run
- Add `identifier_resolution_status` to EP client selects
- Insert into `products` from scanner/OCR

---

## Re-verify

```bash
npx tsx scripts/product-id-linkage-closure-v167-probe.ts   # if present on branch
npx tsx scripts/scanner-neda-16-backend-product-linkage-handoff.ts
```

Update this file after a new closure probe PASS with `migration_fully_applied: true`.
