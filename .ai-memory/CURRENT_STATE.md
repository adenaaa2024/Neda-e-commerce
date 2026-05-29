# Current state — canonical system memory

**Last updated:** 2026-05-28 (`original-parity-wave-data-resolver-finish-verify` `20260528T220000Z`)  
**Branch:** `feature/product-canonicalization-v2`

## Phase1 delivery status

| Track | Status |
|-------|--------|
| Git / commit | **`51bc597`** pushed — `phase1: item-level scanner receive allocation repair` |
| Build | **BLOCKED** — `npm run build` fails on `tesseract.js` / `scan/page.tsx` |
| Staging EP | **6,175** total; **6,099** resolved; **76** unresolved |
| Original schema wave | **PASS** — **4/4** migrations on `kxsvedvpjldygtdbylsy`; functions/views parity **PASS** |
| Original data wave | **EXECUTED + resolver PASS** — **11,790** derived EP; **9,377** resolved; **2,413** unresolved; verify `original-parity-wave-data-resolver-finish-verify/20260528T220000Z/` |
| Claims | `claim_lines` migration **drafted**; dry-run **PASS**; **not applied**; ~**13,966** upper bound pre-dedupe |
| TRID | migration **drafted**; dry-run **PASS_WITH_BLOCKERS**; **not applied**; `claim_lines` prerequisite **missing** |
| Neda | Item-level smoke **PASS** after sync; branch needs **PR/merge** handling |

## Item-level receive model (locked)

| Layer | Grain |
|-------|--------|
| **`return_items`** | **Item-level** — 1 row = 1 physical scan; count = `COUNT(return_items)` |
| **`expected_packages`** | **Group-level** — `expected_scan_quantity`, `receive_allocated`/remainder, slip/package/pallet scope |

Receive: insert 1 RI row → allocate 1 EP unit via `expected_item_id`. **No** quantity-only scanner allocation.

Detail: [SCANNER_STATE.md](SCANNER_STATE.md) · [REMOVAL_API_STATE.md](REMOVAL_API_STATE.md)

## Session start

1. [NEXT_ACTIONS.md](NEXT_ACTIONS.md) — build fix → original data → claim_lines → PR  
2. [STAGING_ORIGINAL_PARITY.md](STAGING_ORIGINAL_PARITY.md) · [CLAIMS_TRID_STATE.md](CLAIMS_TRID_STATE.md)  
3. [DATABASE_CONTRACT.md](DATABASE_CONTRACT.md)
