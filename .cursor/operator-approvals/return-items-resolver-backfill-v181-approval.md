# Return Items Resolver Backfill — V181 Approval

Supabase project ref/name: eiqfaapyumhixxoeltgu
Environment: staging
Approved by: Maysam Ebrahimi
Approved at UTC: 2026-05-20T14:05:00.000Z

APPROVED_TO_RUN_RETURN_ITEMS_RESOLVER_BACKFILL_STAGING=true

## Scope

- Staging only (`eiqfaapyumhixxoeltgu`)
- Backfill `public.return_items.resolved_product_id` (+ resolver status columns) for **active** rows (`deleted_at IS NULL`)
- Deterministic tiers only: FNSKU → ASIN → SKU+org+store → UPC (`product_identifier_map.upc_code` when row carries UPC)
- Reuse `resolveScannerProductIdentifiers` / `pickBestProductIdentifierMatch` — no new fuzzy/title/OCR logic

## Explicit exclusions

- [ ] No production writes
- [ ] No product auto-create
- [ ] No `package_items` DDL or data
- [ ] No destructive migrations
- [ ] No Amazon API / AI
- [ ] No `v_inventory_item_status` DDL change unless separate view-extension approval

## Preconditions

| Item | Confirmed (Y/N) |
|------|-----------------|
| Charter probe reviewed: `.cursor/audit-reports/return-items-resolver-backfill-charter-v181/` | |
| V174 `product_identifier_map` materialization PASS on staging | |
| Dry-run preimage written | |
| Batch size / statement timeout plan accepted | |
| Neda read path still works via `fetchInventoryItemStatusForNeda` (with or without view extension) | |

## Signoff

```
Environment: STAGING ONLY
Status: APPROVED
Approved by: Maysam Ebrahimi
UTC date: 2026-05-20T14:05:00Z
Max rows per execute batch (default 500):
Run view extension after backfill: YES | NO | DEFER
Notes:
```
