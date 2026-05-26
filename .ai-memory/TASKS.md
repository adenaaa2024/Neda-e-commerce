# Tasks — PC Phase 01 closeout board

Synced with [NEXT_ACTIONS.md](NEXT_ACTIONS.md) and root [`../TASKS.md`](../TASKS.md).

**Branch:** `feature/product-canonicalization-v2`

## Done — PC Phase 01

- [x] PC01 baseline census **PASS**
- [x] PC02 SP-API plan + expected wave **PASS**
- [x] PC02A/B/C evidence + 404 queue **PASS**
- [x] PC03B map + dirty quarantine plan **PASS**
- [x] PC04 schema plan **PASS** (plan-gate approval false)
- [x] PC04A/B packaging DDL **APPLIED**
- [x] PC05 claim census **PASS**
- [x] PC05C packaging backfill scale **APPLIED** (191 staging)
- [x] PC06 parity ledger **PASS**
- [x] History + memory sync `20260526T120000Z`

## P1 — Next

- [ ] PC06A commit operator DDL to migrations
- [ ] PC07 original spine DML parity plan
- [ ] PC03-EXEC dirty-source fix (21 rows; approval)
- [ ] PC02C 404 operator follow-through (5 rows)
- [ ] Claim Wave B source orphan cleanup

## P0 — Policy

- [ ] Branch `feature/product-canonicalization-v2` only
- [ ] Staging `eiqfaapyumhixxoeltgu`
- [ ] No `package_items`; no `.from("returns")`
- [ ] No Amazon API until PC02 approval
- [ ] Future production — **blocked**

## Forbidden

[`FORBIDDEN_ACTIONS.md`](FORBIDDEN_ACTIONS.md)
