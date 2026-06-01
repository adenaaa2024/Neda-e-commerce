# Claims & TRID state — phase1 delivery

**Main:** `4402064` · **Stash land:** `feature/phase1-latest-stash-land` @ `999f765`  
**Last updated:** 2026-06-16 (`phase1-pre-neda-merge-history-memory-sync` `20260616T120000Z`)

Related: [CLAIMS_ENGINE_STATE.md](CLAIMS_ENGINE_STATE.md) · [TRID_CLAIM_STATUS.md](TRID_CLAIM_STATUS.md) · [CLAIM_ARCHITECTURE.md](CLAIM_ARCHITECTURE.md)

## Claims returns-first (CORRECTED 2026-06-16)

| Item | Status |
|------|--------|
| Policy direction | **returns-first** |
| Logic | **Built** |
| Staging policy config | **CONFIGURED** — `enabled_claim_domains.returns`, `scan_go_live_date`, `claim_start_date`, claim window, evidence/hold policy |
| **`expected_group` grain** | **BLOCKED** for returns-first queue |
| **`import_source` grain** | **BLOCKED** for returns-first queue |
| Draft E2E | **BLOCKED** — closed package + evidence/note |
| Auto-promote | **off** |
| Manual grouping UI | Per policy; validate in draft E2E |

**SUPERSEDES (2026-06-12):** cutoff dates "unconfigured" — now **configured on staging**; draft E2E remains gate.

## Returns config keys (staging — locked)

- `enabled_claim_domains.returns`
- `scan_go_live_date`
- `claim_start_date`
- claim window
- evidence / hold policy

## Next (returns-first — ordered)

1. **CLAIMS-RETURNS-FIRST-DRAFT-E2E-CLOSED-PACKAGE-EVIDENCE** — prove draft path with closed package + evidence/note  
2. **PHASE1-FINAL-QA-GATE-BEFORE-NEDA-MERGE** — include claims E2E in QA checklist  
3. Original schema parity (explicit approval only)

## Delivery status summary

| Track | Dry-run | Applied | Next |
|-------|---------|---------|------|
| Claim lines schema | **PASS** | **NO** | Schema apply staging |
| Claim lines backfill | **PASS** | **NO** | After schema apply |
| TRID foundation | **PASS_WITH_BLOCKERS** | **NO** | After `claim_lines` |
| Returns-first policy | **CONFIGURED** (staging) | staging | Draft E2E |

## Claim line grain (locked)

| Lane | Grain |
|------|-------|
| Scanner / receive | **1 claim_line ↔ 1 return_items** |
| Expected short/overage | **group-grain** on root EP |
| Import candidates | **import-grain** until TRID grouping |

## Priority (June 2026 — append)

Aligns with [ROADMAP.md](ROADMAP.md): Phase1 QA gate → Claims draft E2E → TRID

**Next prompt:** `CLAIMS-RETURNS-FIRST-DRAFT-E2E-CLOSED-PACKAGE-EVIDENCE`
