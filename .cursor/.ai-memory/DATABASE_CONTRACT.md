# Database contract — canonical index

**Staging:** `eiqfaapyumhixxoeltgu`  
**Original:** `kxsvedvpjldygtdbylsy`  
**Last updated:** 2026-05-31 (`architecture-correction-history-memory-update` `20260531T120000Z`)

| Topic | File |
|-------|------|
| Scanner / return / claims (corrected) | [SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md](SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md) |
| Scanner / receive | [SCANNER_STATE.md](SCANNER_STATE.md) · [EXPECTED_ALLOCATION_MODEL.md](EXPECTED_ALLOCATION_MODEL.md) |
| Identifier governance | [PRODUCT_IDENTIFIER_GOVERNANCE.md](PRODUCT_IDENTIFIER_GOVERNANCE.md) |
| Removal / EP rebuild | [REMOVAL_API_STATE.md](REMOVAL_API_INTAKE.md) |
| Original parity | [STAGING_ORIGINAL_PARITY.md](STAGING_ORIGINAL_PARITY.md) |
| Claims / TRID | [CLAIM_ARCHITECTURE.md](CLAIM_ARCHITECTURE.md) · [CLAIMS_TRID_STATE.md](CLAIMS_TRID_STATE.md) |

## CORRECTED — receive architecture (non-negotiable)

### `return_items` — physical scan only

| Rule | Detail |
|------|--------|
| Grain | **One physical scanned item per row** — never bulk-created from forecast |
| Count | **`COUNT(return_items WHERE deleted_at IS NULL)`** |
| Anchor | **`package_id`** (+ `pallet_id`) required for proven physical scan |
| Receive FK | **`expected_item_id`** → allocated EP child — set **after** insert via RPC |
| Product | **`resolved_product_id`** via resolver on insert — not EP bulk copy |

**Staging (post Wave2 rollback PASS):** active **5,366** · resolved **57** · ~**5,333** bulk orphans pending quarantine · ~**3** proven scans.

### `expected_packages` — forecast + allocation

| Rule | Detail |
|------|--------|
| Root rows | API/removal/import forecast — `expected_scan_quantity` |
| Child rows | `build_source = 'receive_allocated'` — allocation ledger |
| Product | **`resolved_product_id`** on EP spine via `product_identifier_map` |

**FORBIDDEN:** bulk denormalize EP.resolved_product_id → RI without physical scan proof.

## Inventory views

`v_scanned_items_counted` · `v_inventory_item_status` · `v_inventory_status` — read models; currently inflated by orphan RIs until quarantine or view filter.

## Schema apply status

| Migration / DDL | Staging | Original | Notes |
|-----------------|---------|----------|-------|
| Item-level receive split | applied | schema wave 4/4 | committed |
| View linkage + slip cols | applied | applied | PASS |
| `claim_lines` foundation | **applied** | varies | staging has import/group lines only |
| Delete cascade/undo audit | **not applied** | **not applied** | draft |

## Future DB write gate

Read-only architecture audit + operator approval required before scanner/expected/return/claims writes.

## Evidence

`full-scanner-expected-returns-claims-architecture-readonly/20260531T084101Z/`
