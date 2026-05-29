# Claim / return line foundation — operator approval

**Default:** not approved.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Branch | `feature/product-canonicalization-v2` |

```text
APPROVED_TO_RUN_STAGING=false
APPROVED_CLAIM_RETURN_LINE_FOUNDATION=false
```

## Scope (when approved)

1. Apply additive `claim_lines` migration on staging
2. Read-only backfill dry-run from claim_candidates + return_items/EP joins
3. No production / original without separate approval

## Forbidden

- Product auto-create
- Bulk claim submit
- Amazon API in schema apply

## Sign-off

```
APPROVED_TO_RUN_STAGING=false
APPROVED_CLAIM_RETURN_LINE_FOUNDATION=false
Approved by:
UTC date:
```
