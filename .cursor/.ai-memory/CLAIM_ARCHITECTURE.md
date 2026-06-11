# Claim architecture

**Last updated:** 2026-06-17 (`phase1-demo-ready-history-memory-sync` `20260617T120000Z`)  
**State:** [CLAIMS_TRID_STATE.md](CLAIMS_TRID_STATE.md) · [PHASE1_DEMO_READY.md](PHASE1_DEMO_READY.md) · [SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md](SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md)

## Returns-first policy (staging — configured)

| Item | Status |
|------|--------|
| Returns-first logic | **Built** |
| Policy config | **CONFIGURED** on staging |
| Returns lane (`return_item` grain) | **Enabled** per policy — draft E2E pending |
| **`expected_group` grain** | **BLOCKED** for returns-first queue |
| **`import_source` grain** | **BLOCKED** for returns-first queue |
| Draft E2E | **BLOCKED** — closed package + evidence/note |
| `CLAIM_SCANNER_AUTO_PROMOTE_ENABLED` | **off** |

**SUPERSEDES:** queue "UNSAFE until physical-anchor gate" as sole blocker — policy now configured; draft E2E + grain blocks remain.

Claims from scanner require proven physical `return_items`, issue/evidence/note, and returns policy gates.

## Claim line grain (locked)

| Lane | Grain | Returns-first queue |
|------|-------|---------------------|
| Scanner/receive | **1 claim_line ↔ 1 return_items** | **Allowed** (when E2E gates pass) |
| Expected short/overage | **group-grain** on root EP | **BLOCKED** |
| Import | **import-grain** | **BLOCKED** |

## Layers

| Layer | Objects | Status |
|-------|---------|--------|
| **Pool (truth)** | `claim_candidates` | Discovery Engine writes only; `legacy_seed` quarantined |
| Inbox projection | `claim-artifact-projection-core` → `inbox_queue` | Read-only routing; not persisted |
| Drafts (retire) | `claim_candidate_drafts` | Parallel legacy; read-only in Claim Center V1 |
| TRID spine | `claim_reference_edges` (+ FRR) | `candidate_id` anchor (Phase 7H) |
| Lines | `claim_lines` | Staging applied |
| Cases/evidence | `claim_cases`, `claim_evidence` | Foundation on staging |
| Submission | `claim_submissions` | Legacy `return_id` 1:1 — event bridge pending |

## Claim Center V1 (2026-06-11 — read model after ORBIT-FRA)

**Evidence:** `.cursor/audit-reports/phase-claim-center-v1-read-model-after-orbit-fra/20260611T080000Z/`

| # | Section | Primary source |
|---|---------|----------------|
| 1 | Opportunities | discovery eligibility + high recovery scan |
| 2 | Candidates | `claim_candidates` + `v1_status_group` |
| 3 | Needs Review | projection queues + review work items |
| 4 | Evidence Packets | Phase 7G composer (HTML preview) |
| 5 | TRID / Reference Graph | `claim_reference_edges` |
| 6 | Product Linkage Status | pool + `linkage-health` |
| 7 | Cases | `claim_cases` |
| 8 | Submission Queue | `claim_submissions` + `claim_history_logs` |
| 9 | Recovery | candidates ⋈ edges ⋈ FRR |
| 10 | Source Runs | `discovery_index` + automation audit |

**ORBIT in UI:** `source_kind=orbit_fra`; external case status display-only; canonical windows from settings.

**New tables/views:** NO · **UX:** 12-section standalone `/claim-center` (see product UX blueprint `20260611T090000Z`) · **Next:** `PHASE-CLAIM-CENTER-V1-UI-SHELL-READONLY`

## ORBIT-FRA (2026-06-11 — integration audit)

| Item | Status |
|------|--------|
| Live generator | `lib/claims/intake/claim-orbit-fra-generator.ts` — 18 categories, `source_kind=orbit_fra` |
| Pool columns | Migration `20260915120000_phase7b2` — reference_id, recovery_value, dispute window |
| Spreadsheet import | **Planned** — hybrid staged via `raw_report_uploads`; **not** `claim_candidate_drafts` |
| TRID | Reuse `claim_reference_edges` + FRR; ambiguity preserved |
| Product link | `product_identifier_map` resolver — no title match, no auto-create |
| Import apply on staging | **BLOCKED** — settings + dry-run parser first |

Evidence: `.cursor/audit-reports/phase-orbit-fra-claim-trid-integration/20260611T070000Z/` · **Next:** `PHASE-ORBIT-FRA-SPREADSHEET-IMPORT-DRY-RUN`

## Policy

| Rule | Status |
|------|--------|
| Product auto-create | **Forbidden** |
| Bulk RI from forecast | **Forbidden** |
| Submit / live filing | **Gated** |
| Original DB DDL | **Separate approval** |

## Production deploy gate

Merge with Neda requires QA gate + operator approval; preserve scanner UX + allocation/release rules.
