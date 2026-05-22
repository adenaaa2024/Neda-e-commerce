# Tasks — active board (V196 closeout; V202 proof carried)

Synced with [`.ai-memory/NEXT_ACTIONS.md`](.ai-memory/NEXT_ACTIONS.md).

## Done — V196/V197 closeout

- [x] V196 lookup item_name/UPC/ambiguous **PASS**
- [x] V196 expected API/manual plan **PASS**
- [x] V196 vendor 1883 plan **PASS**
- [x] V196 packaging model plan **PASS**
- [x] V197 table census **PASS**
- [x] History V196 + `.ai-memory` sync `20260522T230000Z`

## Done — after V196

- [x] V200 E1B materialize **PASS**
- [x] V202 browser proof **PASS**
- [x] V195 original parity, V194/V193/V192
- [x] MAIN V205 staging inventory `package_code` views **APPLIED_VERIFIED** (`20260522T173000Z`)
- [x] MAIN V206 original inventory `package_code` views **APPLIED_VERIFIED** (`20260522T180000Z`)
- [x] MAIN V206 browser proof package # search **PASS** (`20260522T180000Z`)

## Done — V202 API dry-run

- [x] Amazon API evidence dry-run **READY_FOR_EXECUTE_REVIEW** (`20260522T200000Z`)

## P1 — Claims / API / TRID / catalog

- [x] EXPECTED-PACKAGES-AMAZON-API-EVIDENCE-EXECUTE-V202 — **FAIL** (catalog 404; 0 inserts)
- [x] EXPECTED-PACKAGES-IDENTIFIER-MANUAL-REVIEW-BATCH-V202 — **PASS** (`20260522T220000Z`)
- [ ] EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-RECONCILE-PLAN-V202 — 6 rows
- [ ] Claims cleanup / regeneration (governed)
- [ ] API / TRID hardening
- [ ] Dirty identifier quarantine / source fix (38-row cluster)
- [ ] Vendor 1883 allowlist execute (governed)
- [ ] Packaging DDL V201 (approval-gated)

## P2 — Platform

- [ ] AI layer (later)

## P0 — Policy

- [ ] Staging quartet `eiqfaapyumhixxoeltgu`
- [ ] No `package_items`; no `.from("returns")`
- [ ] Future production — **blocked**

## Forbidden

[`.ai-memory/FORBIDDEN_ACTIONS.md`](.ai-memory/FORBIDDEN_ACTIONS.md)
