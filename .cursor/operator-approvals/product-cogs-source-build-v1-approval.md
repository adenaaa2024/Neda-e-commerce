# Product COGS source build V1 — operator approval

**Phase:** PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-BUILD-V1

## Approval keys (set exactly one line each to `yes` or `no`)

APPROVED_PRODUCT_COGS_SOURCE_BUILD_V1=no
APPROVED_PRODUCT_COGS_SCHEMA_MIGRATION_V1=no
APPROVED_PRODUCT_COGS_WRITE_V1=yes

## Scope

- Pilot FNSKUs only (6 unique products across 10 submissions)
- Interim writes: `workspace_settings.module_configs.claim_intake.cogs_overrides`
- Preferred spine after migration: `product_cost_snapshots`

## Hard stops

- Never use sale price, list price, or settlement net as COGS
- No claim_candidates / claim_cases / claim_lines / claim_submissions mutation
- No Amazon API calls
