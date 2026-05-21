# Current state — V192 product resolution contract lock (authoritative)

**Last updated:** V192 contract lock `20260521T012000Z`  
**Latest operator history:** [HISTORY_POINTERS.md](HISTORY_POINTERS.md) →  
`.cursor/audit-reports/history-v191/20260526T120000Z/ERP_PIM_FULL_HISTORY_V191_APPEND_ONLY_ITEM_ADD_EDIT_RESOLVER_STANDARD.md`  
**Canonical base:** `history-canonical-rebuild-v182/20260518T120000Z/ERP_PIM_FULL_HISTORY_V182_CANONICAL_APPEND_ONLY_REBUILT.md`

## Milestone — V191 item add/edit + read alignment

| Gate | Status |
|------|--------|
| Operator item add/edit resolver standard | **PASS** (16/16 smoke; server actions only) |
| Direct browser `return_items` writes on save | **Blocked / not detected** |
| Detail + package/pallet linkage display | **PASS** (`ProductLinkageDisplayContract`) |
| Inventory expected/scanned read alignment | **PASS** (read-layer `product_comparison`; no DDL) |
| V190 return_items test cohort | **3** active · **3** resolved · **0** unresolved · **4** soft-deleted |
| Neda final backend handoff V191 | **PASS** (docs-only) |
| AFI guarded Tier 3 SKU/no-ASIN-conflict execute | **PASS** — 109 rows updated on staging |
| Product resolution contract lock V192 | **PASS** — guard script + scanner server-action wrapper |
| Expected packages E1 map bridge V192 plan | **PASS** — 254 candidate rows / 134 insert-plan map rows; approval false |
| NEDA-20 | **NOT_FOUND** |

## Environment

| Surface | DB ref |
|---------|--------|
| Staging / local / Preview / Neda | `eiqfaapyumhixxoeltgu` |
| Original (Vercel Production app) | `kxsvedvpjldygtdbylsy` |
| Future production project | **NOT_CREATED_YET** / **BLOCKED** |

## Add/edit/save standard (authoritative)

- Add: UI → `insertReturn` → deterministic resolver → persist.
- Edit: UI → `updateReturn` → re-run resolver when identifiers or org/store scope change.
- Inputs: `fnsku`, `asin`, `sku`, `product_identifier` (UPC/GTIN/barcode).
- One map winner → `resolved_product_id`; no winner / ambiguous / mismatch → no auto-create; review labels preserved.

## Product Resolution Contract — Non-Negotiable

All product-aware paths must use:

`input -> normalize identifiers -> resolver -> products + product_identifier_map -> persist resolved_product_id only when deterministic -> hydrate ProductLinkageDisplayContract -> render the same contract.`

Forbidden: direct browser product-aware writes, UI-side `products.insert` / `products.upsert`, `package_items`, legacy `.from("returns")`, raw detail reads without hydration, and title/OCR/fuzzy/AI auto-link or auto-create.

Guard command: `npm run check:product-resolution-contract-v192`.

V192 remediation: scanner `expected_packages.actual_scanned_count` save moved from direct client Supabase update to server action `updateExpectedPackageScannedCount`.

## View comparison status

| Layer | Status |
|-------|--------|
| `fetchExpectedPackagesNedaRead` | Product-key-first `product_comparison`; active `return_items` exclude soft-deleted |
| `fetchInventoryItemStatusForNeda` | Same comparison model + hydrated linkage display |
| Live `v_scanned_items_counted` | `deleted_at IS NULL` present |
| Live `v_inventory_item_status` / `v_inventory_status` | DB still raw-group / package-aggregate; DDL plan only — not applied |

## expected_packages coverage (staging)

| Metric | Value |
|--------|------:|
| Total rows | 1,626 |
| Read-layer resolved | 1,263 |
| Unresolved (V191 baseline) | 363 |
| E1 map-only bridge recompute | **254** expected rows, **134** unique map insert-plan rows |
| E1 ambiguity exclusions | **10** rows |
| E1 approval | `.cursor/operator-approvals/expected-packages-e1-map-bridge-v192-approval.md` default false |
| Remaining governed waves | E2 promote **29** · E4 review **117** baseline; refresh after E1 execute |

## Unresolved product policy

Display unresolved until governed catalog/import fills `products` + `product_identifier_map`. No OCR/title/fuzzy/AI auto-create. Ambiguous → needs review. Amazon API not used for resolution in V191 packs.

## Catalog/import wave status

| Metric | Value |
|--------|------:|
| AFI resolved | 14,693 / 19,503 (**75.34%**) |
| AFI unresolved | 4,810 |
| Guarded Tier 3 SKU/no-ASIN-conflict execute | **109** rows updated; products/map counts unchanged |
| Broad Tier 3 with ASIN conflict | **14** excluded from guarded batch |

## Next program priorities

1. Execute Expected_packages E1 map-only bridge only after approval flags are flipped  
2. Optional approval-gated inventory view DDL  
3. Claim cleanup / TRID / API hardening  
4. Remaining product catalog/import completeness cohorts under separate governance  
5. Keep V192 guard passing on all product-aware changes  
6. AI layer (later; default deny)

## Carried gates

| Gate | Status |
|------|--------|
| V181 Neda read signoff | **PASS** |
| Claims staging | **72.7%** / **51.5%** |
| `package_items` | **FORBIDDEN** |
| Legacy `returns` | **FORBIDDEN** |

## Evidence

`history-memory-after-v191-item-resolver/20260526T120000Z/` · `operator-item-add-edit-resolver-standard-v191/20260520T235500Z/` · `inventory-expected-return-product-id-view-alignment-v191/20260521T001108Z/` · `neda-final-backend-handoff-v191/20260521T004000Z/` · `product-catalog-afi-guarded-tier3-sku-no-asin-conflict-v191/20260521T010000Z/` · `backend-product-resolution-contract-lock-v192/20260521T012000Z/` · `expected-packages-e1-map-bridge-plan-v192/20260521T013000Z/`
