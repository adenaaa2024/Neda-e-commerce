# SP-API state — evidence-only

**Staging ref:** `eiqfaapyumhixxoeltgu`  
**Approval:** `.cursor/operator-approvals/sp-api-product-evidence-dry-run-pc02-approval.md`

## Gates present

| Gate | Default / current |
|------|-------------------|
| `APPROVED_TO_RUN_STAGING` | **false** |
| `APPROVED_SP_API_EVIDENCE_DRY_RUN` | **false** |
| `AMAZON_SP_API_ENABLED` | must stay **false** until execute approved |
| `PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED` | **false** for evidence pass-1 |
| `PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED` | **true** (PC02 followup — audit/evidence path only) |

## Policy

| Rule | Detail |
|------|--------|
| Allowed (when approved) | Backend **catalog evidence** reads only — pass-1: **no product/map writes** |
| Browser SP-API | **Forbidden** |
| Product creation | **Forbidden** in evidence pass-1 — no `tryBackendEnrichment` INSERT path |
| Production / original HTTP | **Forbidden** for PC02 cohort |
| AI / OpenAI | **Forbidden** for product resolution |

## Env readiness

- Sam store LWA credentials: **PASS** on staging  
- Marketplace: **ATVPDKIKX0DER** (US) validated  
- PC02A dry-run execute: **PASS** — 5 EP rows / 3 ASINs; **0** writes  
- PC02B positive control: **2/2** catalog 200; cohort ASINs **404** in US seller context  
- PC02C: **5** rows manual ASIN correction queue  

## Cohort (governed HTTP — blocked until approval)

**5** expected_packages rows / **3** distinct ASINs — catalog 404 after PC02B triage.

## Evidence-only execute (extra)

`pc02-sp-api-evidence-execute` `20260524T220000Z` — `--from-products=2`; **0** products, **0** maps.

## Next

Set approval flags + env per approval file → re-run governed evidence execute. No uncontrolled product creation.

## Evidence

`pc02-sp-api-env-evidence-dry-run-plan/20260522T190000Z/` · `pc02a-sp-api-evidence-only-dry-run-execute/20260523T030000Z/` · `pc02b-sp-api-evidence-positive-control-execute/20260523T040000Z/` · `pc02c-expected-packages-404-cohort-manual-review-queue/20260523T050000Z/`
