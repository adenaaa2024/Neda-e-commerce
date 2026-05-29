# Database contract — canonical index

**Staging:** `eiqfaapyumhixxoeltgu`  
**Original:** `kxsvedvpjldygtdbylsy`  
**Last updated:** 2026-06-01 (`phase1-delivery-status-update` `20260601T120000Z`)

| Topic | File |
|-------|------|
| Scanner / receive model | [SCANNER_STATE.md](SCANNER_STATE.md) |
| Removal / EP rebuild | [REMOVAL_API_STATE.md](REMOVAL_API_STATE.md) |
| Original parity | [STAGING_ORIGINAL_PARITY.md](STAGING_ORIGINAL_PARITY.md) |
| Claims / TRID | [CLAIMS_TRID_STATE.md](CLAIMS_TRID_STATE.md) |

## Receive architecture (non-negotiable)

### `return_items` — item-level

| Rule | Detail |
|------|--------|
| Grain | **One physical scanned item per row** |
| Count | **`COUNT(return_items)`** — not a quantity column on the row |
| Forbidden | `quantity_entered`, `scanned_quantity`, quantity-only receive allocation |
| Receive FK | **`expected_item_id`** → `expected_packages.id` (`receive_allocated`) |
| Product | **`resolved_product_id`** via resolver on insert/update |

### `expected_packages` — group-level

| Concept | Location |
|---------|----------|
| Expected qty | `expected_scan_quantity` |
| Partial receive | `build_source = receive_allocated` + remainder on root |
| Removal-derived | `detail_shipment`, `detail_remainder`, `legacy` |
| Staging resolver | **6,099 / 6,175** resolved; **76** unresolved |

### Receive operations

- Insert **1** `return_items` per scan; allocate **1** unit per `return_item_id`  
- RPCs present on staging + original (schema wave **4/4** applied)  
- **Quantity-only allocation blocked**

**Committed repair:** `51bc597` — item-level scanner receive allocation repair

## Schema apply status

| Migration | Staging | Original | Repo |
|-----------|---------|----------|------|
| Item-level receive split | applied | schema wave **4/4** | committed |
| `claim_lines` foundation | **NOT applied** | **NOT applied** | drafted |
| TRID foundation | **NOT applied** | **NOT applied** | drafted; needs `claim_lines` |

## Build blocker

`npm run build` fails — `tesseract.js` missing in `scan/page.tsx`. Fix before deploy.

## Evidence

`commit-push-item-level-repair-and-phase1/20260528T191934Z/` · `original-parity-phase1-wave-schema-execute/20260530T180000Z/`
