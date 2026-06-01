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
| Inbox | `claim_candidates`, `claim_candidate_drafts` | Governed cleanup on staging |
| Lines | `claim_lines` | Staging applied |
| Cases/evidence | `claim_cases`, `claim_evidence` | Foundation on staging |

## Policy

| Rule | Status |
|------|--------|
| Product auto-create | **Forbidden** |
| Bulk RI from forecast | **Forbidden** |
| Submit / live filing | **Gated** |
| Original DB DDL | **Separate approval** |

## Production deploy gate

Merge with Neda requires QA gate + operator approval; preserve scanner UX + allocation/release rules.
