# Claims engine state

**Staging ref:** `eiqfaapyumhixxoeltgu`  
**Census:** `pc05-claim-engine-readiness-census/20260525T180000Z/`

## Policy (current)

| Rule | Status |
|------|--------|
| Resolver materialize / repoint | **Dry-run only** on staging proofs; **no live repoint** without approval |
| Destructive claim cleanup | **Not approved** — governed waves only (V203–V207 pattern on staging) |
| Claim submit / filing | **Gated** — TRID read PASS; outbound blocked |
| Product auto-create from claims | **Forbidden** |

## PC05 census (18,192 rows: candidates + drafts)

| Metric | Value |
|--------|-------|
| Valid product FK readiness | **51.8%** |
| Execute readiness (unresolved bucket) | **0.4%** |
| `missing_product` | ~7,190 |
| `missing_source_row` | ~1,543 |
| `needs_packaging_dimensions` | 2,574 |
| `needs_sp_api_reimbursement_evidence` | 6,562 |
| Orphan FK (post V203) | **0** on staging census |

## Legacy coverage (V177 reference)

| Table | Resolved % | Unresolved |
|-------|------------|------------|
| `claim_candidates` | **72.7%** | 2,474 |
| `claim_candidate_drafts` | **51.5%** | 4,427 |

Use PC05 buckets for execute planning; legacy % for inbox display context.

## Staging cleanup waves (done)

| Wave | Pack era |
|------|----------|
| V203 orphan FK remediation | staging execute PASS |
| V204 missing source cleanup | staging PASS |
| V205 claim resolver materialize | staging PASS |
| V206 removal shipments RPID | staging PASS |
| V207 claim source resolved pass2 | staging PASS |

**Next:** original parity replay + **CLAIM-CLEANUP-WAVE-B-SOURCE-ORPHAN-RPID-V191** per PC05.

## UI (V178)

Unresolved / ambiguous → safe labels via `ProductLinkageDisplayContract` — no title/OCR inference.

## Evidence

`pc05-claim-engine-readiness-census/20260525T180000Z/` · `claim-upstream-blockers-v177/` · [TRID_CLAIM_STATUS.md](TRID_CLAIM_STATUS.md) (V178 summary)
