# Removal rebuild allocation fix (staging)

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Production / original | forbidden |
| Product create from title only | forbidden |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_REBUILD_ALLOCATION_FIX=true
```

## Scope

- Delete duplicate `detail_remainder` `expected_packages` rows (keep newest per `source_detail_row_id`)
- Rerun `rebuild_expected_packages_from_removals(org, store)` for Sam
- Re-run read-only verify (`removal-rebuild-verify-and-resolver-dryrun.ts`) — must show `rebuild_valid=yes`
- No raw import, no Amazon API, no `products.insert`, no `product_identifier_map.insert`

## Explicit exclusions

- No migration deploy in this execute pass (obsolete-cleanup hardening is follow-up)
- No resolver backfill until verify passes

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_REBUILD_ALLOCATION_FIX=true
Approved by: Maysam Ebrahimi
UTC date: 05272026
```
