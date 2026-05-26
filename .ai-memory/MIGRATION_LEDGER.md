# Migration ledger

**Last updated:** 2026-05-27 (`packaging-wave2-closeout` `20260527T200000Z`)

## Operator-applied — migration commit gap (PC06A)

| Artifact | Staging | Original | Notes |
|----------|---------|----------|-------|
| PC04 packaging DDL | yes | yes IN PARITY | commit gap |
| V193 product columns | yes | yes | commit gap |
| V205 package_code views | yes | yes | commit gap |

## DML — packaging

| Wave | Staging | Original | Rollback |
|------|---------|----------|----------|
| Pilot (191) | active/current | **PASS** PC05C `20260526T180000Z` | yes |
| Wave1 (50) | active/current | **PASS** PC05E `20260526T200000Z` | per execute |
| Wave2 (200) | active/current | **PASS** PC05F `20260526T211000Z` execute + `20260526T212000Z` verify | per execute |

### PC05C original execute (`20260526T180000Z`)

| Metric | Value |
|--------|------:|
| Profiles inserted | 191 |
| Versions inserted | 191 |
| dimensions_current | 191 |
| products UPDATE | 0 |

### PC05D Wave2 activate (`20260526T204000Z`)

| Metric | Value |
|--------|------:|
| Activated versions | 200 |
| dimensions_current before → after | 241 → **441** |
| products UPDATE | 0 |

### PC05F Wave2 original (`20260526T211000Z` / verify `20260526T212000Z`)

| Metric | Value |
|--------|------:|
| Profiles/versions (Wave2 cohort) | 200 |
| Verify matched | **200/200** |
| Original dimensions_current (verify) | **441** |
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
