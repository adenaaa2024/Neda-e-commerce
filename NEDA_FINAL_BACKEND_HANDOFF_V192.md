# NEDA Final Backend Handoff V192

**Owner:** Main/user  
**Mode:** Agent, architecture + code guardrails  
**Run ID:** `20260521T012000Z`  
**Audience:** Neda, GPT, Cursor, Codex

This handoff locks the product resolution read/write contract across item UI, scanner, package, pallet, expected/scanned, import, API, and claim flows.

## Product Resolution Contract — Non-Negotiable

Every product-aware path must use this flow:

```text
Manual/UI/API/import input
-> normalize identifiers
-> product resolver
-> products + product_identifier_map
-> persist resolved_product_id only when deterministic
-> return/hydrate ProductLinkageDisplayContract
-> UI/detail/package/pallet/views render the same contract
```

There is no alternate display DTO and no shortcut write path for product identity.

## Applies To

- Manual add item.
- Manual edit item.
- Scanner save.
- Package detail item children.
- Pallet detail item children.
- Return item detail.
- Expected packages.
- Slip contents.
- Imports / Amazon files.
- API ingestion.
- Claim generation.
- Neda UI surfaces.

## Allowed Patterns

- Approved server action for product-aware writes.
- Resolver-on-save whenever identifiers or org/store scope are created or changed.
- Governed import/resolver scripts with evidence, rollback, and operator approval.
- Read hydration through `ProductLinkageDisplayContract`.
- Display unresolved/ambiguous/mismatch states when deterministic resolution is not possible.

Canonical entrypoints include:

- `insertReturn`
- `updateReturn`
- scanner server action wrappers such as `updateExpectedPackageScannedCount`
- `resolveScannerProductIdentifiers`
- `fetchProductLinkageDisplayContract`
- `buildProductLinkageDisplayContracts`
- `fetchExpectedPackagesNedaRead`
- `fetchInventoryItemStatusForNeda`
- `ReturnItemProductLinkage`
- `ProductLinkageDisplayBlock`

## Forbidden Patterns

- Direct browser Supabase writes for product-aware rows.
- UI-side `products.insert` or `products.upsert`.
- `package_items`.
- Legacy `.from("returns")`.
- Raw `return_items` detail reads without `ProductLinkageDisplayContract` hydration.
- Title/OCR/fuzzy/AI auto-linking.
- Product auto-create from OCR/title/free text/UI guess.
- Amazon API or AI/OpenAI calls for resolution unless separately approved.
- Production DB mutation.
- Migrations without explicit approval.

## Canonical Product Spine

- `products`: canonical product row.
- `product_identifier_map`: deterministic identifier bridge.
- `resolved_product_id`: persisted only when one deterministic product winner is proven.

Expected/scanned comparisons use product identity first, then deterministic identifier fallback:

1. `resolved_product_id`
2. legacy scanned `product_id` only when no canonical key exists
3. `fnsku`
4. `asin + sku`
5. `asin`
6. `sku`
7. `product_identifier`

If both sides have product IDs and they differ, raw identifier collisions must not override the mismatch.

## Read Surfaces

- Detail reads must hydrate `ProductLinkageDisplayContract`.
- Package detail child rows must render child `return_items` through the same contract.
- Pallet drilldown must render package child `return_items` through the same contract.
- Expected packages use `fetchExpectedPackagesNedaRead`.
- Inventory item status uses `fetchInventoryItemStatusForNeda`.
- `v_inventory_status` remains package aggregate/chip data only.

## Write Surfaces

- Manual add item: UI -> server action -> normalize -> resolver -> persist deterministic product result.
- Manual edit item: UI -> server action -> rerun resolver if identifiers or org/store scope changed.
- Scanner save: UI -> server action wrapper, not direct browser Supabase write.
- Imports/API/claims: governed resolver/import paths only; no title/OCR/fuzzy/AI auto-link.

## Guardrail

Run this before handing off any product-aware change:

```bash
npm run check:product-resolution-contract-v192
```

The guard scans active app/component/hook/lib source for:

- direct browser product-aware Supabase writes
- `products.insert` / `products.upsert` from UI
- `package_items`
- `.from("returns")`
- raw client `return_items` reads
- obvious title/OCR/fuzzy/AI auto-link assignments

## V192 Result

- Scanner `expected_packages.actual_scanned_count` save was moved from a direct client Supabase update to server action `updateExpectedPackageScannedCount`.
- V192 guard result: **PASS**.
- Informational finding retained: `app/returns/barcode-product-cache-actions.ts` has a server-action `products.insert` path for the existing barcode cache exception; it does not set `resolved_product_id` and is not client UI code.

## Evidence

- `.cursor/audit-reports/backend-product-resolution-contract-lock-v192/20260521T012000Z/`
- `ARCHITECTURE.md`
- `PROJECT_CONTEXT.md`
- `CODEX_ONBOARDING.md`
- `.ai-memory/DATABASE_CONTRACT.md`
- `.ai-memory/NEDA_HANDOFF.md`
- `.ai-memory/PRODUCT_ID_MAPPING_STATUS.md`
- `scripts/product-resolution-contract-guard-v192.ts`
