# Expected Packages E2 Product Promotion V194 Approval

**Default:** not approved. This approval is required before creating any `products` or `product_identifier_map` rows for E2.

| Field | Value |
|---|---|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Allowed writes | Governed `products` INSERT + matching `product_identifier_map` INSERT for approved E2 candidates only |
| Expected package update | forbidden |
| Production/original | forbidden |
| Product source | trusted imported AFI/FBA/manage-FBA identifiers only |
| Title/OCR/fuzzy create | forbidden |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_EXPECTED_PACKAGES_E2_PRODUCT_PROMOTION_V194=true
```
