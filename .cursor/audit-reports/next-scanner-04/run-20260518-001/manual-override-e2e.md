# Manual override E2E (NEXT-SCANNER-04)

## Result

**Not executed** (blocked).

## Reasons

1. **SCANNER-02C gate** — operator approval / dev-staging env marker absent (same as 02C `run-20260518-001`).
2. **Migration not applied** — `manualOverrideReturnItemProductResolution` PATCHes linkage columns that do not exist on the linked DB; would fail with PostgREST `42703`.
3. **Prompt constraint** — do not run staging write tests until 02C passes.

## Contract review (static — pass)

`manualOverrideReturnItemProductResolution` in `app/scanner/operator-mobile/item-actions.ts`:

- Validates UUIDs for return item and product.
- Loads `return_items` row; `assertRowOrgAccess` for actor.
- Verifies `products.id` with matching `organization_id` + `store_id` (rejects cross-store product).
- Does **not** insert or merge products.
- Sets `identifier_resolution_source: "manual_override"`, `product_match_status` match/mismatch/unknown, `product_review_required` when expected ≠ resolved.
- Inserts `return_audit_log` with `field: "scanner_product_manual_override"`.

## UI path (static)

`app/returns/_components.tsx` — `handleScannerManualOverride` calls the server action and refreshes via `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT`.

## Planned test (post-gate)

```bash
npx tsx scripts/next-scanner-04-staging-e2e.ts --write-test
```

Script applies override on one row, verifies audit log, restores prior `resolved_product_id`, confirms `products` count unchanged.
