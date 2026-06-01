# Emergency Return Items Backfill Rollback Approval

**Default:** NOT approved until operator sets flags.

| Field | Value |
|-------|--------|
| Target ref | `eiqfaapyumhixxoeltgu` |
| Audit evidence | `.cursor/audit-reports/emergency-return-items-backfill-rollback-audit/20260521T233000Z/` |
| Rollback SQL | `.cursor/audit-reports/expected-linkage-return-items-backfill-scale-wave2/20260521T220500Z/rollback.sql` |
| Scope | Revert **5283** `return_items.resolved_product_id` (+ status/confidence) updates from wave2 only |

## Forbidden

- Delete `return_items` rows
- Delete or modify `expected_packages`
- Change `products` or `product_identifier_map`
- Touch original DB
- Claim writes

## Required operator flags

```text
APPROVED_EMERGENCY_RETURN_ITEMS_ROLLBACK=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
ROLLBACK_SCOPE=wave2_return_items_resolved_product_id_only
```

## Sign-off

```
Approved by: Main/user (EMERGENCY-RETURN-ITEMS-WAVE2-ROLLBACK-EXECUTE)
UTC date: 2026-05-21
Notes: Roll back wave2 EP→RI resolved_product_id denormalization on 5283 rows. Staging only.
```
