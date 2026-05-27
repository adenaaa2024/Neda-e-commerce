# Staging / original parity

**Last updated:** 2026-05-28 (`removal-api-product-resolution-checkpoint` `20260528T180000Z`)

## Refs

| Role | Ref |
|------|-----|
| **Staging** | `eiqfaapyumhixxoeltgu` |
| **Original** | `kxsvedvpjldygtdbylsy` |
| **Future production** | `NOT_CREATED_YET` |

## Packaging `dimensions_current`

| Metric | Staging | Original |
|--------|--------:|---------:|
| Operator checkpoint | **571** | **571** |
| Last full parity verify (disk) | 441 matched | 441 matched |

Re-run full parity verify when Wave3 cohort is claimed complete.

## Removal / expected_packages

Removal-derived rows use **`expected_packages`** on both refs when rebuild executes — per-org/store idempotent rebuild; no UUID copy from staging to original.

## Product linkage

**Not 100%** — coverage audit ongoing.

Detail: [REMOVAL_API_INTAKE.md](REMOVAL_API_INTAKE.md) · [PACKAGING_DIMENSIONS_STATE.md](PACKAGING_DIMENSIONS_STATE.md)
