# CLAIMS-RETURNS-FIRST-USABLE-STAGING-E2E — operator approval

**Target:** staging only (`eiqfaapyumhixxoeltgu`)  
**Org:** Sam Distribution `00000000-0000-0000-0000-000000000001`

## Approval flags

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_CLAIMS_RETURNS_FIRST_USABLE_STAGING_E2E=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

## Allowed writes (demo prep only)

| Table | Operation | Scope |
|-------|-----------|--------|
| `return_items` | UPDATE `notes`, `photo_evidence`, `resolved_product_id` | One physical row selected by script |
| `packages` | UPDATE `status` → `closed` | Package linked to that row |
| `claim_cases` / `claim_lines` | INSERT via manual draft action | One draft case |

## Forbidden

- No auto-promote enable
- No marketplace submit
- No bulk backfill execute
- No original DB (`kxsvedvpjldygtdbylsy`)

## Sign-off

```
Approved by: Maysam Ebrahimi
UTC date: 2026-06-01
```
