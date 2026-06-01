# Packaging & dimensions state

**Last updated:** 2026-06-12 (`phase1-roadmap-and-history-memory-update-after-dryruns` `20260612T120000Z`)  
**Branch:** `feature/phase1-latest-stash-land` @ `c78fbb8`  
**Staging:** `eiqfaapyumhixxoeltgu` · **Original:** `kxsvedvpjldygtdbylsy`

## Product sheet dry-run (2026-06-12 — read-only)

| Bucket | Count |
|--------|------:|
| Total spreadsheet rows | **4479** |
| Safe null-fill | **2678** |
| Map candidates | **233** |
| Catalog candidates | **2779** |
| Specs | **32** |
| Blocked creates | **1700** |
| Needs-review / conflicts | **3399** |

**No broad import.** Next: Phase F conflict resolution -> max-**25** sample wave.

**CORRECTED:** prior "90 merge-safe / 80 activated" intake snapshot — full dry-run now classifies **4479** rows with **1700** blocked creates.

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
