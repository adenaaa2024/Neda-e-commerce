# Database contract — canonical index

**Staging:** `eiqfaapyumhixxoeltgu`  
**Original:** `kxsvedvpjldygtdbylsy`  
**Last updated:** 2026-06-07 (`history-memory-update-product-canonicalization-v3` `20260607T140000Z`)

| Topic | File |
|-------|------|
| Platform index | [PLATFORM_ARCHITECTURE.md](PLATFORM_ARCHITECTURE.md) |
| Scanner / receive | [SCANNER_STATE.md](SCANNER_STATE.md) · [EXPECTED_ALLOCATION_MODEL.md](EXPECTED_ALLOCATION_MODEL.md) |
| Identifier governance | [PRODUCT_IDENTIFIER_GOVERNANCE.md](PRODUCT_IDENTIFIER_GOVERNANCE.md) |
| Removal / EP rebuild | [REMOVAL_API_STATE.md](REMOVAL_API_INTAKE.md) |
| Original parity | [STAGING_ORIGINAL_PARITY.md](STAGING_ORIGINAL_PARITY.md) |
| Claims / TRID | [CLAIM_ARCHITECTURE.md](CLAIM_ARCHITECTURE.md) · [CLAIMS_TRID_STATE.md](CLAIMS_TRID_STATE.md) |

## Inventory views — product linkage (staging PASS)

**Execute:** `db-parity-view-linkage-slip-columns-staging-execute/20260529T231120Z/` — **PASS**

| View | Status |
|------|--------|
| `v_scanned_items_counted` | Replaced — linkage cols exposed |
| `v_inventory_item_status` | Replaced — linkage cols exposed |
| `v_inventory_status` | Replaced — linkage cols exposed |

Required linkage columns on item-level views: `resolved_product_id`, `product_id`, `product_linkage_status`, `id_slip_contents`, `package_code`, `product_name`.

**CORRECTED:** Prior memory that V193 columns were live was **stale** — carrier-normalization DDL had overwritten views until this execute restored them.

**Original:** slip/view parity **PASS** — `db-parity-view-linkage-slip-columns-original-execute/20260529T234437Z/`. Product spine view DDL (`expected_package_id`, `product_display_name`) **PENDING**.

## `slip_contents` — identifier columns (staging PASS)

Reconciled columns added (IF NOT EXISTS) on staging:

| Column | Purpose |
|--------|---------|
| `upc`, `fnsku` | Raw identifiers |
| `parsed_asin`, `parsed_fnsku`, `parsed_sku`, `parsed_upc` | Parsed identifier fields |
| `resolved_product_id`, `resolved_catalog_product_id` | Resolver output |
| `identifier_resolution_status`, `identifier_resolution_confidence` | Resolution metadata |

No data backfill in execute — schema-only.

## Receive architecture (non-negotiable)

### `return_items` — item-level

| Rule | Detail |
|------|--------|
| Grain | **One physical scanned item per row** |
| Count | **`COUNT(return_items)`** |
| Receive FK | **`expected_item_id`** → `expected_packages.id` |
| Product | **`resolved_product_id`** via resolver |

### `expected_packages` — group-level

Staging resolver: **6,099 / 6,175** resolved; **76** unresolved.

## Schema apply status

| Migration / DDL | Staging | Original | Repo |
|-----------------|---------|----------|------|
| Item-level receive split | applied | schema wave **4/4** | committed |
| View linkage + slip cols | **applied** staging `20260529T231120Z` | **applied** original `20260529T234437Z` | reconcile audit SQL |
| Product spine view cols | **applied** `20260530T171500Z` | **PENDING** | `product-spine-view-linkage-original-approval.md` |
| `claim_lines` foundation | **NOT applied** | **NOT applied** | drafted |
| TRID foundation | **NOT applied** | **NOT applied** | drafted |

## Build blocker

`npm run build` fails — `tesseract.js` missing in `scan/page.tsx`.

## Evidence

`db-parity-view-linkage-slip-columns-staging-execute/20260529T231120Z/` · `db-parity-view-linkage-column-naming-reconcile/20260530T153000Z/`
