# Neda handoff — V176

For **Neda's Cursor** on returns, scanner, and product linkage UI.

## Your lane

- `components/returns/`, scanner routes, linkage badges.
- **Contract:** `ProductLinkageDisplayContract` — `lib/product-linkage-display-contract.ts`
- Server read: `app/returns/product-linkage-actions.ts` (`fetchCanonicalProductDisplay`)
- UI: `components/returns/ReturnItemProductLinkage.tsx`, `ManifestLineProductLinkage`

## Status

| Item | Status |
|------|--------|
| NEDA 15 (product-id UI final) | **PASS** |
| Product linkage contract (V169) | **PASS** |
| Preview E2E (operator signoff) | **PASS** — `env-06c-preview-operator-close-v175/20260519T223000Z` |
| `return_items` staging data | **6 test rows** — not production KPIs |
| Production | **Do not use** |

## DB & workspace

- **Staging:** `eiqfaapyumhixxoeltgu`
- **Preview:** same ref (integration branch)
- **Org / store:** Sam Distribution Inc · Sam AM

## Verification (complete)

Preview signoff closed — routes exercised per ENV-06C checklist (`/returns`, `/scanner`, PIM, claims evidence, imports). Report new UI bugs with route + screenshot only.

## Do not

- `.from("returns")` — use `return_items`.
- Create `package_items`.
- Auto-create `products` from OCR/title on save path.
- Run resolver executes or production deploys.

## Optional (operator-only)

`ENABLE_RETURNS_BARCODE_PRODUCT_CACHE_INSERT` — separate V165 approval; **not** resolver auto-create.

## Evidence

- Preview close: `.cursor/audit-reports/env-06c-preview-operator-close-v175/20260519T223000Z/`
- Schema smoke (linkage checks): `schema-product-combined-smoke-v175/20260519T240000Z/`
