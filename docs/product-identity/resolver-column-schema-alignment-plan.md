# Resolver column schema alignment plan

<!-- markdownlint-disable MD013 MD060 -->

**Status:** `amazon_fba_inventory` resolver columns **implemented** in migration [20260813120000_amazon_fba_inventory_resolver_columns.sql](../../supabase/migrations/20260813120000_amazon_fba_inventory_resolver_columns.sql) (NEXT-PRODUCT-ID-04). **No data backfill** in that migration.

---

## 1. Historical mismatch

| Source | Finding |
|--------|---------|
| [20260642_amazon_import_file_alignment.sql](../../supabase/migrations/20260642_amazon_import_file_alignment.sql) | Added resolver quartet to AFI, manage FBA, all_orders, settlements, transactions, **not** `amazon_fba_inventory`. |
| [scripts/product-seed-dry-run-report.ts](../../scripts/product-seed-dry-run-report.ts) (before ID-04) | `amazon_fba_inventory` descriptor omitted resolver columns and always returned null for resolved accessors. |
| Live probe (NEXT-PRODUCT-ID-02) | `resolved_product_id` missing on `amazon_fba_inventory` until migration applied. |

---

## 2. Canonical resolver block (Amazon operational)

Aligned with `20260642`:

- `resolved_product_id` (uuid, nullable)
- `resolved_catalog_product_id` (uuid, nullable)
- `identifier_resolution_status` (text, nullable)
- `identifier_resolution_confidence` (numeric(10,4), nullable)

**Deferred:** FK to `products(id)`, `resolver_run_id`, `resolved_at` — add in a later product-graph phase when safe.

---

## 3. Implementation (NEXT-PRODUCT-ID-04)

- **Migration:** `supabase/migrations/20260813120000_amazon_fba_inventory_resolver_columns.sql`
- **Index:** `idx_amazon_fba_inventory_org_resolved_product` on `(organization_id, resolved_product_id)` WHERE `resolved_product_id IS NOT NULL`.
- **Dry-run:** Descriptor for `amazon_fba_inventory` now selects resolver columns and wires `existingResolvedProductId` / `existingResolvedCatalogProductId` ([product-seed-dry-run-report.ts](../../scripts/product-seed-dry-run-report.ts), [product-seed-identifier-extract.ts](../../lib/audits/product-seed-identifier-extract.ts)).

---

## 4. Draft SQL supersession

[sql/03_resolver_column_alignment_draft.sql](./sql/03_resolver_column_alignment_draft.sql) is marked **superseded** by the committed migration above. Use migration for apply; use [sql/04_amazon_fba_inventory_resolver_verify.sql](./sql/04_amazon_fba_inventory_resolver_verify.sql) for read-only verification after deploy.

---

## 5. Backfill remains blocked

Schema alignment removes **one** structural blocker. Row-level `UPDATE` of `resolved_product_id` still requires [backfill-readiness-checklist](./backfill-readiness-checklist.md) and conflict review (NEXT-18J/K/M).

---

## 6. Vendor confirmation (imports / API)

Canonical policy: [vendor-confirmation-policy.md](./vendor-confirmation-policy.md).

---

## 7. Currency / costing (planning only)

Product identity keys (`resolved_product_id`, `products.id`) will support future cost/profit tables. No cost or FX schema in this slice.
