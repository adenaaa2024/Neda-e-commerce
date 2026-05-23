# Expected vs scanned product policy

## On `return_items` save

1. Persist raw receive data (`insertReturn` core insert) — unchanged error semantics for business validation (e.g. missing expected row still fails before insert as today).
2. Enrichment runs **after** insert:
   - Expected product is read from `expected_packages.expected_product_id` / `resolved_product_id` (resolved wins when both set in resolver pre-check; denormalized copy stored on `return_items.expected_product_id`).
   - Scanner resolution fills `return_items.resolved_product_id` from identifier bridge / direct SKU rules.
3. If both expected and resolved product IDs exist and differ → `product_match_status = 'mismatch'`, `product_review_required = true`. The expectation row in `expected_packages` is **not** overwritten.
4. If both exist and match → `product_match_status = 'match'`.
5. Unresolved / ambiguous resolver outcomes do **not** fail the save; they set status fields and `product_review_required` as appropriate.

## No silent mismatch overwrite

Resolver never writes back to `expected_packages` in this pass; mismatch is recorded only on `return_items`.
