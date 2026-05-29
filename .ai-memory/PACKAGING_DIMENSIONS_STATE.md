# Packaging & dimensions state

**Last updated:** 2026-05-31 (`phase1-scanner-removal-checkpoint` `20260531T140000Z`)  
**Branch:** `feature/product-canonicalization-v2`  
**Staging:** `eiqfaapyumhixxoeltgu` · **Original:** `kxsvedvpjldygtdbylsy`

## `dimensions_current` totals

| Ref | Count | Notes |
|-----|------:|-------|
| Staging | **571** | 441 governed + **80** spreadsheet |
| Original | **571** | **80/80** spreadsheet parity PASS |

| Cohort | Count | Status |
|--------|------:|--------|
| Governed (pilot + W1 + W2) | **441** | `pc05-packaging-full-parity-verify/20260526T214000Z` — **441/441**, drift 0 |
| Spreadsheet activate | **80** | `spreadsheet-packaging-activate-staging/20260528T050000Z` |
| Spreadsheet original parity | **80/80** | `spreadsheet-packaging-original-parity-verify/20260528T080000Z` |

Batch tag: `SPREADSHEET_DIMENSIONS_20260528T010000Z`

## Governed waves (through Wave2 on disk)

191 pilot + 50 Wave1 + 200 Wave2 = **441** (verified both refs).

## Spreadsheet program (intake context)

4,479 rows · 90 merge-safe · 80 activated in first approved cohort · remainder in backlog.

## Constraints

No `products` UPDATE on packaging paths · no Amazon API · no AI/OpenAI.
