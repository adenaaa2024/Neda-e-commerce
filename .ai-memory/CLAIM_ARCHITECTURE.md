# Claim architecture

**Last updated:** 2026-06-06 (append)  
**State:** [CLAIMS_TRID_STATE.md](CLAIMS_TRID_STATE.md) · [CLAIMS_ENGINE_STATE.md](CLAIMS_ENGINE_STATE.md)

## Layers

| Layer | Objects | Status |
|-------|---------|--------|
| Inbox | `claim_candidates`, `claim_candidate_drafts` | Partial FK coverage; governed cleanup V203–V207 on staging |
| Lines (drafted) | `claim_lines` | Migration drafted; dry-run **PASS**; **not applied** |
| Cases/evidence (drafted) | `claim_case_*` / evidence tables | `20260901120000_claim_case_evidence_foundation.sql` — approval **false** |
| TRID (drafted) | TRID foundation | After `claim_lines` |

## Claim line grain (locked)

| Lane | Grain |
|------|-------|
| Scanner/receive | **1 claim_line ↔ 1 return_items** |
| Expected short/overage | **group-grain** on root EP |
| Import | **import-grain** until TRID grouping |

## Policy

| Rule | Status |
|------|--------|
| Resolver execute / repoint | **Dry-run only** without approval |
| Destructive cleanup | Governed waves only |
| Submit / live filing | **Gated** — agent flags off on Production |
| Product auto-create | **Forbidden** |

## PC05 census (reference)

51.8% valid product FK · 0.4% execute ready · ~7,190 missing_product · ~1,543 missing_source_row

## Approvals

- `claim-return-line-foundation-schema-approval.md`  
- `claim-case-evidence-foundation-schema-approval.md` — prerequisite: `claim_lines` on staging

## Production deploy gate (append)

`main-release-production-deploy-approval.md` — merge to `main` **APPROVED** 2026-05-29; requires `CLAIM_AGENT_*` disabled on Production; **not** live claim filing.
