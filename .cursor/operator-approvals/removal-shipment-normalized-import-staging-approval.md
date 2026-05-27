# Removal shipment normalized import (staging)

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Production / original | forbidden |
| Product create from title only | forbidden |

```text
APPROVED_TO_RUN_STAGING=false
APPROVED_REMOVAL_SHIPMENT_NORMALIZED_IMPORT=false
```

## Scope

- Phase 2 staging → Phase 3 sync for `REMOVAL_ORDER` and `REMOVAL_SHIPMENT` synthetic uploads
- Phase 4 generic (`removal_shipment_tree`) for shipment upload only
- `rebuild_expected_packages_from_removals(org, store)` after both domain tables updated
- No `products.insert` / no title-only promotion in import phase

## Preconditions

- Fetch execute produced `synthetic_upload_ready` uploads for **both** report types, OR operator designates alternate ready upload IDs in execute prompt.

## Sign-off

```
APPROVED_TO_RUN_STAGING=false
APPROVED_REMOVAL_SHIPMENT_NORMALIZED_IMPORT=false
Approved by:
UTC date:
```
