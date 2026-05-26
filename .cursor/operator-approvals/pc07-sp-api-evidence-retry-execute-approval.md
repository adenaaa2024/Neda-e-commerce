# PC07 SP-API evidence retry — execute approval

| Field | Value |
|-------|--------|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| `APPROVED_TO_RUN_STAGING` | `false` |
| `APPROVED_PC07_SP_API_EVIDENCE_RETRY` | `false` |
| Plan | `.cursor/audit-reports/pc07-expected-packages-dirty-source-quarantine-plan/20260526T130000Z/api-404-review-queue.md` |
| Rows | 5 |

## Allowed

SP-API catalog evidence capture (read-only audit artifacts); manual evidence queue updates.

## Forbidden

product create; `product_identifier_map` insert without separate map approval; fuzzy/title/OCR matching.

```
APPROVED_TO_RUN_STAGING=false
APPROVED_PC07_SP_API_EVIDENCE_RETRY=false
```
