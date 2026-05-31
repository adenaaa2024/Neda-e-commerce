# Claim architecture

**Last updated:** 2026-05-31 (`architecture-correction-history-memory-update` `20260531T120000Z`)  
**State:** [CLAIMS_TRID_STATE.md](CLAIMS_TRID_STATE.md) · [CLAIMS_ENGINE_STATE.md](CLAIMS_ENGINE_STATE.md) · [SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md](SCANNER_RETURNS_CLAIMS_ARCHITECTURE.md)

## CORRECTED — scanner claims safety

| Item | Status |
|------|--------|
| Returns claims work queue | **UNSAFE** until physical-anchor gate (`package_id IS NOT NULL`) patched |
| `CLAIM_SCANNER_AUTO_PROMOTE_ENABLED` | **off** |
| Staging `claim_lines` `return_item` grain | **0** |
| Merge / deploy / original apply | **NO** until orphan RI remediation + gate complete |

Claims must be created only from scanner issue/evidence/operator note **after** cutoff and module-scope gates, on **proven physical** `return_items` rows.

## Layers

| Layer | Objects | Status |
|-------|---------|--------|
| Inbox | `claim_candidates`, `claim_candidate_drafts` | Partial FK coverage; governed cleanup V203–V207 on staging |
| Lines | `claim_lines` | Applied on staging — `import_source` 9055, `expected_group` 4935, `return_item` 0 |
| Cases/evidence | `claim_cases`, `claim_evidence` | Foundation on staging per branch migrations |
| TRID (drafted) | TRID foundation | After `claim_lines` stable |

## Claim line grain (locked)

| Lane | Grain |
|------|-------|
| Scanner/receive | **1 claim_line ↔ 1 return_items** (physical anchor required) |
| Expected short/overage | **group-grain** on root EP |
| Import | **import-grain** until TRID grouping |

Queue excludes `import_source` and `expected_group` grains — but must also exclude orphan RIs without `package_id`.

## Policy

| Rule | Status |
|------|--------|
| Resolver execute / repoint | **Dry-run only** without approval |
| Destructive cleanup | Governed waves only |
| Submit / live filing | **Gated** — agent flags off on Production |
| Product auto-create | **Forbidden** |
| Bulk RI from forecast | **Forbidden** |

## Approvals

- `claim-return-line-foundation-schema-approval.md`  
- `claim-case-evidence-foundation-schema-approval.md`

## Production deploy gate

Merge to `main` requires `CLAIM_AGENT_*` disabled; **not** live claim filing; **not** safe until physical-anchor gate + orphan cleanup.
