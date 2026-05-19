# Next-step recommendation

## Suggested next prompt: **NEXT-SCANNER-03**

**Title:** Wire extended PostgREST selects + operator review queue for product linkage

**Scope:**

1. After migration is applied to **staging**, switch:
   - `fetchExpectedPackageDetailRowsByIds` (and related snapshot loaders) to `EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT`.
   - Returns list reads that need linkage columns to `RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT`.
2. Add a compact “Product review” panel or row expansion on operator scan + returns item list when `product_review_required` or `product_match_status = mismatch`.
3. Add manual override fields (server action) writing `resolved_product_id` / `identifier_resolution_source = manual` without creating products.
4. If `products.requires_expiration_date` is added in a product-schema migration, gate expiration prompts off that flag per `expiration-ui-policy.md`.

**Inputs:** this run’s `manifest.json`, `schema-inventory.md`, `blockers.md`.

## Exact next prompt (copy)

```text
NEXT-SCANNER-03 — Wire EP_DETAIL_WITH_SCANNER_PRODUCT_SELECT + RETURN_LIST_WITH_SCANNER_PRODUCT_SELECT after staging migration apply; add operator UI for product_review_required and mismatch review; add manual override server action (no product create); add minimal tests for resolveProductForScannerItem ambiguity + mismatch policy. Reference .cursor/audit-reports/next-scanner-02/run-20260515-002/.
```
