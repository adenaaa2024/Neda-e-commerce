# Views, APIs, and UI — linkage field exposure

## Database views

| View | Staging | Product linkage exposed |
|------|---------|-------------------------|
| `v_product_identity` | **Not in schema cache** (`PGRST205`) | Repo defines `product_id`-less unified identity (org, sku, asin, fnsku, seller_sku, upc_code) — requires migration `20260630` on project |

## REST / server actions (no dedicated product-linkage REST route)

Product linkage is exposed through **Supabase table selects** in server actions and pages, not standalone `/api/*` product endpoints.

| Surface | Select / field exposure | Staging |
|---------|-------------------------|---------|
| Returns list/detail | `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` includes linkage quartet | **PASS** |
| Returns manual product fix | `_components.tsx` updates `resolved_product_id` + re-selects with linkage | **PASS** (core cols) |
| Operator mobile scan UI | Slip/return rows read linkage + optional `identifier_resolution_source` in UI badges | Source column **not on DB** — badges degrade gracefully (`useScannerProductResolutionBadges`) |
| Manual override action | `item-actions.ts` → `manualOverrideReturnItemProductResolution` | Patch includes `identifier_resolution_source` — **may not persist** |
| Tracking expectations | `EP_SELECT` only (no product cols) | **PASS** |
| Import APIs | `/api/settings/imports/*` — writes `product_identifier_map` / products via import pipeline, not scanner linkage cols | N/A for scanner closure |

## Types

`types/database.types.ts` and `app/returns/returns-action-types.ts` declare full NEXT-SCANNER-02 shape (`expected_product_id`, `scanned_product_id`, `identifier_resolution_source`, etc.) — **ahead of live DB**.

## UI components

| Component / hook | Linkage usage |
|------------------|---------------|
| `app/returns/_components.tsx` | Displays resolution badges; manual override sets `resolved_product_id` |
| `app/scanner/operator-mobile/scan/page.tsx` | Renders `identifier_resolution_status`, optional source for badges |
| `hooks/use-scanner-product-resolution.ts` | Badge helper only (client-safe when cols undefined) |
| `lib/scanner/product-resolution-badges.ts` | Match/mismatch/ambiguous/manual_override |

## Verdict

| Layer | Status |
|-------|--------|
| Returns UI reads linkage quartet | **PASS** |
| Scanner UI reads linkage when present | **PASS** |
| Extended fields (source, match status, EP product FK) | **FAIL** until migration |
| `v_product_identity` for cross-module reads | **NOT ON STAGING** |
