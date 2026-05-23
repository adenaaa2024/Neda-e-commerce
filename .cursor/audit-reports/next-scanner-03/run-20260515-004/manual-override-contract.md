# Manual override contract

## Entry point

`manualOverrideReturnItemProductResolution` in `app/scanner/operator-mobile/item-actions.ts` (`"use server"`).

## Preconditions

- `return_item_id` and `resolved_product_id` are valid UUIDs.
- Return row exists; `assertRowOrgAccess(actor_profile_id, organization_id)` passes.
- Return row has a `store_id` UUID (needed to scope catalog validation).
- Target `products.id` exists with the **same** `organization_id` and `store_id` as the return line.

## Forbidden (by design)

- No `INSERT` into `products` (no product creation).
- No merge / dedupe of product records.
- No Amazon or OpenAI calls.
- No changes to `expected_packages` in this action.

## Writes

Updates **only** `return_items`:

- `resolved_product_id` = chosen product
- `resolved_catalog_product_id` = `null` (manual path does not assert catalog bridge)
- `identifier_resolution_status` = `resolved`
- `identifier_resolution_confidence` = `null`
- `identifier_resolution_source` = `manual_override`
- `identifier_resolution_meta` = shallow merge with `{ manual_override: true, manual_override_at: <ISO> }`
- `product_match_status` = `match` | `mismatch` when `expected_product_id` is set; else `unknown`
- `product_review_required` = `true` when expected and resolved products **both** exist and differ; else `false` for unknown expected; `false` when they match
- `product_resolved_at` = now; `product_resolved_by` = `actor_profile_id` when it is a valid UUID

## Audit

Append-only row in `return_audit_log`:

- `action`: `updated`
- `field`: `scanner_product_manual_override`
- `old_value` / `new_value`: previous vs new `resolved_product_id` (string or null)
- `actor`: string from payload (`actor` prop) defaulting to `operator`
