# Removal existing CSV rebuild (staging)

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Production / original | forbidden |
| Product create from title only | forbidden |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_EXISTING_CSV_REBUILD=true
```

## Scope

- **Preferred path:** `rebuild_expected_packages_from_removals(org, store)` only — domain tables already populated from legacy CSV.
- **Optional:** re-run Phase 2–4 on existing CSV uploads only if domain resync required (separate operator decision).
- No SP-API fetch required for this path.
- No `products.insert` during rebuild.

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_REMOVAL_EXISTING_CSV_REBUILD=true
Approved by: Maysam Ebrahimi
UTC date: 05272026
```
