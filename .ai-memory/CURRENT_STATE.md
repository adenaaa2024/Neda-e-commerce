# Current state — canonical system memory

**Last updated:** 2026-05-28 (`removal-api-product-resolution-checkpoint` `20260528T180000Z`)  
**Branch:** `feature/product-canonicalization-v2`  
**History:** `.cursor/history/ERP_PIM_FULL_APPEND_ONLY_HISTORY_MASTER.md` (sections 1–17)

## Removal API / expected_packages (checkpoint)

| Topic | State |
|-------|--------|
| Detail truth | `amazon_removals` ← `GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA` |
| Shipment truth | `amazon_removal_shipments` ← `GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA` |
| Intake | **`expected_packages`** only (no `accepted_packages`) |
| Rebuild | `rebuild_expected_packages_from_removals` |
| Join | 7-tuple NULL-safe; **no** SKU-only / FNSKU-only |
| Products | **No** create on fetch/rebuild; promotion only with Amazon evidence |

Detail: [REMOVAL_API_INTAKE.md](REMOVAL_API_INTAKE.md)

## Packaging parity

| Metric | Value |
|--------|------:|
| `dimensions_current` (checkpoint) | **571** staging · **571** original (operator; post-Wave3 cohort) |
| Last full parity verify on disk | **441/441** PASS (`pc05-packaging-full-parity-verify/20260526T214000Z`) |

Re-run **PC05-PACKAGING-FULL-PARITY-VERIFY** to confirm **571** alignment when Wave3 parity is claimed PASS.

## Spreadsheet intake (unchanged)

4,479 rows · 175 parseable L×W×H · 90 merge-safe · 85 dup-ASIN review · 4,304 missing dims · 0 ASIN dim conflicts.

## Product linkage

Not **100%** across tables — **PRODUCT-LINKAGE-TABLE-COVERAGE-AUDIT** ongoing.

## Environment

| Surface | Ref |
|---------|-----|
| Staging | `eiqfaapyumhixxoeltgu` |
| Original | `kxsvedvpjldygtdbylsy` |
| Future production | **NOT_CREATED_YET** / **BLOCKED** |

## Session start

1. This file · [REMOVAL_API_INTAKE.md](REMOVAL_API_INTAKE.md)  
2. [PRODUCT_CANONICALIZATION.md](PRODUCT_CANONICALIZATION.md) · [PACKAGING_DIMENSIONS_STATE.md](PACKAGING_DIMENSIONS_STATE.md)  
3. [STAGING_ORIGINAL_PARITY.md](STAGING_ORIGINAL_PARITY.md) · [NEXT_ACTIONS.md](NEXT_ACTIONS.md)
