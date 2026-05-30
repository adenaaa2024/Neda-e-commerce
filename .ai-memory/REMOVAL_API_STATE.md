# Removal API state — operational checkpoint

**Branch:** `feature/product-canonicalization-v3` @ `4402064`  
**Staging:** `eiqfaapyumhixxoeltgu`  
**Original:** `kxsvedvpjldygtdbylsy`  
**Last updated:** 2026-06-09 (`history-memory-align-after-phase1-census` `20260609T140000Z`)

Architecture: [REMOVAL_API_INTAKE.md](REMOVAL_API_INTAKE.md) · Receive: [SCANNER_STATE.md](SCANNER_STATE.md)

## Staging pipeline

| Step | Status |
|------|--------|
| Order + Shipment Detail fetch/sync | **DONE** (gap fetch/sync still queued — see next) |
| Grouped EP rebuild | **DONE** |
| Tracking + carrier normalization | **DONE** |
| Verify gate | **aligned** — burn-in retry **PASS** |
| Resolver (latest) | **+6 EP** resolved on staging |

## Staging data

| Metric | Value |
|--------|------:|
| `expected_packages` total | **6,175** (+6 from latest resolver) |
| EP resolved | **~6,105** (post +6; verify live) |
| EP unresolved | **~70** (approx post +6) |

Intake: **`expected_packages` only**. Rebuild: `rebuild_expected_packages_from_removals`.

## Original parity

| Wave | Status |
|------|--------|
| Schema wave | **PASS** — 4/4 migrations |
| Data wave | **PASS** |
| Slip/view DB parity | **PASS** — `db-parity-view-linkage-slip-columns-original-execute/20260529T234437Z/` |

### Original data (live)

**9,377 / 11,790** resolved; **2,413** unresolved.

## Next

**REMOVAL-STAGING-GAP-FETCH-SYNC** — priority #1 per phase 1 census alignment.

## Evidence

`removal-automation-verify-gate-align/` · `db-parity-view-linkage-slip-columns-original-execute/20260529T234437Z/`

