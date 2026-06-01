# Vendor 1883 Maison Routin cleanup — staging operator approval

**Scope:** Staging `products.vendor_name` UPDATE — bare `1883` → `1883 Maison Routin` (pilot 55 + remaining 121).

**Default:** not approved.

| Field | Value |
|-------|--------|
| Readonly audit | `.cursor/audit-reports/product-vendor-1883-maison-routin-cleanup-readonly/20260521T120000Z/` |
| Max rows | **55 pilot + 121 remaining** |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_VENDOR_1883_MAISON_ROUTIN_CLEANUP=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

## Allowed when approved

| Allowed | Forbidden |
|---------|-----------|
| Staging `UPDATE products SET vendor_name = '1883 Maison Routin'` where `btrim(vendor_name) = '1883'` | Original/current DB |
| Preimage + rollback JSON/SQL | Product create |
| Max 55 pilot batch | Brand bulk overwrite |
| | `product_identifier_map` changes |
| | Resolver / packaging writes |

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_VENDOR_1883_MAISON_ROUTIN_CLEANUP=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
Approved by: operator
UTC date: 20260521
```
