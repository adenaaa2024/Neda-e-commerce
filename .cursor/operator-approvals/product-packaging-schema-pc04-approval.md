# Product packaging schema — PC04 operator approval

**Scope:** DDL on **staging only** (`eiqfaapyumhixxoeltgu`) for versioned product packaging / dimensions tables.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Original / current (`kxsvedvpjldygtdbylsy`) | **forbidden in this approval** — separate parity pack after staging proof |
| Future production | **forbidden** |
| Allowed write | `CREATE TYPE`, `CREATE TABLE`, indexes, triggers, RLS policies for packaging tables only |
| Data backfill | **forbidden** in same approval — separate governed backfill prompt |
| `package_items` | forbidden |
| Legacy `returns` | forbidden |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_PRODUCT_PACKAGING_SCHEMA_DDL=true
```

## Tables in scope

- `product_packaging_profiles`
- `product_packaging_profile_versions`
- `product_packaging_dimensions_current`
- `product_packaging_evidence` (optional evidence/source rows)

## Preconditions

- [ ] Review `.cursor/audit-reports/pc04-product-packaging-dimensions-schema-plan/<run_id>/`
- [ ] PC01 product canonicalization baseline complete (product_id spine stable enough for FK)
- [ ] Confirm enum values: `packaging_level`, `fulfillment_context`, `source_type`
- [ ] Confirm RLS matches org-scoped pattern used on `claim_candidate_drafts`
- [ ] No migration apply until both flags set `true` below

## Sign-off

APPROVED_TO_RUN_STAGING=true
APPROVED_PRODUCT_PACKAGING_SCHEMA_DDL=true
Approved by: Maysam Ebrahimi
UTC date:
```
