# Product packaging backfill execute — PC05 operator approval

**Scope:** Insert accepted dry-run candidates into packaging tables on **staging only** (`eiqfaapyumhixxoeltgu`).

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Original / production | **forbidden** |
| Dry-run source | `.cursor/audit-reports/pc05-product-packaging-governed-backfill-dry-run/20260523T220000Z/` |
| Allowed write | `INSERT` into `product_packaging_profiles`, `product_packaging_profile_versions` only |
| Forbidden | `UPDATE products`, Amazon API, auto-activate to `active` without operator review |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_PRODUCT_PACKAGING_BACKFILL_EXECUTE=true
```

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_PRODUCT_PACKAGING_BACKFILL_EXECUTE=true
Approved by: Main/user (PC05-EXECUTE pilot after dry-run 20260523T220000Z)
UTC date: 2026-05-23
Accepted list: accepted-candidate-ids.txt (operator-filtered)
Dry-run run_id: 20260523T220000Z
```
