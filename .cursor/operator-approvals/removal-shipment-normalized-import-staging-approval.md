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

- Run existing REMOVAL_ORDER / REMOVAL_SHIPMENT sync + `rebuild_expected_packages_from_removals`
- Map-only / governed product promotion only (no title-only create)

## Sign-off

```
APPROVED_TO_RUN_STAGING=false
APPROVED_REMOVAL_SHIPMENT_NORMALIZED_IMPORT=false
Approved by:
UTC date:
```
