# Claim / return line foundation schema — operator approval

**Default:** not approved until plan + dry-run review.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Branch | `feature/product-canonicalization-v2` |
| Prerequisite plan | `claim-return-line-foundation-plan` |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_CLAIM_RETURN_LINE_FOUNDATION_SCHEMA=true
```

## Scope (when approved)

1. Apply `supabase/migrations/20260831120000_claim_lines_foundation.sql` on staging only
2. Governed backfill execute (separate approval)
3. No production / original without separate approval

## Forbidden

- Product auto-create during schema apply
- Bulk claim submit
- Amazon API

## Sign-off

```
APPROVED_TO_RUN_STAGING=true
APPROVED_CLAIM_RETURN_LINE_FOUNDATION_SCHEMA=true
Approved by: Maysam Ebrahimi
UTC date: 05282026
Dry-run run_id:
```
