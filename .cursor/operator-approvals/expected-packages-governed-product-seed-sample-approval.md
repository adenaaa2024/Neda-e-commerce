# Expected Packages Governed Product Seed Sample Approval

**Default:** not approved until operator flags are set.

| Field | Value |
|-------|--------|
| Target ref | `eiqfaapyumhixxoeltgu` |
| Plan | `.cursor/audit-reports/expected-packages-governed-product-seed-plan/20260601T100000Z/` |
| Candidates | `safe-seed-candidates-max25.csv` (max 25 FNSKUs) |
| Product creation | max 25 governed inserts |
| Production / original | forbidden |

## Required operator flags

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_EP_GOVERNED_PRODUCT_SEED_SAMPLE=true
APPROVED_PRODUCT_INSERT_MAX_25=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

APPROVED_TO_RUN_STAGING=true
APPROVED_EP_GOVERNED_PRODUCT_SEED_SAMPLE=true
APPROVED_PRODUCT_INSERT_MAX_25=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu

## Sign-off

```
Approved by: Main/user (EXPECTED-PACKAGES-GOVERNED-PRODUCT-SEED-SAMPLE-WAVE-STAGING)
UTC date: 2026-06-01
Notes: Max 25 Class C FNSKU-only EP governed seed on staging. Map bridge + resolver only. No fuzzy/title/OCR.
```
