# Bulk Orphan Return Items — Staging Remediation Approval

**Default:** not approved until operator sets flags below.

| Field | Value |
|---|---|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Target | Soft-delete **5,333** bulk orphan `return_items` (canonical predicate) |
| Preserve | 3 `package_id` physical scan rows; all `expected_packages`; `products`; `product_identifier_map` |
| Production/original | forbidden |
| Hard delete | forbidden |
| Expected_packages mutation | forbidden |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_BULK_ORPHAN_RETURN_ITEMS_STAGING_REMEDIATION=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

## Signoff

```
Environment: STAGING ONLY (eiqfaapyumhixxoeltgu)
Status: APPROVED
Approved by: Maysam Ebrahimi
UTC date: 2026-05-30T120000Z
Rows to soft-delete: 5333
Method: deleted_at only (no deletion_reason column on return_items)
```
