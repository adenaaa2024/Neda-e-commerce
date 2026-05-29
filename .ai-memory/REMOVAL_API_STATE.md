# Removal API state — operational checkpoint

**Branch:** `feature/product-canonicalization-v2`  
**Staging:** `eiqfaapyumhixxoeltgu`  
**Original:** `kxsvedvpjldygtdbylsy`  
**Last updated:** 2026-05-28 (`original-parity-wave-data-resolver-finish-verify` `20260528T220000Z`)

Architecture: [REMOVAL_API_INTAKE.md](REMOVAL_API_INTAKE.md) · Receive model: [SCANNER_STATE.md](SCANNER_STATE.md)

## Staging data (current)

| Metric | Value |
|--------|------:|
| `expected_packages` total | **6,175** |
| EP resolved | **6,099** |
| EP unresolved | **76** |

## Staging pipeline (complete)

| Step | Status |
|------|--------|
| Order + Shipment Detail fetch/sync | **DONE** |
| Grouped EP rebuild | **DONE** — 5,697 + 478 |
| Tracking + carrier normalization | **DONE** |
| Main EP resolver | **6,099 / 6,175** |

Intake: **`expected_packages` only**. Rebuild: `rebuild_expected_packages_from_removals`.

## Original parity

| Wave | Status |
|------|--------|
| Schema wave | **PASS** — **4/4** migrations on `kxsvedvpjldygtdbylsy` |
| Data wave | **PASS** — `original-parity-phase1-wave-data-execute/20260528T201200Z/` |
| Resolver finish verify | **PASS** — `original-parity-wave-data-resolver-finish-verify/20260528T220000Z/` |

### Original data (live)

| Metric | Value |
|--------|------:|
| derived `expected_packages` | **11,790** |
| EP resolved | **9,377** |
| EP unresolved | **2,413** |
| ambiguous | **0** |
| `rebuild_valid` | **yes** (non-overflow mismatch **0**) |

No products/PIM inserts in data wave. **Forbidden:** bulk staging clone.

## Evidence

`original-parity-phase1-wave-data-execute/20260528T201200Z/` · `original-parity-wave-data-resolver-finish-verify/20260528T220000Z/` · `original-parity-phase1-wave-schema-execute/20260530T180000Z/`
