# SP-API Product Evidence Dry-Run PC02 Approval

**Default:** not approved. Required before any governed Amazon SP-API catalog evidence HTTP calls for PC02 cohorts.

| Field | Value |
|---|---|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Allowed | Backend SP-API **catalog evidence** reads only (first pass: no product/map writes) |
| Browser SP-API | forbidden |
| Product creation (first pass) | forbidden |
| Production / original | forbidden |
| AI / OpenAI | forbidden |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_SP_API_EVIDENCE_DRY_RUN=true
```

Required server env flags (when execute is approved):

```text
AMAZON_SP_API_ENABLED=false
PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED=false
```

Note: PC02 **evidence-only** execute must not use `tryBackendEnrichment` product INSERT path; use catalog fetch + audit file cache only until a separate product-create prompt is approved.
