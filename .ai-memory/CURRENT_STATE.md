# Current state — V176 (authoritative)

**Last updated:** 2026-05-20 (`ai-shared-memory-update-v176` `20260520T140000Z`)  
**Canonical full history:** [HISTORY_POINTERS.md](HISTORY_POINTERS.md) →  
`.cursor/audit-reports/history-v175/20260604T120000Z/ERP_PIM_FULL_HISTORY_V175_APPEND_ONLY_CLAIM_RESOLVER_PREVIEW_STATUS.md`  
**Update rule:** change this file **only together with** a new append on that full history (paired-update law).

## Gates (summary)

| Gate | Status |
|------|--------|
| Build (`npm run build`) | **PASS** |
| Schema reconcile (V173+) | **PASS** |
| Schema-product combined smoke V175 | **PASS** (21/21) |
| Storage staging clone | **PASS** (144/144) |
| PIM store context (Sam AM) | **PASS** (~17,001 products) |
| NEDA 15 (product-id UI final) | **PASS** |
| Neda linkage contract (V169) | **PASS** |
| Preview env → staging ref | **PASS** |
| Preview operator signoff | **PASS** (`env-06c-preview-operator-close-v175/20260519T223000Z`) |
| Product mapping V174 probe | **PASS** |
| Product mapping wave-2 V176 | **PASS** (execute; see audit) |
| Production project | **NOT_CREATED_YET** / **BLOCKED** |
| Vercel Production DB | **UNTOUCHED** (original ref) |

## Database refs

| Role | Ref |
|------|-----|
| Original | `kxsvedvpjldygtdbylsy` |
| Staging / local / Preview | `eiqfaapyumhixxoeltgu` |
| Production | `NOT_CREATED_YET` |

## Resolver coverage (staging — latest audits)

| Table | Resolved | Total | % | Source |
|-------|----------|-------|---|--------|
| `claim_candidates` | 6,581 | 9,055 | **72.7%** | wave-2 `20260520T132000Z` |
| `claim_candidate_drafts` | 4,710 | 9,137 | **51.5%** | wave-2 `20260520T132000Z` |

Prior milestones: V175 **72.3%** / **27.3%**; V176 orphan FK execute **+2,179** drafts → **~51.2%** before wave-2 bump.

V175 **terminal** for tier-1–4 map path on candidates (0 eligible on dry-run `20260524T120000Z`).

## Catalog / mapping

- **`products` + `product_identifier_map`:** 100% spine.
- **Wave-2:** large gains on `amazon_amazon_fulfilled_inventory`, `amazon_returns`, `amazon_manage_fba_inventory` — see [PRODUCT_ID_MAPPING_STATUS.md](PRODUCT_ID_MAPPING_STATUS.md).
- **`return_items`:** 6 rows — **fake/test data**; not production truth.
- **`package_items`:** forbidden and **absent**.

## Schema

- App uses **`return_items`**; do not query `.from("returns")`.
- Packages/pallets: `package_code`, `pallet_photo_urls`.

## Preview

- Staging-backed Preview; operator steps 1–9 **PASS** (post-close HTTP **PASS**).
- Evidence: `.cursor/audit-reports/env-06c-preview-operator-close-v175/20260519T223000Z/`

## Recent completes

| Prompt | Run ID | Result |
|--------|--------|--------|
| ENV-06C preview close | `20260519T223000Z` | **PASS** |
| Claim resolver V176 orphan FK | `20260523T211500Z` | **PASS** execute |
| Product mapping wave-2 V176 | `20260520T132000Z` | **PASS** |
