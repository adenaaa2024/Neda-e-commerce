# Extended select E2E (NEXT-SCANNER-04)

## Environment gate

**Closed** — no operator approval file; no `SUPABASE_ENV` / `APP_ENV` dev|staging marker.

## Live select probes

| Constant | Table | Result |
|----------|-------|--------|
| `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT` | `expected_packages` | **Fail** — `identifier_resolution_status` missing |
| `EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT` | `expected_packages` | **Fail** — `identifier_resolution_status` missing (probe stops at first missing column; base `EP_SELECT` also references `asin`, which may be absent on this DB — see note) |
| `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT` | `return_items` | **Fail** — `expected_item_id` missing |

## Code wiring (static — pass)

Extended selects are wired in repo (NEXT-SCANNER-03):

- `lib/scanner/operator-tracking-expectations.ts` — `fetchExpectedPackageDetailRowsByIds`, tracking/pallet paths use `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT`; tracking snapshots use `EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT`.
- `app/returns/actions.ts` and `app/returns/_components.tsx` — list/detail reads use `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT`.

## Note on `EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT`

Base `EP_SELECT` includes `asin`. PostgREST error on the linked DB may surface `asin` before linkage columns if migration were partially applied. After migration apply, re-run probe; if `asin` is still missing on `expected_packages`, adjust `EP_SELECT` or add a migration column — out of scope for this run.

## E2E verdict

**Blocked** — cannot confirm extended selects against a migrated staging DB until SCANNER-02C applies migration and re-runs schema verification.
