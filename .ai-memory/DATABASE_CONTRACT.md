# Database contract — V176

Staging ref unless noted: `eiqfaapyumhixxoeltgu`.

## Active binding

App uses **only** the active quartet:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `DIRECT_POSTGRES_URL`

`STAGING_*` / `ORIGINAL_*` are operator aliases — they do not switch the app unless copied into the active quartet.

## Core tables

### Catalog (canonical)

| Table | Role |
|-------|------|
| `products` | Canonical `id`; ~17,001 on staging Sam |
| `product_identifier_map` | Resolver authority bridge |

### Warehouse

| Table | Role |
|-------|------|
| `return_items` | Returns/scanner lines — **use this** (6 test rows on staging) |
| `packages` | `package_code` (reconciled UI) |
| `pallets` | `pallet_photo_urls` |
| `slip_contents` | Slip lines — partial / 0% exact-match wave |

### Forbidden / absent

| Name | Rule |
|------|------|
| `package_items` | **Must not exist** |
| `returns` (legacy) | **Do not query** — use `return_items` |

### Claims

| Table | Notes |
|-------|-------|
| `claim_candidates` | `resolved_product_id` ~**72.7%** (post wave-2) |
| `claim_candidate_drafts` | ~**51.5%**; V176 orphan FK remediated |

### Amazon operational (partial — wave-2)

| Table | Notes |
|-------|-------|
| `amazon_returns` | Partial — wave-2 tier-4 |
| `amazon_manage_fba_inventory` | Partial |
| `amazon_amazon_fulfilled_inventory` | Large tier-4 wave |
| `amazon_settlements` | **No blind bulk** — policy skip |

### Imports

| Table | Notes |
|-------|-------|
| `raw_report_uploads` | Upload spine |
| Report tables | JSONB where needed; governed waves only |

## Resolver columns

On linkage-bearing rows: `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence`. Legacy `product_id` = mismatch guard only.

## Migrations

Staging first + operator approval. No destructive migrations without rollback. Production **blocked**.

## Evidence (pointers only)

| Topic | Audit path |
|-------|------------|
| Mapping matrix V174 | `product-id-mapping-materialization-v174/20260519T231000Z/staging-matrix.json` |
| Wave-2 execute | `product-id-mapping-wave-2-v176/20260520T132000Z/` |
| Claim resolver | `claim-candidate-resolver-project-v175/20260524T120000Z/` |
| V176 orphan FK | `claim-candidate-resolver-v176-fk-orphan-product-fix/20260523T211500Z/` |
