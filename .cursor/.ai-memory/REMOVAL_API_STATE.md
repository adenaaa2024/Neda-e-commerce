# Removal API state

**Main:** `4402064` · **Stash land:** `feature/phase1-latest-stash-land` @ `c78fbb8`  
**Staging:** `eiqfaapyumhixxoeltgu` · **Original:** `kxsvedvpjldygtdbylsy`  
**Last updated:** 2026-06-11 (`phase1-roadmap-and-history-memory-update` `20260611T120000Z`)

Architecture: [REMOVAL_API_INTAKE.md](REMOVAL_API_INTAKE.md)

## Rebuild allocation verify — FIXED (CORRECTED)

| Check | Status |
|-------|--------|
| Non-overflow mismatch | **0** (**SUPERSEDED** prior 1 mismatch / PARTIAL burn-in) |
| Duplicate EP groups | **0** |
| Cron apply | **off** |

## Automation policy

| Rule | Status |
|------|--------|
| Rolling 7-day window | incremental sync only — **not** historical backfill |
| Superadmin scheduler UI | **planned only** — not implemented |
| Product update job controls | **not implemented** — not refresh-safe |

## Historical fetch (Nov–Dec dryrun)

Nov 1–7 **DONE** · Nov 8–Dec 21 **FATAL** · Dec 22–25 **QuotaExceeded** — resume when approved.

## Staging EP (baseline)

~**6,175** derived EP; refresh counts after next fetch/resolver wave.

## Original

Data wave **PASS** — **9,377 / 11,790** resolved; **2,413** unresolved.

## Next

**REMOVAL-NOV-DEC-SPLIT-WINDOW-FETCH-RESUME** · **CRON-APPLY-ENABLE** (gated)
