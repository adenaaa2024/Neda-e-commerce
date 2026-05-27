# History pointers — authoritative

Do not paste full history into `.ai-memory`. Use modular memory + master file.

## Canonical master (append-only)

```
.cursor/history/ERP_PIM_FULL_APPEND_ONLY_HISTORY_MASTER.md
```

| Field | Value |
|-------|-------|
| Rebuild | `20260526T180000Z` |
| Latest append | `20260528T180000Z` — removal API + product resolution checkpoint |
| Living summary | Sections **1–17** at top |

## Modular memory — removal

| File | Topic |
|------|-------|
| [REMOVAL_API_INTAKE.md](REMOVAL_API_INTAKE.md) | Terminology, join, rebuild, SP-API plan |
| [PRODUCT_CANONICALIZATION.md](PRODUCT_CANONICALIZATION.md) | No product create on removal fetch/rebuild |
| [DATABASE_CONTRACT.md](DATABASE_CONTRACT.md) | `expected_packages` contract index |

## Removal evidence / scripts

| Area | Path |
|------|------|
| Rebuild migration | `supabase/migrations/20260631_expected_packages_derived_rebuild.sql` |
| API plan | `scripts/sp-api-removal-shipment-detail-api-plan.ts` |
| Fetch worker plan | `scripts/sp-api-removal-reports-fetch-worker-plan.ts` |
| Qty validation | `scripts/removal-quantity-allocation-validation.ts` |
| Approvals | `sp-api-removal-shipment-fetch-approval.md` |

## Packaging verify

`pc05-packaging-full-parity-verify/20260526T214000Z/` (441 on disk) · operator checkpoint **571**

## Paired-update law

Append-only history + `.ai-memory` updated together.
