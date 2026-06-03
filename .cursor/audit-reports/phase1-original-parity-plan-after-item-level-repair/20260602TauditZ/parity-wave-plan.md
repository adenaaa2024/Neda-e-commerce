# Phase 1 parity wave plan (post item-level repair)

## Wave A — schema / functions / views

Apply on original only, in order:

1. `20260827160000_expected_packages_tracking_group_allocation.sql` — tracking normalization + grouped rebuild
2. `20260828120000_removal_carrier_normalization_views.sql` — carrier normalization + inventory views
3. `20260829120000_expected_receive_split.sql` — receive split columns + `receive_expected_item_with_split`
4. `20260830120000_expected_receive_split_item_level.sql` — `expected_item_id` + allocate/release/move RPCs

Verify Wave A prior work still true:
- `20260820120000_expected_packages_resolver_columns.sql` (Wave A prior execute)
- `rebuild_removal_item_allocations` present

**Gate:** all PHASE1 functions exist on original; views match staging fingerprint; qty-only receive blocked.

## Wave B — product / PIM resolver parity

Governed replays (dry-run first): E1 map bridge, E2 promotion, E1B materialize, PC03B disagreement.
Re-verify spreadsheet packaging: `spreadsheet-packaging-full-parity-verify.ts`.

**Gate:** resolver can match EP SKUs on original without blind product create.

## Wave C — removal domain + expected rebuild

1. SP-API removal fetch on original
2. Domain sync / tracking normalization backfill on shipment rows if needed
3. `rebuild_expected_packages_from_removals` + duplicate remainder cleanup pattern
4. Verify `rebuild_valid=yes` on original
5. Resolver backfill on derived EP

**Gate:** derived EP + allocation_group_key populated; resolver coverage > 0.

## Wave D — scanner smoke on original

1. Vercel production deploy (scanner code + item-actions RPC wiring)
2. Item-level receive smoke (qty=3 → 3 return_items + conservation)
3. Neda tracking compare smoke

**Gate:** end-to-end scan/receive on original DB.
