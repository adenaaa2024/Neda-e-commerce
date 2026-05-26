# PC02A — SP-API EVIDENCE-ONLY DRY-RUN EXECUTE

## Owner
Main/user

## Branch
`feature/product-canonicalization-v2`

## Mode
Agent, approval-gated, **evidence-only**

## Goal
Run a governed Amazon SP-API **catalog evidence** dry-run for the PC02 cohort: **5** `expected_packages` rows / **3** distinct ASINs (`api_evidence_needed` from V201/V202 preflight). Retrieve catalog title/image evidence only — **no** product or map writes.

## Current PC02 state (baseline)
- Staging ref: `eiqfaapyumhixxoeltgu`
- Sam org: `00000000-0000-0000-0000-000000000001`
- Sam store: `509ee1f6-622c-46a5-8110-7b889ba46c2c`
- SP-API credentials sufficient for Sam org; marketplace `ATVPDKIKX0DER` (US)
- Env: `AMAZON_SP_API_ENABLED=true` in `.env.local`
- **Do not** use V202 execute path that creates products unless explicit evidence-only mode is confirmed

## Approval file
`.cursor/operator-approvals/sp-api-product-evidence-dry-run-pc02-approval.md`

Required **exact** flags (if either false/missing/typo → **STOP**):

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_SP_API_EVIDENCE_DRY_RUN=true
```

## Cohort ASINs (default)
| ASIN | expected_packages rows |
|------|------------------------|
| `B0CQKPKKCM` | 1 |
| `B0CS88T6FR` | 3 |
| `B0DMQCZPQN` | 1 |

Load cohort from V202 dry-run when present:
`--dry-run-id=20260522T210000Z` → `expected-packages-amazon-api-evidence-dry-run-v202/<dry-run-id>/`

## Execute command

```bash
npx tsx scripts/pc02a-sp-api-evidence-only-dry-run-execute.ts --run-id=<UTC_Z>
npx tsx scripts/pc02a-sp-api-evidence-only-dry-run-execute.ts --run-id=<UTC_Z> --dry-run-id=20260522T210000Z
```

## Required behavior
1. Confirm branch is `feature/product-canonicalization-v2`.
2. Confirm staging only: `eiqfaapyumhixxoeltgu` — **not** `kxsvedvpjldygtdbylsy` (original/current).
3. Confirm product creation, map writes, and `expected_packages` updates are **disabled**.
4. Call Amazon SP-API **only** if approval + env gates are true.
5. Persist evidence to **filesystem artifacts only** (no DB evidence cache unless a dedicated table exists).
6. Do **not** mutate `products`, `product_identifier_map`, `expected_packages`, `return_items`, or `slip_contents`.

## Hard constraints
- Do **not** create products
- Do **not** insert `product_identifier_map`
- Do **not** update `expected_packages`
- Do **not** touch production or original Supabase projects
- Do **not** call AI/OpenAI
- Do **not** print secrets in audit output

## Output directory
`.cursor/audit-reports/pc02a-sp-api-evidence-only-dry-run-execute/<run_id>/`

### Required artifacts
| File | Purpose |
|------|---------|
| `approval-proof.md` | Branch, approval flags, staging ref |
| `candidate-cohort.md` | 5 rows / 3 ASINs with EP ids |
| `api-call-plan.md` | Planned catalog GETs |
| `evidence-results.json` | Per-ASIN HTTP + extracted fields |
| `no-write-proof.md` | Before/after counts — zero writes |
| `blockers.md` | Empty on success |
| `manifest.json` | Run summary |

### Additional artifacts (script may emit)
- `credential-proof.json` (no secrets)
- `marketplace-validation.md`
- `api-evidence-audit.ndjson`

## Report back
Return:
- Output directory path
- Approval valid: yes/no
- API calls made count
- Evidence found count (HTTP 200 with title)
- Product writes = **0**, map writes = **0**
- Status (`PASS`, `PASS_CATALOG_NOT_FOUND`, `PARTIAL`, `BLOCKED`)
- Exact next prompt

## Completed reference run
| Field | Value |
|-------|-------|
| Run id | `20260523T030000Z` |
| Status | `PASS_CATALOG_NOT_FOUND` |
| API calls | 3 |
| Catalog OK | 0 (all 404 in ATVPDKIKX0DER) |
| Writes | 0 |

**Next prompt after 404 cohort:**

```
PC02B — SP-API EVIDENCE POSITIVE-CONTROL EXECUTE

Run evidence-only catalog GET for 2 ASINs known in Sam seller products table (expect HTTP 200),
confirm lookup UI backend_evidence banner, and triage the 3 PC02A 404 cohort ASINs.
Do not create products or update expected_packages.
```

Then:

```
PC02C — EXPECTED-PACKAGES 404 COHORT MANUAL REVIEW QUEUE

Export the 5 PC02A expected_packages rows to operator CSV; recommend quarantine or ASIN correction.
No SP-API execute, no product create.
```

## On completion
Append history per `.cursor/prompts/CURSOR_PROMPT_GENERATE_HISTORY_V162.md` (product-canonicalization phase).
