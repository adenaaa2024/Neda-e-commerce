# Accepted Side Schema Phase 1 — Approval

**Default:** not approved. Required before wiring `return_items` expected linkage on staging or changing scanner receive writes.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Production / original | forbidden in this phase |
| New `accepted_packages` table | forbidden in phase 1 |
| Product auto-create on scan | forbidden |
| `package_items` | forbidden |

```text
APPROVED_TO_RUN_STAGING=false
APPROVED_ACCEPTED_SIDE_SCHEMA_PHASE1=false
```

## Scope if approved

- Wire `return_items.expected_item_id` → `expected_packages.id` on scanner receive
- Denormalize `return_items.expected_product_id` from EP `resolved_product_id` at receive time
- Keep `insertReturn` / resolver-on-save for `resolved_product_id`
- Optional: reconcile `actual_scanned_count` vs `return_items` count (read-only audit first)
- No new accepted table; no destructive DDL

## Preconditions

| Item | Confirmed (Y/N) |
|------|-----------------|
| Migration `20260717120000_scanner_product_linkage_columns` applied on staging | |
| Removal EP rebuild + resolver backfill current (or planned same sprint) | |
| Product resolution contract guard green | |

## Sign-off

```text
APPROVED_TO_RUN_STAGING=false
APPROVED_ACCEPTED_SIDE_SCHEMA_PHASE1=false
Approved by:
UTC date:
Max rows per receive batch (default 50): 50
Notes:
```
