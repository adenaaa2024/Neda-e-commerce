# Resolver confidence policy

<!-- markdownlint-disable MD013 MD060 -->

**Slice:** NEXT-PRODUCT-ID-02  
**Source of truth for buckets:** [lib/audits/product-seed-classifier.ts](../../lib/audits/product-seed-classifier.ts) (`BUCKET_LABELS`, `classify()`).

This document maps **bucket / outcome** to **allowed automation** for product linking and creation. It does **not** grant permission to bypass human review where marked.

---

## Global forbids (all buckets)

- **No** product-name-only matching for create or link.
- **No** blind global UPC trust (UPC-only is its own bucket — never auto-create).
- **No** cross-organization identifier joins.
- **No** cross-store `seller_sku` assumptions unless resolver explicitly encodes store-scoped keys and map rows prove it.
- **No** bypassing upload / physical-row lineage when the pipeline requires it.

---

## Policy table

| Bucket / outcome | Auto-link `resolved_product_id`? | Auto-create product? | Human review? | Future backfill allowed? | API ingestion (future) | Audit severity | Blocker level |
|------------------|----------------------------------|----------------------|---------------|----------------------------|-------------------------|----------------|---------------|
| **already_resolved** (1) | no-op (already set) | no | optional QA spot-check | yes — verify consistency with map | accept row; re-validate on schedule | low | none if consistent |
| **existing_via_identifier_map** (2) | **yes** if single unanimous map hit and upload lineage OK | no | optional | yes for NULL `resolved_product_id` on same keys | auto-link when policy matches | medium | low |
| **existing_via_products** (3) | **yes** if unanimous direct hit + lineage | no | optional | same as (2) | same | medium | low |
| **safe_new_candidate** (4) | N/A until product exists | **no** auto-create without approval path | **yes** before first insert | staged create only after review | queue, do not auto-materialize | high | medium |
| **ambiguous_conflict** (5) | **no** | **no** | **yes** | **no** NULL fill | block auto-link; raw preserved | critical | **hard** |
| **identifier_fan_out** (F1 — secondary on other buckets) | **no** until fan-out resolved | no | **yes** | no | treat as ambiguous | critical | **hard** |
| **upc_only** (6) | no | **no** | **yes** if any action | no | never auto-create from UPC alone | medium | hard for create |
| **name_only** / title-only (7) | no | **no** | N/A | no | never | low | hard for create |
| **missing_org_or_store** (8) | no | no | no — fix data | no | reject row | high | **hard** |
| **missing_identifiers** (9) | no | no | optional triage | no | hold for enrichment | low | soft |
| **dirty_identifier** (10) | no | no | optional cleanse workflow | no | quarantine | medium | hard until clean |
| **human_review** (11) — includes `upload_provenance_unresolved` | no | no | **yes** | no | **do not** auto-link | high | **hard** |
| **missing_upload_lineage** (policy name) | Same as human_review when `uploadResolved === false` | no | **yes** | no | block until upload resolvable | high | **hard** |
| **unresolved** (catch-all: still ambiguous after rules) | no | no | **yes** | no | hold | medium | hard |

### Notes

- **Fan-out (F1):** Often appears as `secondaryReasons` alongside bucket 5; policy treats unresolved fan-out as **hard blocker** for auto-link.
- **Cross-product (F2):** bucket 5 `ambiguous_conflict` — **hard** blocker.
- **API ingestion (future):** Rows must land as raw + lineage first, then resolver; never direct `UPDATE` from API adapter.

---

## Blocker level definitions

- **hard:** automation must not set `resolved_product_id` or create `products` rows.
- **medium:** automation may proceed only with additional gates (e.g. second identifier agreement).
- **soft:** informational; row may remain NULL until enriched.

---

## Alignment with NEXT-18 dry-run

Dry-run scripts classify rows into these buckets **without writes**. Operational “go” for backfill requires bucket distribution thresholds per table (documented separately in [backfill-readiness-checklist](./backfill-readiness-checklist.md)).

**Vendor literals on ingest:** see [vendor-confirmation-policy.md](./vendor-confirmation-policy.md) (e.g. allowlist `1883`).
