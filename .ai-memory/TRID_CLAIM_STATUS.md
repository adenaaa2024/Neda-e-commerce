# TRID & claim status — V176

## TRID read path

| Item | Status |
|------|--------|
| TRID validation V170 | **PASS** — `npm run verify:trid-v170-staging` |
| Claim TRID read V171 | **PASS** — `npm run verify:claim-trid-read-path-v171` |
| Combined smoke V175 | **PASS** |

Read/evidence/inbox UI operable on staging. Outbound filing/submit **gated**.

## Claim resolver coverage (staging)

| Table | Resolved | Total | % |
|-------|----------|-------|---|
| `claim_candidates` | 6,581 | 9,055 | **72.7%** |
| `claim_candidate_drafts` | 4,710 | 9,137 | **51.5%** |

Sources: wave-2 `20260520T132000Z` post-counts; V175 execute `20260523T200000Z`; V176 FK `20260523T211500Z`.

### V175 policy

- Tiers 1–4 via `product_identifier_map` + source row.
- Terminal dry-run `20260524T120000Z`: **0** tier-1–4 eligible — **do not** blind re-execute.

### V176 orphan FK (done)

- Orphan `amazon_removal_shipments.resolved_product_id` ∉ `products`: ~4,718
- Applied: **2,179** remaps (`claim-candidate-resolver-v176-fk-orphan-product-fix/20260523T211500Z`)

### Remaining candidate blockers (~2,474)

| Bucket | ~Count |
|--------|--------|
| `missing_source_row` | 1,543 |
| `unresolved_no_identifiers` | 667 |
| `blocked_pim` | 259 |
| `ambiguous` | 38 |

Evidence: `claim-candidate-resolver-project-v175/20260524T120000Z/blocker-inventory.json`

## Forbidden

- Claim submission without approval
- Product auto-create on resolver paths
- Production DB writes
- Blind V175 re-execute when eligible = 0

## Scripts

```bash
npm run verify:claim-candidate-resolver-v175-staging -- --candidates-only --run-id=<id>
npm run test:claim-candidate-resolver-v175
```

## Evidence folders

| Audit | Path |
|-------|------|
| V175 terminal | `claim-candidate-resolver-project-v175/20260524T120000Z/` |
| V175 execute | `claim-candidate-resolver-project-v175/20260523T200000Z/` |
| V176 FK | `claim-candidate-resolver-v176-fk-orphan-product-fix/20260523T211500Z/` |
| Wave-2 claim bump | `product-id-mapping-wave-2-v176/20260520T132000Z/` |
