# Expected Packages Amazon API Enrichment V194 Approval

**Default:** not approved. This approval is required before any Amazon SP-API enrichment for expected package gaps.

| Field | Value |
|---|---|
| Staging ref | `eiqfaapyumhixxoeltgu` |
| Allowed API | Backend Amazon SP-API catalog/evidence lookup only |
| Browser API | forbidden |
| Product creation | forbidden unless separate E2/product-promotion approval is also true |
| AI/OpenAI | forbidden |

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_EXPECTED_PACKAGES_AMAZON_API_ENRICHMENT_V194=true
```

Required server gates if approved later:

```text
AMAZON_SP_API_ENABLED=true
PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED=true
```
