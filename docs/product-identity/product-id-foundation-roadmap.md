# Product ID foundation roadmap

<!-- markdownlint-disable MD013 MD060 -->

**Slice:** NEXT-PRODUCT-ID-02 / **NEXT-PRODUCT-ID-04** (FBA inventory resolver columns + dry-run alignment)  
**Scope:** Product identity and graph safety only. No Amazon API implementation here.

---

## Why product identity comes before API

Marketplace APIs continuously produce **rows with merchant SKUs, ASINs, FNSKUs, and order IDs**. If those rows attach to the **wrong** `product_id` or `resolved_product_id`, every downstream module (inventory, claims, reimbursements, forecasting) inherits the error. API volume **amplifies** mistakes faster than manual imports. Therefore the **resolver + identifier map integrity** must be trustworthy **before** turning on high-volume Amazon API ingestion.

---

## Why raw identifiers must remain

Source systems disagree on formatting, nulls, and timing. **Immutable raw columns** (and `raw_data` / report blobs where used) preserve evidence for disputes, audits, and re-resolution when the graph improves. Normalized identifiers live in parallel; **never overwrite raw** with normalized values in place.

---

## Why broad backfill is unsafe

`product_identifier_map` can fan out to **multiple** `product_id`s for the same key. Dry-runs (NEXT-18) showed **ambiguous_conflict**, **cross-product conflicts**, and **identifier fan-out** at scale. Writing `resolved_product_id` org-wide without table-specific dry-runs, conflict review, and rollback batches **cements** wrong joins. **No broad UPDATE** until each wave passes the [backfill-readiness-checklist](./backfill-readiness-checklist.md).

---

## Phases (ordered)

1. **Conflict review** — adjudicate ambiguous clusters (NEXT-18J/K/M style outputs); reduce fan-out and cross-product collisions before mass linking.
2. **Resolver confidence hardening** — align classifier buckets with policy ([resolver-confidence-policy](./resolver-confidence-policy.md)); add gates for upload lineage and map health.
3. **Table link strategy** — per-table contract for `product_id` vs `resolved_product_id` vs raw-only ([table-product-link-strategy](./table-product-link-strategy.md)).
4. **Safe product seed rules** — no name-only / blind UPC creation; provenance required; map inserts only after conflict checks.
5. **Resolver dry-run** — extend `product-seed-dry-run-report` (or shared library) to additional tables; sign off CSVs per table.
6. **Safe backfill waves** — small transactional batches; NULL remains allowed for ambiguous rows.
7. **Unified import / API / scanner resolver** — one code path for all new rows (no bypass).
8. **Amazon API later** — only after phases 1–7 reach agreed thresholds; API traffic enters the **same** ingestion + resolver pipeline as file imports.

---

## Related artifacts

- [resolver-column-schema-alignment-plan.md](./resolver-column-schema-alignment-plan.md) — migration + descriptor alignment (NEXT-PRODUCT-ID-04).
- [vendor-confirmation-policy.md](./vendor-confirmation-policy.md) — vendor allowlist (`1883`) and review rules.
- [table-product-link-strategy.md](./table-product-link-strategy.md)
- [resolver-confidence-policy.md](./resolver-confidence-policy.md)
- [backfill-readiness-checklist.md](./backfill-readiness-checklist.md)
- Read-only SQL: [sql/01_column_presence_audit.sql](./sql/01_column_presence_audit.sql), [sql/04_amazon_fba_inventory_resolver_verify.sql](./sql/04_amazon_fba_inventory_resolver_verify.sql)
- Optional probe: [scripts/read-only-product-link-audit.ts](../../scripts/read-only-product-link-audit.ts)

---

## Do not (this foundation track)

- Amazon API implementation as the “next” engineering track.
- Broad `resolved_product_id` / `product_id` **data** backfill without checklist sign-off, merges, or map inserts outside approved pipelines.
- **Additive schema** (nullable resolver columns) is allowed when documented — see alignment plan.
