# SP-API packaging dimensions evidence — operator approval

**Scope:** Governed Amazon SP-API **catalog evidence** reads for PC05 packaging backlog (`volume_only_no_lwh` MFBA cohort). Staging only.

**Default:** not approved.

```text
APPROVED_TO_RUN_STAGING=true
APPROVED_SP_API_PACKAGING_DIMENSIONS_EVIDENCE=true
```

## Allowed when approved

| Allowed | Forbidden |
|---------|-----------|
| Backend catalog GET by ASIN (evidence-only pass) | Browser SP-API |
| Audit file cache of catalog JSON + parsed dimensions | `products` UPDATE |
| Read-only staging preflight | `product_identifier_map` INSERT |
| | `product_packaging_*` INSERT |
| | Original/current (`kxsvedvpjldygtdbylsy`) HTTP |
| | Product auto-create |
| | AI / OpenAI |

## Required env (execute phase only)

```text
AMAZON_SP_API_ENABLED=false
PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED=false
PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED=true
```

Set `AMAZON_SP_API_ENABLED=true` only during an approved execute window; revert after.

## Sign-off (fill when approving)

```
APPROVED_TO_RUN_STAGING=true
APPROVED_SP_API_PACKAGING_DIMENSIONS_EVIDENCE=true
Approved by: Maysam Ebrahimi
UTC date: 05262026
```
