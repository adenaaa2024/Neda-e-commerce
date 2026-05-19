# Files changed

| File | Change |
|------|--------|
| `app/returns/returns-constants.ts` | Safe `RETURN_SCANNER_LINKAGE_SELECT`; trimmed `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` |
| `lib/scanner/operator-tracking-expectations.ts` | Removed `asin` from `EP_SELECT`; default EP fetches use `EP_DETAIL_SELECT` / `EP_SELECT` |
| `lib/scanner/resolve-product-for-scanner-item.ts` | Dropped EP product-column lookup; `expected_package_id` hint only |
| `lib/scanner/apply-return-item-product-enrichment.ts` | Live-DB linkage patch only + column fallback |
| `lib/scanner/enrich-slip-contents-product-links.ts` | Linkage-only slip patch + fallback |
| `lib/scanner/scanner-linkage-patch.ts` | **New** — retry UPDATE without missing optional columns |
| `app/scanner/operator-mobile/item-actions.ts` | `expected_package_id`; safe manual override select/patch |
| `app/returns/actions.ts` | Enrichment uses `expected_package_id` |
| `app/returns/returns-action-types.ts` | `expected_package_id` on insert payload |
| `app/scanner/operator-mobile/_components/operator-store-actions.ts` | Slip list select attempts include linkage columns |
| `app/scanner/operator-mobile/scan/page.tsx` | Slip hydration selects linkage columns; type cast fix |

Neda UI layout/workflow unchanged (identify gate, box slip, receive path).
