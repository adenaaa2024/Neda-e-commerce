# Claim / return line backfill — operator approval

**Default:** not approved until backfill dry-run review.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Branch | `feature/product-canonicalization-v2` |
| Prerequisite | `claim-return-line-foundation-schema-apply` PASS |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_CLAIM_RETURN_LINE_BACKFILL=true
```

## Scope (when approved)

1. Governed INSERT into `public.claim_lines` on staging only
2. Lanes: removal/return-ish candidates, return_items with expected_item_id, inventory short/overage groups
3. No product auto-create, no bulk claim submit, no Amazon API

## Forbidden

- TRID migration / TRID backfill
- Original / production writes without separate approval

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_CLAIM_RETURN_LINE_BACKFILL=true
Approved by: Maysam Ebrahimi
UTC date: 05282026
Backfill dry-run run_id:
```
