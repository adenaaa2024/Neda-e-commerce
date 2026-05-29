# Scanner state — Neda / operator-mobile

**Branch:** `feature/product-canonicalization-v2`  
**Staging:** `eiqfaapyumhixxoeltgu`  
**Last updated:** 2026-06-01 (`phase1-delivery-status-update` `20260601T120000Z`)

Contract reference: [SCANNER_OPERATOR_CONTRACTS.md](SCANNER_OPERATOR_CONTRACTS.md)

## Item-level receive model (canonical — do not regress)

### `return_items` — **item-level**

| Rule | Contract |
|------|----------|
| Grain | **One physical scanned item per row** |
| Count | **`COUNT(return_items)`** — not a quantity column |
| Forbidden | **`quantity_entered`**, **`scanned_quantity`**, quantity-only allocation |
| Receive pointer | **`expected_item_id`** → allocated `expected_packages.id` |
| Product link | **`resolved_product_id`** via resolver when deterministic |

### `expected_packages` — **group-level allocation**

| Field / concept | Lives here |
|-----------------|------------|
| `expected_scan_quantity` | Group expected qty |
| `receive_allocated` / remainder | Partial receive state |
| Product resolver | **6,099 / 6,175** resolved staging |

**Migrations:** `20260829120000_expected_receive_split.sql` · `20260830120000_expected_receive_split_item_level.sql`

## Git delivery

| Item | Status |
|------|--------|
| Commit | **`51bc597ba1ed1d49761b5650b73f36704f72b1aa`** pushed |
| Message | `phase1: item-level scanner receive allocation repair` |
| PR | **Not opened** — needs `GH-AUTH-PR-CREATE` |

## Neda smoke

| Item | Status |
|------|--------|
| Item-level smoke | **PASS** after branch sync |
| Evidence | `pr-phase1-item-level-repair/20260531T150000Z/` — `staging_smoke_pass: true` |

## Build blocker

`npm run build` **FAIL** — `tesseract.js` missing in `app/scanner/operator-mobile/scan/page.tsx`. Fix before deploy.

## Original parity

Schema wave **4/4 PASS** on original (`kxsvedvpjldygtdbylsy`); functions/views parity **PASS**. Data wave **NOT EXECUTED**.

## Evidence

`commit-push-item-level-repair-and-phase1/20260528T191934Z/` · `pr-phase1-item-level-repair/20260531T150000Z/` · `expected-receive-split-item-row-repair-execute/20260528T180714Z/`
