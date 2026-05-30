# Migration ledger

**Last updated:** 2026-05-27 (`packaging-wave2-final` `20260527T220000Z`)

## Operator-applied — migration commit gap (PC06A)

| Artifact | Staging | Original | Notes |
|----------|---------|----------|-------|
| PC04 packaging DDL | yes | yes IN PARITY | commit gap |
| V193 product columns | yes (restored `20260529T231120Z`) | **PENDING** mirror execute | **CORRECTED:** carrier-normalization had overwritten views |
| V205 package_code views | yes | yes | commit gap |

## DML — packaging

| Wave | Staging | Original | Rollback |
|------|---------|----------|----------|
| Pilot (191) | active/current | **PASS** PC05C `20260526T180000Z` | yes |
| Wave1 (50) | active/current | **PASS** PC05E `20260526T200000Z` | per execute |
| Wave2 (200) | active/current | **PASS** PC05F `20260526T211000Z` + verify `20260526T212000Z` | per execute |
| **Full parity census** | 441 | 441 | read-only `pc05-packaging-full-parity-verify/20260526T214000Z` |

### PC05-PACKAGING-FULL-PARITY-VERIFY (`20260526T214000Z`)

| Metric | Value |
|--------|------:|
| staging_total | 441 |
| original_total | 441 |
| matched | **441/441** |
| drift | **0** |
| products UPDATE | 0 |

### PC05F Wave2 original execute (`20260526T211000Z`)

| Metric | Value |
|--------|------:|
| Profiles inserted | 200 |
| Versions inserted | 200 |
| smoke | **PASS** |
| dimensions_current (post) | 441 |
| products UPDATE | 0 |

### PC05D scale plan (`20260526T181000Z`) — partial execution

| Metric | Value |
|--------|------:|
| Remaining candidates | 17,805 |
| Wave 1 | 50 **done** |
| Wave 2 | 200 **done** |
| manual review | **17,555** |

## Other DML waves

PC03B map (+6), AFI ~1,795, claims V203–V207 — staging; original via PC07.

See [STAGING_ORIGINAL_PARITY.md](STAGING_ORIGINAL_PARITY.md) · [PACKAGING_DIMENSIONS_STATE.md](PACKAGING_DIMENSIONS_STATE.md).
