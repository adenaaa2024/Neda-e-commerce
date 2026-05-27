# Packaging & dimensions state

**Last updated:** 2026-05-28 (`removal-api-product-resolution-checkpoint` `20260528T180000Z`)  
**Branch:** `feature/product-canonicalization-v2`  
**Staging:** `eiqfaapyumhixxoeltgu` · **Original:** `kxsvedvpjldygtdbylsy`

## `dimensions_current` totals

| Ref | Count | Notes |
|-----|------:|-------|
| Staging | **571** | Operator checkpoint (post-Wave3); confirm via full parity verify |
| Original | **571** | Same |

| Verify artifact | Result |
|-----------------|--------|
| `pc05-packaging-full-parity-verify/20260526T214000Z` | **441/441**, drift 0 (Wave1+2+pilot only) |

**PC05-PACKAGING-FULL-PARITY-VERIFY** should be re-run after Wave3 parity to lock **571**.

## Governed waves (through Wave2 on disk)

191 pilot + 50 Wave1 + 200 Wave2 = **441** (verified).

## Spreadsheet program (separate)

4,479 rows · 90 merge-safe · not counted in governed wave total until approved import.

## Constraints

No `products` UPDATE on packaging paths · no Amazon API · no AI/OpenAI.
