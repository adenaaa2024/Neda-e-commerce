# PostgREST column check (42703)

## Operator-mobile paths (in use)

| Select | Table | Result |
|--------|-------|--------|
| Item-scan list | `return_items` | **OK** — `id, fnsku, sku, product_identifier, conditions, expiration_date, batch_number, photo_evidence, created_at` |
| Package header | `packages` | **OK** |
| Slip lines | `slip_contents` | **OK** via 6-attempt fallback; **minimal** select (attempt 6) succeeds — `notes`, linkage columns absent on live DB |
| Identify gate | `expected_packages` | **OK** — `EP_SELECT`, `EP_DETAIL_SELECT` (no `asin`, no linkage extension) |

## Not on operator-mobile hot path

| Select | Result |
|--------|--------|
| `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT` | **42703** — `identifier_resolution_status` missing on `expected_packages` |
| `EP_TRACKING_WITH_SCANNER_PRODUCT_SELECT` | **42703** — same |
| First `slip_contents` attempt (full linkage + `notes`) | **42703** — `notes` missing; app retries automatically |

## Conclusion

**PASS** for operator-mobile smoke scope: no 42703 on selects the repaired flow actually executes after fallbacks.
