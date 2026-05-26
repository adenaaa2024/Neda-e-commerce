# Product packaging backfill activate — PC05B operator approval

**Scope:** Promote `needs_review` packaging versions to `active` on **staging only** (`eiqfaapyumhixxoeltgu`).

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Pilot execute run | `pc05-product-packaging-backfill-staging-execute/20260523T215222Z/` |
| Allowed write | `UPDATE product_packaging_profile_versions.profile_status` → `active` only (trigger refreshes current) |
| Forbidden | `UPDATE products`, Amazon API, bulk activate without accepted list |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_PRODUCT_PACKAGING_BACKFILL_ACTIVATE=true
```

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_PRODUCT_PACKAGING_BACKFILL_ACTIVATE=true
Approved by: Main/user (PC05B pilot activate after PC05-EXECUTE 20260523T215222Z)
UTC date: 2026-05-23
Pilot execute run_id: 20260523T215222Z
```
