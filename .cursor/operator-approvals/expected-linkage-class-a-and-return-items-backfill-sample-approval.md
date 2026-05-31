# Expected Linkage Class A + Return Items Sample Backfill Approval

**Default:** not approved until operator flags are set.

| Field | Value |
|-------|--------|
| Target ref | `eiqfaapyumhixxoeltgu` |
| Census evidence | `.cursor/audit-reports/expected-product-linkage-gap-census/20260607T150000Z/` |
| Plan run | `.cursor/audit-reports/expected-linkage-class-a-and-return-items-backfill-plan/20260607T170000Z/` |

## Plan A — Class A EP backfill (max 2)

| EP id | Tracking | FNSKU | Proposed product |
|-------|----------|-------|------------------|
| `f07b7f86-6b72-4e76-958c-2fe7654343cb` | 2251839738 | X003ZXVFXV | `15c2b80e-c3d6-4799-aeba-718a10fccbbd` |
| `b7715312-1c3e-4190-b881-1feac3450740` | 387019251 | X003ZXVFXV | `15c2b80e-c3d6-4799-aeba-718a10fccbbd` |

## Plan B — return_items EP-resolved copy (sample max 50)

- Orphan pool: **2365** rows
- Sample: `sample-50-return-items.csv`

## Forbidden

- Product create / seed (Class C)
- `product_identifier_map` insert
- Original / production writes

## Required operator flags

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_CLASS_A_EP_BACKFILL=true
APPROVED_CLASS_A_EP_MAX_2=true
APPROVED_RETURN_ITEMS_EP_COPY_SAMPLE=true
APPROVED_RETURN_ITEMS_SAMPLE_MAX_50=true
APPROVED_PRODUCT_CREATE=false
APPROVED_MAP_INSERT=false
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
```

## Sign-off

```
Approved by: Main/user (EXPECTED-LINKAGE-CLASS-A-AND-RETURN-ITEMS-BACKFILL-SAMPLE-EXECUTE)
UTC date: 2026-05-21
Notes: Plan A (2 EP) then Plan B (50 return_items) from plan 20260607T170000Z. Staging only. No map/product creates.
```
