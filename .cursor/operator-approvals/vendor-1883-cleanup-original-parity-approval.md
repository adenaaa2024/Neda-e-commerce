# Vendor 1883 cleanup — original parity approval

**Default:** not approved until plan review.

| Field | Value |
|-------|--------|
| Original ref | `kxsvedvpjldygtdbylsy` |
| Staging execute proof | `.cursor/audit-reports/vendor-1883-cleanup-staging-execute/20260528T150000Z/` |
| Deterministic plan | `.cursor/audit-reports/vendor-1883-cleanup-plan-review/20260528T120000Z/deterministic-update-plan.json` |
| Planned original updates | **454** |

```text
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_VENDOR_1883_CLEANUP_ORIGINAL_PARITY=false
```

## Allowed when approved

| Allowed | Forbidden |
|---------|-----------|
| Original `UPDATE products SET vendor_name = ...` for `original-update-plan.json` rows only | Staging writes |
| Guard `btrim(vendor_name) = '1883'` on each update | `product_identifier_map` |
| Rollback from execute audit | Packaging tables |
| | Product auto-create |
| | Amazon SP-API |

## Sign-off

```
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_VENDOR_1883_CLEANUP_ORIGINAL_PARITY=false
Approved by:
UTC date:
Plan run_id:
```
