# Backfill readiness checklist

<!-- markdownlint-disable MD013 MD060 -->

**Slice:** NEXT-PRODUCT-ID-02 / **updated NEXT-PRODUCT-ID-04** (resolver columns on `amazon_fba_inventory`)  
**Use:** One checklist **per table** and **per batch wave**. No `UPDATE` until every mandatory item is checked.

---

## Preconditions (mandatory)

- [ ] **Schema verified** — `information_schema` or [sql/01_column_presence_audit.sql](./sql/01_column_presence_audit.sql) confirms target columns exist and types match expectations. For `amazon_fba_inventory`, after deploy also run [sql/04_amazon_fba_inventory_resolver_verify.sql](./sql/04_amazon_fba_inventory_resolver_verify.sql).
- [ ] **Lineage verified** — `organization_id`, `store_id`, `upload_id` (and `source_file_sha256` / `source_physical_row_number` where applicable) populated for rows in scope.
- [ ] **Org / store verified** — batch constrained to known-good `(organization_id, store_id)` pairs; no cross-tenant leakage in queries.
- [ ] **Duplicate / conflicts reviewed** — NEXT-18J/K/M style outputs reviewed for the scope; **ambiguous_conflict** rate below agreed threshold **or** ambiguous rows excluded from batch.
- [ ] **Dry-run thresholds** — `product-seed-dry-run-report` (or successor) CSV signed off for the same WHERE clause as the UPDATE.
- [ ] **Rollback plan** — pre-image CSV export for batch PKs + `OLD.resolved_product_id` values; transactional batch size chosen.
- [ ] **Before / after counts** — `COUNT(*)` total, `COUNT(*) FILTER (WHERE resolved_product_id IS NULL)`, and spot joins to `products` recorded.
- [ ] **Batch sizing** — start ≤ 500–2000 rows per transaction (tune per table size); avoid single mega-transaction.
- [ ] **Logging / audit** — who ran batch, when, which WHERE, rowcount (future: append-only audit table — not in this slice).
- [ ] **Spot checks** — N random rows: verify `resolved_product_id` matches map / unanimous rule.
- [ ] **Approvals** — product owner + (if financial) finance sign-off in ticket or runbook.

---

## Explicit “do not” until checked

- [ ] No broad `UPDATE` without per-table dry-run artifact.
- [ ] No fill for **ambiguous_conflict** or **fan-out** keys.
- [ ] No overwriting raw identifier columns.

---

## Rollback outline (operational)

1. Restore from pre-image CSV using `UPDATE … FROM staging_csv` in a **new** transaction (still a write — only after this checklist is used in an approved **implementation** prompt, not PRODUCT-ID-02).
2. If batch already committed, run compensating `UPDATE` to set `resolved_product_id` back to NULL **only** with the same PK list and audit approval.

---

## Recommended dry-run thresholds (starting point)

Tune per business risk:

| Metric | Suggested gate before first wave |
|--------|-----------------------------------|
| `ambiguous_conflict` share of scanned rows | &lt; 2% **or** zero ambiguous PKs in batch |
| Identifier fan-out incidents | resolved or excluded from batch |
| Missing upload lineage | 0 rows in batch |
| `safe_new_candidate` auto-create | **off** until separate creation policy approved |

---

## Related docs

- [product-id-foundation-roadmap](./product-id-foundation-roadmap.md)
- [table-product-link-strategy](./table-product-link-strategy.md)
- [resolver-confidence-policy](./resolver-confidence-policy.md)
- [resolver-column-schema-alignment-plan](./resolver-column-schema-alignment-plan.md)
- [vendor-confirmation-policy](./vendor-confirmation-policy.md)
