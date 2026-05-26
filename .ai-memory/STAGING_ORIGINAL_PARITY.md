# Staging / original parity

**Last updated:** 2026-05-27 (`packaging-wave2-closeout` `20260527T200000Z`)

## Refs

| Role | Ref |
|------|-----|
| **Staging** | `eiqfaapyumhixxoeltgu` |
| **Original** | `kxsvedvpjldygtdbylsy` |
| **Future production** | `NOT_CREATED_YET` |

## Packaging data parity by cohort

| Cohort | Staging | Original | Status |
|--------|---------|----------|--------|
| Pilot (191) | active/current | 191/191/191 | **CONFIRMED** |
| Wave 1 (50) | active/current | 50/50 | **CONFIRMED** |
| Wave 2 (200) | active/current | 200/200 matched | **CONFIRMED** (PC05F `20260526T212000Z`) |

## Packaging `dimensions_current` alignment

| Ref | Total | Notes |
|-----|------:|-------|
| Staging | **441** | 191 + 50 + 200 governed waves |
| Original | **441** | PC05F verify: missing **0**, conflicts **0**, unsafe **0** |

Operator handoff sometimes cites **641** on original; governed verify census for Wave2 reports **441** (= same three-wave sum on both refs). Rows outside `PC05D_WAVE*` / pilot batch tags are out of scope for this parity proof.

## Schema parity

PC04 packaging tables — **IN PARITY** both refs.

## Other staging-only DML

Product spine, AFI, claims — see PC07 ledger; separate from packaging waves.

Detail: [PACKAGING_DIMENSIONS_STATE.md](PACKAGING_DIMENSIONS_STATE.md) · [MIGRATION_LEDGER.md](MIGRATION_LEDGER.md)
