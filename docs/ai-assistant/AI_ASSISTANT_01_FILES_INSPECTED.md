# NEXT-AI-ASSISTANT-01 — Files inspected / touched

**Touched:** Only files under `docs/ai-assistant/` (this deliverable set).  
**Inspected:** Representative paths from semantic search, glob, and ripgrep during scope mapping.

## API routes (AI / LLM / proxy)

- `app/api/v1/agent/ai/chat/completions/route.ts`
- `app/api/openai/packing-slip/route.ts`
- `app/api/settings/imports/classify-headers/route.ts`
- `app/api/settings/imports/reports-repo-header-ai/route.ts`
- `app/api/dashboard/products/catalog/enrich-images/route.ts` (references PIM AI helpers)

## Libraries (OpenAI / org / PIM)

- `lib/organization-openai-key.ts`
- `lib/openai-settings.ts`
- `lib/classify-import-headers-openai.ts`
- `lib/packing-slip-vision.ts`
- `lib/pim-price-candidate-ai.ts`
- `lib/pim-category-candidate-ai.ts`

## Settings / keys UI

- `app/settings/AgentApiKeysSection.tsx`
- `app/settings/RoleTagCombobox.tsx`
- `app/settings/organization-api-keys-actions.ts`

## Claim review / engine

- `app/claim-engine/review-ops/page.tsx`
- `app/claim-engine/review-ops/ClaimReviewOperationsClient.tsx` (partial / referenced)
- `lib/claim-review-workflow.ts` (referenced from review-ops page)

## TRID / claims scripts and audits (samples)

- `scripts/claim-trid-02-draft-extraction-dryrun.ts`
- `.cursor/audit-reports/next-claim-trid-03/20260516T003000Z/filing-payload-contract.md`
- `.cursor/audit-reports/next-claim-filing-agent-03/20260515T120000Z/worker-pickup-contract.md`
- `.cursor/audit-reports/next-continuous-claim-enrichment-02/20260515T211000Z-plan/diff-api-contract.md`

## Product identity / propagation

- `lib/audits/product-propagation-dryrun.ts` (referenced)
- `scripts/product-propagation-dry-run.ts` (referenced)
- `.cursor/audit-reports/next-product-21/20260515T070200Z/executive-summary.md`
- `docs/product-identity/sql/04_amazon_fba_inventory_resolver_verify.sql` (user workspace reference pattern)

## Backend Python (OpenAI key parity)

- `backend-python/main.py` (OpenAI key resolution section)

## Plans (context only)

- `.cursor/plans/product_seed_dry_run_plan_06dbbf82.plan.md`
- `.cursor/plans/next-18c_choose_next_source_04e7d2e8.plan.md`

---

This list is **not exhaustive** of every file mentioning “AI” or “OpenAI”; expand during NEXT-AI-ASSISTANT-02 when building the tool registry.
