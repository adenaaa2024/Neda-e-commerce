# Product Sheet Wave1 Verify Then Wave2 Approval

**Default:** not approved until operator flags are set.

| Field | Value |
|-------|--------|
| Target ref | `eiqfaapyumhixxoeltgu` |
| Step 1 | Wave1 sample verification-only (fixed duplicate gate) |
| Step 2 | Phase1 closeout wave2 — max 1 wave, 100 rows/type |
| Product creation | forbidden |

## Required operator flags

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_PRODUCT_SHEET_WAVE1_VERIFY_THEN_WAVE2=true
APPROVED_PRODUCT_INSERT=false
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

APPROVED_TO_RUN_STAGING=true
APPROVED_PRODUCT_SHEET_WAVE1_VERIFY_THEN_WAVE2=true
APPROVED_PRODUCT_INSERT=false
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu

## Sign-off

```
Approved by: Main/user (PRODUCT-SHEET-STAGING-APPLY-WAVE1-VERIFY-THEN-WAVE2)
UTC date: 2026-06-01
Notes: Re-verify wave1 duplicate gate then apply first closeout wave on staging only. No product creates.
```
