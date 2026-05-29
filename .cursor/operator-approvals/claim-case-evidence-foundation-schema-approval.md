# Claim case + evidence foundation schema — operator approval

**Default:** not approved until dry-run review.

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Branch | `feature/product-canonicalization-v2` |
| Prerequisite | `claim_lines` applied on staging |

```text
APPROVED_TO_RUN_STAGING=false
APPROVED_CLAIM_CASE_EVIDENCE_FOUNDATION_SCHEMA=false
```

## Scope (when approved)

1. Apply `supabase/migrations/20260901120000_claim_case_evidence_foundation.sql` on staging only
2. No case/evidence backfill in schema prompt
3. No TRID apply in same prompt

## Forbidden

- Product auto-create
- Bulk claim submit / Amazon API
- Production / original without separate approval

## Sign-off

```
APPROVED_TO_RUN_STAGING=false
APPROVED_CLAIM_CASE_EVIDENCE_FOUNDATION_SCHEMA=false
Approved by:
UTC date:
Dry-run run_id:
```
