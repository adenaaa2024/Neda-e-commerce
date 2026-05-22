---
name: Audit SQL bundle
overview: Concrete SELECT-only SQL bundle for the NEXT-13 resolver backfill audit. One section per audit-target table, each containing coverage, recoverability, ambiguity, and store-gap queries — ready to paste into the Supabase SQL editor and export as CSV.
todos:
  - id: no-op
    content: NEXT-13B is a SQL bundle deliverable. The operator runs the queries in Supabase, exports CSVs, and returns them. No code or DB mutation.
    status: pending
isProject: false
---

## NEXT-13B — Executable SELECT-only audit SQL

Plan only. The deliverable is the SQL itself. No code changes, no migrations, no UPDATE/INSERT/DELETE/ALTER/CREATE.

### Conventions used in every block

- All `product_identifier_map` joins include `p.deleted_at IS NULL`.
- `IS NOT DISTINCT FROM` is used for `store_id` because it must match correctly even when both sides are NULL (the store-gap report handles NULL specifically). For very large tables, prefer scoping by `t.store_id IS NOT NULL` and running the gap report separately.
- Every query is unscoped by default. To run on one org / one upload, add a `WHERE t.organization_id = '<ORG_UUID>' AND t.<UPLOAD_COL> = '<UPLOAD_UUID>'` predicate. Recommended for tables expected to exceed ~5M rows.
- "Active PIM" means `product_identifier_map` rows with `deleted_at IS NULL`.
- "Distinct candidates" = `count(DISTINCT p.product_id)` against active PIM. `= 1` is unambiguous, `> 1` is ambiguous, `0` is no-match.
- Recoverability buckets are mutually exclusive with priority `seller_sku > fnsku > seller_sku+asin > asin`. UPC and `product_name`/`title` are intentionally excluded as write-back keys per the safety rules.
- For each block the comment header is `-- ===== <table> / <report> =====` so result tabs stay labelled when copy-pasted.

---

### 1) `amazon_amazon_fulfilled_inventory` (AFI) — identity carrier

Notes:
- Resolver product column: `resolved_product_id`.
- Resolver catalog column: `resolved_catalog_product_id`.
- Status / confidence: `identifier_resolution_status`, `identifier_resolution_confidence`.
- Upload column: `source_upload_id`.
- Native identifiers: `seller_sku`, `fulfillment_channel_sku` (= FNSKU), `asin`.
- Highest-quality identifier surface in the audit set; recommended Phase-1 backfill target.

```sql
-- ===== amazon_amazon_fulfilled_inventory / 1 coverage =====
SELECT
  count(*)                                                              AS rows_total,
  count(*) FILTER (WHERE resolved_product_id IS NOT NULL)               AS rows_with_product,
  count(*) FILTER (WHERE resolved_catalog_product_id IS NOT NULL)       AS rows_with_catalog,
  count(*) FILTER (WHERE resolved_product_id IS NULL)                   AS rows_unresolved,
  count(*) FILTER (WHERE organization_id IS NOT NULL)                   AS rows_with_org,
  count(*) FILTER (WHERE store_id IS NOT NULL)                          AS rows_with_store,
  count(DISTINCT organization_id)                                       AS distinct_orgs,
  count(DISTINCT store_id)                                              AS distinct_stores,
  count(DISTINCT source_upload_id)                                      AS distinct_uploads,
  count(*) FILTER (WHERE identifier_resolution_status IS NOT NULL)      AS rows_with_resolution_status
FROM public.amazon_amazon_fulfilled_inventory;
```

```sql
-- ===== amazon_amazon_fulfilled_inventory / 2 coverage by org/store/upload =====
SELECT
  organization_id,
  store_id,
  source_upload_id                                                      AS upload_id,
  count(*)                                                              AS rows_total,
  count(*) FILTER (WHERE resolved_product_id IS NOT NULL)               AS rows_resolved,
  count(*) FILTER (WHERE resolved_product_id IS NULL)                   AS rows_unresolved,
  count(*) FILTER (WHERE store_id IS NULL)                              AS rows_store_null
FROM public.amazon_amazon_fulfilled_inventory
GROUP BY 1, 2, 3
ORDER BY rows_unresolved DESC
LIMIT 200;
```

```sql
-- ===== amazon_amazon_fulfilled_inventory / 3 recoverability by active PIM =====
WITH tgt AS (
  SELECT t.id, t.organization_id, t.store_id,
         t.seller_sku                  AS sku,
         t.fulfillment_channel_sku     AS fnsku,
         t.asin
  FROM public.amazon_amazon_fulfilled_inventory t
  WHERE t.resolved_product_id IS NULL
    AND t.store_id IS NOT NULL
), c AS (
  SELECT
    tgt.*,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL
         AND p.seller_sku = tgt.sku AND tgt.sku IS NOT NULL)            AS n_sku,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL
         AND p.fnsku = tgt.fnsku AND tgt.fnsku IS NOT NULL)             AS n_fnsku,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL
         AND p.seller_sku = tgt.sku AND p.asin = tgt.asin
         AND tgt.sku IS NOT NULL AND tgt.asin IS NOT NULL)              AS n_sku_asin,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL
         AND p.asin = tgt.asin AND tgt.asin IS NOT NULL)                AS n_asin
  FROM tgt
)
SELECT
  count(*)                                                              AS unresolved_in_scope,
  count(*) FILTER (WHERE n_sku       = 1)                               AS exact_one_via_sku,
  count(*) FILTER (WHERE n_sku <> 1 AND n_fnsku    = 1)                 AS exact_one_via_fnsku,
  count(*) FILTER (WHERE n_sku <> 1 AND n_fnsku <> 1
                       AND n_sku_asin = 1)                              AS exact_one_via_sku_asin,
  count(*) FILTER (WHERE n_sku <> 1 AND n_fnsku <> 1
                       AND n_sku_asin <> 1 AND n_asin = 1)              AS exact_one_via_asin_only,
  count(*) FILTER (WHERE n_sku = 0 AND n_fnsku = 0
                       AND n_sku_asin = 0 AND n_asin = 0)               AS no_match_anywhere,
  count(*) FILTER (WHERE n_sku > 1 OR n_fnsku > 1
                       OR n_sku_asin > 1 OR n_asin > 1)                 AS ambiguous_at_some_level
FROM c;
```

```sql
-- ===== amazon_amazon_fulfilled_inventory / 4a top-50 ambiguous SKUs =====
SELECT t.organization_id, t.store_id, t.seller_sku AS identifier,
       (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL
            AND p.seller_sku = t.seller_sku) AS candidate_product_count,
       count(*) AS affected_row_count
FROM public.amazon_amazon_fulfilled_inventory t
WHERE t.resolved_product_id IS NULL AND t.seller_sku IS NOT NULL AND t.store_id IS NOT NULL
GROUP BY 1, 2, 3
HAVING (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL
            AND p.seller_sku = t.seller_sku) > 1
ORDER BY affected_row_count DESC LIMIT 50;
```

```sql
-- ===== amazon_amazon_fulfilled_inventory / 4b top-50 ambiguous FNSKUs =====
SELECT t.organization_id, t.store_id, t.fulfillment_channel_sku AS identifier,
       (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL
            AND p.fnsku = t.fulfillment_channel_sku) AS candidate_product_count,
       count(*) AS affected_row_count
FROM public.amazon_amazon_fulfilled_inventory t
WHERE t.resolved_product_id IS NULL AND t.fulfillment_channel_sku IS NOT NULL AND t.store_id IS NOT NULL
GROUP BY 1, 2, 3
HAVING (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL
            AND p.fnsku = t.fulfillment_channel_sku) > 1
ORDER BY affected_row_count DESC LIMIT 50;
```

```sql
-- ===== amazon_amazon_fulfilled_inventory / 4c top-50 ambiguous ASINs =====
SELECT t.organization_id, t.store_id, t.asin AS identifier,
       (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL
            AND p.asin = t.asin) AS candidate_product_count,
       count(*) AS affected_row_count
FROM public.amazon_amazon_fulfilled_inventory t
WHERE t.resolved_product_id IS NULL AND t.asin IS NOT NULL AND t.store_id IS NOT NULL
GROUP BY 1, 2, 3
HAVING (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL
            AND p.asin = t.asin) > 1
ORDER BY affected_row_count DESC LIMIT 50;
```

```sql
-- ===== amazon_amazon_fulfilled_inventory / 5 store-gap (store_id NULL) =====
SELECT
  organization_id,
  source_upload_id                AS upload_id,
  count(*)                        AS rows_store_null,
  count(*) FILTER (WHERE resolved_product_id IS NULL) AS rows_store_null_unresolved
FROM public.amazon_amazon_fulfilled_inventory
WHERE store_id IS NULL
GROUP BY 1, 2
ORDER BY rows_store_null DESC
LIMIT 200;
```

---

### 2) `amazon_inventory_ledger`

Notes:
- Resolver columns: `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence`.
- Upload column: `upload_id`.
- Native identifiers: `sku`, `fnsku`, `asin`, `title`, `product_name`. Use only `sku` / `fnsku` / `asin` for write-back keys.
- Identifier indexes per [`supabase/migrations/20260642_amazon_import_file_alignment.sql:119-127`](supabase/migrations/20260642_amazon_import_file_alignment.sql).

```sql
-- ===== amazon_inventory_ledger / 1 coverage =====
SELECT
  count(*)                                                              AS rows_total,
  count(*) FILTER (WHERE resolved_product_id IS NOT NULL)               AS rows_with_product,
  count(*) FILTER (WHERE resolved_catalog_product_id IS NOT NULL)       AS rows_with_catalog,
  count(*) FILTER (WHERE resolved_product_id IS NULL)                   AS rows_unresolved,
  count(*) FILTER (WHERE organization_id IS NOT NULL)                   AS rows_with_org,
  count(*) FILTER (WHERE store_id IS NOT NULL)                          AS rows_with_store,
  count(DISTINCT organization_id)                                       AS distinct_orgs,
  count(DISTINCT store_id)                                              AS distinct_stores,
  count(DISTINCT upload_id)                                             AS distinct_uploads,
  count(*) FILTER (WHERE identifier_resolution_status IS NOT NULL)      AS rows_with_resolution_status
FROM public.amazon_inventory_ledger;
```

```sql
-- ===== amazon_inventory_ledger / 2 coverage by org/store/upload =====
SELECT organization_id, store_id, upload_id,
  count(*)                                                              AS rows_total,
  count(*) FILTER (WHERE resolved_product_id IS NOT NULL)               AS rows_resolved,
  count(*) FILTER (WHERE resolved_product_id IS NULL)                   AS rows_unresolved,
  count(*) FILTER (WHERE store_id IS NULL)                              AS rows_store_null
FROM public.amazon_inventory_ledger
GROUP BY 1, 2, 3
ORDER BY rows_unresolved DESC
LIMIT 200;
```

```sql
-- ===== amazon_inventory_ledger / 3 recoverability by active PIM =====
WITH tgt AS (
  SELECT t.id, t.organization_id, t.store_id, t.sku, t.fnsku, t.asin
  FROM public.amazon_inventory_ledger t
  WHERE t.resolved_product_id IS NULL AND t.store_id IS NOT NULL
), c AS (
  SELECT tgt.*,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL
         AND p.seller_sku = tgt.sku AND tgt.sku IS NOT NULL)            AS n_sku,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL
         AND p.fnsku = tgt.fnsku AND tgt.fnsku IS NOT NULL)             AS n_fnsku,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL
         AND p.seller_sku = tgt.sku AND p.asin = tgt.asin
         AND tgt.sku IS NOT NULL AND tgt.asin IS NOT NULL)              AS n_sku_asin,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL
         AND p.asin = tgt.asin AND tgt.asin IS NOT NULL)                AS n_asin
  FROM tgt
)
SELECT
  count(*)                                                              AS unresolved_in_scope,
  count(*) FILTER (WHERE n_sku       = 1)                               AS exact_one_via_sku,
  count(*) FILTER (WHERE n_sku <> 1 AND n_fnsku    = 1)                 AS exact_one_via_fnsku,
  count(*) FILTER (WHERE n_sku <> 1 AND n_fnsku <> 1
                       AND n_sku_asin = 1)                              AS exact_one_via_sku_asin,
  count(*) FILTER (WHERE n_sku <> 1 AND n_fnsku <> 1
                       AND n_sku_asin <> 1 AND n_asin = 1)              AS exact_one_via_asin_only,
  count(*) FILTER (WHERE n_sku = 0 AND n_fnsku = 0
                       AND n_sku_asin = 0 AND n_asin = 0)               AS no_match_anywhere,
  count(*) FILTER (WHERE n_sku > 1 OR n_fnsku > 1
                       OR n_sku_asin > 1 OR n_asin > 1)                 AS ambiguous_at_some_level
FROM c;
```

```sql
-- ===== amazon_inventory_ledger / 4a top-50 ambiguous SKUs =====
SELECT t.organization_id, t.store_id, t.sku AS identifier,
       (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.seller_sku = t.sku) AS candidate_product_count,
       count(*) AS affected_row_count
FROM public.amazon_inventory_ledger t
WHERE t.resolved_product_id IS NULL AND t.sku IS NOT NULL AND t.store_id IS NOT NULL
GROUP BY 1, 2, 3
HAVING (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.seller_sku = t.sku) > 1
ORDER BY affected_row_count DESC LIMIT 50;
```

```sql
-- ===== amazon_inventory_ledger / 4b top-50 ambiguous FNSKUs =====
SELECT t.organization_id, t.store_id, t.fnsku AS identifier,
       (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.fnsku = t.fnsku) AS candidate_product_count,
       count(*) AS affected_row_count
FROM public.amazon_inventory_ledger t
WHERE t.resolved_product_id IS NULL AND t.fnsku IS NOT NULL AND t.store_id IS NOT NULL
GROUP BY 1, 2, 3
HAVING (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.fnsku = t.fnsku) > 1
ORDER BY affected_row_count DESC LIMIT 50;
```

```sql
-- ===== amazon_inventory_ledger / 4c top-50 ambiguous ASINs =====
SELECT t.organization_id, t.store_id, t.asin AS identifier,
       (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.asin = t.asin) AS candidate_product_count,
       count(*) AS affected_row_count
FROM public.amazon_inventory_ledger t
WHERE t.resolved_product_id IS NULL AND t.asin IS NOT NULL AND t.store_id IS NOT NULL
GROUP BY 1, 2, 3
HAVING (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.asin = t.asin) > 1
ORDER BY affected_row_count DESC LIMIT 50;
```

```sql
-- ===== amazon_inventory_ledger / 5 store-gap (store_id NULL) =====
SELECT organization_id, upload_id,
  count(*)                                            AS rows_store_null,
  count(*) FILTER (WHERE resolved_product_id IS NULL) AS rows_store_null_unresolved
FROM public.amazon_inventory_ledger
WHERE store_id IS NULL
GROUP BY 1, 2
ORDER BY rows_store_null DESC
LIMIT 200;
```

---

### 3) `amazon_manage_fba_inventory`

Notes:
- Resolver columns: `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence`.
- Upload column: `source_upload_id`.
- Native identifiers: `sku`, `fnsku`, `asin`, `product_name`.

```sql
-- ===== amazon_manage_fba_inventory / 1 coverage =====
SELECT
  count(*)                                                              AS rows_total,
  count(*) FILTER (WHERE resolved_product_id IS NOT NULL)               AS rows_with_product,
  count(*) FILTER (WHERE resolved_catalog_product_id IS NOT NULL)       AS rows_with_catalog,
  count(*) FILTER (WHERE resolved_product_id IS NULL)                   AS rows_unresolved,
  count(*) FILTER (WHERE organization_id IS NOT NULL)                   AS rows_with_org,
  count(*) FILTER (WHERE store_id IS NOT NULL)                          AS rows_with_store,
  count(DISTINCT organization_id)                                       AS distinct_orgs,
  count(DISTINCT store_id)                                              AS distinct_stores,
  count(DISTINCT source_upload_id)                                      AS distinct_uploads,
  count(*) FILTER (WHERE identifier_resolution_status IS NOT NULL)      AS rows_with_resolution_status
FROM public.amazon_manage_fba_inventory;
```

```sql
-- ===== amazon_manage_fba_inventory / 2 coverage by org/store/upload =====
SELECT organization_id, store_id, source_upload_id AS upload_id,
  count(*)                                                              AS rows_total,
  count(*) FILTER (WHERE resolved_product_id IS NOT NULL)               AS rows_resolved,
  count(*) FILTER (WHERE resolved_product_id IS NULL)                   AS rows_unresolved,
  count(*) FILTER (WHERE store_id IS NULL)                              AS rows_store_null
FROM public.amazon_manage_fba_inventory
GROUP BY 1, 2, 3
ORDER BY rows_unresolved DESC
LIMIT 200;
```

```sql
-- ===== amazon_manage_fba_inventory / 3 recoverability by active PIM =====
WITH tgt AS (
  SELECT t.id, t.organization_id, t.store_id, t.sku, t.fnsku, t.asin
  FROM public.amazon_manage_fba_inventory t
  WHERE t.resolved_product_id IS NULL AND t.store_id IS NOT NULL
), c AS (
  SELECT tgt.*,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL
         AND p.seller_sku = tgt.sku AND tgt.sku IS NOT NULL)            AS n_sku,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL
         AND p.fnsku = tgt.fnsku AND tgt.fnsku IS NOT NULL)             AS n_fnsku,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL
         AND p.seller_sku = tgt.sku AND p.asin = tgt.asin
         AND tgt.sku IS NOT NULL AND tgt.asin IS NOT NULL)              AS n_sku_asin,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL
         AND p.asin = tgt.asin AND tgt.asin IS NOT NULL)                AS n_asin
  FROM tgt
)
SELECT
  count(*)                                                              AS unresolved_in_scope,
  count(*) FILTER (WHERE n_sku       = 1)                               AS exact_one_via_sku,
  count(*) FILTER (WHERE n_sku <> 1 AND n_fnsku    = 1)                 AS exact_one_via_fnsku,
  count(*) FILTER (WHERE n_sku <> 1 AND n_fnsku <> 1
                       AND n_sku_asin = 1)                              AS exact_one_via_sku_asin,
  count(*) FILTER (WHERE n_sku <> 1 AND n_fnsku <> 1
                       AND n_sku_asin <> 1 AND n_asin = 1)              AS exact_one_via_asin_only,
  count(*) FILTER (WHERE n_sku = 0 AND n_fnsku = 0
                       AND n_sku_asin = 0 AND n_asin = 0)               AS no_match_anywhere,
  count(*) FILTER (WHERE n_sku > 1 OR n_fnsku > 1
                       OR n_sku_asin > 1 OR n_asin > 1)                 AS ambiguous_at_some_level
FROM c;
```

```sql
-- ===== amazon_manage_fba_inventory / 4a top-50 ambiguous SKUs =====
SELECT t.organization_id, t.store_id, t.sku AS identifier,
       (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.seller_sku = t.sku) AS candidate_product_count,
       count(*) AS affected_row_count
FROM public.amazon_manage_fba_inventory t
WHERE t.resolved_product_id IS NULL AND t.sku IS NOT NULL AND t.store_id IS NOT NULL
GROUP BY 1, 2, 3
HAVING (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.seller_sku = t.sku) > 1
ORDER BY affected_row_count DESC LIMIT 50;
```

```sql
-- ===== amazon_manage_fba_inventory / 4b top-50 ambiguous FNSKUs =====
SELECT t.organization_id, t.store_id, t.fnsku AS identifier,
       (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.fnsku = t.fnsku) AS candidate_product_count,
       count(*) AS affected_row_count
FROM public.amazon_manage_fba_inventory t
WHERE t.resolved_product_id IS NULL AND t.fnsku IS NOT NULL AND t.store_id IS NOT NULL
GROUP BY 1, 2, 3
HAVING (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.fnsku = t.fnsku) > 1
ORDER BY affected_row_count DESC LIMIT 50;
```

```sql
-- ===== amazon_manage_fba_inventory / 4c top-50 ambiguous ASINs =====
SELECT t.organization_id, t.store_id, t.asin AS identifier,
       (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.asin = t.asin) AS candidate_product_count,
       count(*) AS affected_row_count
FROM public.amazon_manage_fba_inventory t
WHERE t.resolved_product_id IS NULL AND t.asin IS NOT NULL AND t.store_id IS NOT NULL
GROUP BY 1, 2, 3
HAVING (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.asin = t.asin) > 1
ORDER BY affected_row_count DESC LIMIT 50;
```

```sql
-- ===== amazon_manage_fba_inventory / 5 store-gap (store_id NULL) =====
SELECT organization_id, source_upload_id AS upload_id,
  count(*)                                            AS rows_store_null,
  count(*) FILTER (WHERE resolved_product_id IS NULL) AS rows_store_null_unresolved
FROM public.amazon_manage_fba_inventory
WHERE store_id IS NULL
GROUP BY 1, 2
ORDER BY rows_store_null DESC
LIMIT 200;
```

---

### 4) `amazon_fba_inventory`

Notes:
- Resolver columns: `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence`.
- Upload column: `source_upload_id`.
- Native identifiers: `sku`, `fnsku`, `asin`, `product_name`.

(Identical query shape as section 3; only the table name differs. Block-by-block:)

```sql
-- ===== amazon_fba_inventory / 1 coverage =====
SELECT
  count(*)                                                              AS rows_total,
  count(*) FILTER (WHERE resolved_product_id IS NOT NULL)               AS rows_with_product,
  count(*) FILTER (WHERE resolved_catalog_product_id IS NOT NULL)       AS rows_with_catalog,
  count(*) FILTER (WHERE resolved_product_id IS NULL)                   AS rows_unresolved,
  count(*) FILTER (WHERE organization_id IS NOT NULL)                   AS rows_with_org,
  count(*) FILTER (WHERE store_id IS NOT NULL)                          AS rows_with_store,
  count(DISTINCT organization_id)                                       AS distinct_orgs,
  count(DISTINCT store_id)                                              AS distinct_stores,
  count(DISTINCT source_upload_id)                                      AS distinct_uploads,
  count(*) FILTER (WHERE identifier_resolution_status IS NOT NULL)      AS rows_with_resolution_status
FROM public.amazon_fba_inventory;
```

```sql
-- ===== amazon_fba_inventory / 2 coverage by org/store/upload =====
SELECT organization_id, store_id, source_upload_id AS upload_id,
  count(*)                                                              AS rows_total,
  count(*) FILTER (WHERE resolved_product_id IS NOT NULL)               AS rows_resolved,
  count(*) FILTER (WHERE resolved_product_id IS NULL)                   AS rows_unresolved,
  count(*) FILTER (WHERE store_id IS NULL)                              AS rows_store_null
FROM public.amazon_fba_inventory
GROUP BY 1, 2, 3
ORDER BY rows_unresolved DESC
LIMIT 200;
```

```sql
-- ===== amazon_fba_inventory / 3 recoverability by active PIM =====
WITH tgt AS (
  SELECT t.id, t.organization_id, t.store_id, t.sku, t.fnsku, t.asin
  FROM public.amazon_fba_inventory t
  WHERE t.resolved_product_id IS NULL AND t.store_id IS NOT NULL
), c AS (
  SELECT tgt.*,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL
         AND p.seller_sku = tgt.sku AND tgt.sku IS NOT NULL)            AS n_sku,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL
         AND p.fnsku = tgt.fnsku AND tgt.fnsku IS NOT NULL)             AS n_fnsku,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL
         AND p.seller_sku = tgt.sku AND p.asin = tgt.asin
         AND tgt.sku IS NOT NULL AND tgt.asin IS NOT NULL)              AS n_sku_asin,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL
         AND p.asin = tgt.asin AND tgt.asin IS NOT NULL)                AS n_asin
  FROM tgt
)
SELECT
  count(*)                                                              AS unresolved_in_scope,
  count(*) FILTER (WHERE n_sku       = 1)                               AS exact_one_via_sku,
  count(*) FILTER (WHERE n_sku <> 1 AND n_fnsku    = 1)                 AS exact_one_via_fnsku,
  count(*) FILTER (WHERE n_sku <> 1 AND n_fnsku <> 1
                       AND n_sku_asin = 1)                              AS exact_one_via_sku_asin,
  count(*) FILTER (WHERE n_sku <> 1 AND n_fnsku <> 1
                       AND n_sku_asin <> 1 AND n_asin = 1)              AS exact_one_via_asin_only,
  count(*) FILTER (WHERE n_sku = 0 AND n_fnsku = 0
                       AND n_sku_asin = 0 AND n_asin = 0)               AS no_match_anywhere,
  count(*) FILTER (WHERE n_sku > 1 OR n_fnsku > 1
                       OR n_sku_asin > 1 OR n_asin > 1)                 AS ambiguous_at_some_level
FROM c;
```

```sql
-- ===== amazon_fba_inventory / 4a top-50 ambiguous SKUs =====
SELECT t.organization_id, t.store_id, t.sku AS identifier,
       (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.seller_sku = t.sku) AS candidate_product_count,
       count(*) AS affected_row_count
FROM public.amazon_fba_inventory t
WHERE t.resolved_product_id IS NULL AND t.sku IS NOT NULL AND t.store_id IS NOT NULL
GROUP BY 1, 2, 3
HAVING (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.seller_sku = t.sku) > 1
ORDER BY affected_row_count DESC LIMIT 50;
```

```sql
-- ===== amazon_fba_inventory / 4b top-50 ambiguous FNSKUs =====
SELECT t.organization_id, t.store_id, t.fnsku AS identifier,
       (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.fnsku = t.fnsku) AS candidate_product_count,
       count(*) AS affected_row_count
FROM public.amazon_fba_inventory t
WHERE t.resolved_product_id IS NULL AND t.fnsku IS NOT NULL AND t.store_id IS NOT NULL
GROUP BY 1, 2, 3
HAVING (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.fnsku = t.fnsku) > 1
ORDER BY affected_row_count DESC LIMIT 50;
```

```sql
-- ===== amazon_fba_inventory / 4c top-50 ambiguous ASINs =====
SELECT t.organization_id, t.store_id, t.asin AS identifier,
       (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.asin = t.asin) AS candidate_product_count,
       count(*) AS affected_row_count
FROM public.amazon_fba_inventory t
WHERE t.resolved_product_id IS NULL AND t.asin IS NOT NULL AND t.store_id IS NOT NULL
GROUP BY 1, 2, 3
HAVING (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.asin = t.asin) > 1
ORDER BY affected_row_count DESC LIMIT 50;
```

```sql
-- ===== amazon_fba_inventory / 5 store-gap (store_id NULL) =====
SELECT organization_id, source_upload_id AS upload_id,
  count(*)                                            AS rows_store_null,
  count(*) FILTER (WHERE resolved_product_id IS NULL) AS rows_store_null_unresolved
FROM public.amazon_fba_inventory
WHERE store_id IS NULL
GROUP BY 1, 2
ORDER BY rows_store_null DESC
LIMIT 200;
```

---

### 5) `amazon_all_orders`

Notes:
- Resolver columns: `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence`.
- Upload column: `source_upload_id`.
- Native identifiers: `sku`, `amazon_order_id`, `merchant_order_id`, `product_name`. **No native `asin` or `fnsku` columns** — ASIN is typically inside `raw_data`. SKU is the only safe write-back identifier. ASIN-from-raw_data is Phase 2.

```sql
-- ===== amazon_all_orders / 1 coverage =====
SELECT
  count(*)                                                              AS rows_total,
  count(*) FILTER (WHERE resolved_product_id IS NOT NULL)               AS rows_with_product,
  count(*) FILTER (WHERE resolved_catalog_product_id IS NOT NULL)       AS rows_with_catalog,
  count(*) FILTER (WHERE resolved_product_id IS NULL)                   AS rows_unresolved,
  count(*) FILTER (WHERE organization_id IS NOT NULL)                   AS rows_with_org,
  count(*) FILTER (WHERE store_id IS NOT NULL)                          AS rows_with_store,
  count(DISTINCT organization_id)                                       AS distinct_orgs,
  count(DISTINCT store_id)                                              AS distinct_stores,
  count(DISTINCT source_upload_id)                                      AS distinct_uploads,
  count(*) FILTER (WHERE identifier_resolution_status IS NOT NULL)      AS rows_with_resolution_status
FROM public.amazon_all_orders;
```

```sql
-- ===== amazon_all_orders / 2 coverage by org/store/upload =====
SELECT organization_id, store_id, source_upload_id AS upload_id,
  count(*)                                                              AS rows_total,
  count(*) FILTER (WHERE resolved_product_id IS NOT NULL)               AS rows_resolved,
  count(*) FILTER (WHERE resolved_product_id IS NULL)                   AS rows_unresolved,
  count(*) FILTER (WHERE store_id IS NULL)                              AS rows_store_null
FROM public.amazon_all_orders
GROUP BY 1, 2, 3
ORDER BY rows_unresolved DESC
LIMIT 200;
```

```sql
-- ===== amazon_all_orders / 3 recoverability by active PIM (SKU only — native) =====
WITH tgt AS (
  SELECT t.id, t.organization_id, t.store_id, t.sku
  FROM public.amazon_all_orders t
  WHERE t.resolved_product_id IS NULL AND t.store_id IS NOT NULL AND t.sku IS NOT NULL
), c AS (
  SELECT tgt.*,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL AND p.seller_sku = tgt.sku) AS n_sku
  FROM tgt
)
SELECT
  count(*)                                AS unresolved_with_sku,
  count(*) FILTER (WHERE n_sku = 1)       AS exact_one_via_sku,
  count(*) FILTER (WHERE n_sku = 0)       AS no_match_via_sku,
  count(*) FILTER (WHERE n_sku > 1)       AS ambiguous_via_sku
FROM c;
```

```sql
-- ===== amazon_all_orders / 4a top-50 ambiguous SKUs =====
SELECT t.organization_id, t.store_id, t.sku AS identifier,
       (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.seller_sku = t.sku) AS candidate_product_count,
       count(*) AS affected_row_count
FROM public.amazon_all_orders t
WHERE t.resolved_product_id IS NULL AND t.sku IS NOT NULL AND t.store_id IS NOT NULL
GROUP BY 1, 2, 3
HAVING (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.seller_sku = t.sku) > 1
ORDER BY affected_row_count DESC LIMIT 50;
```

```sql
-- ===== amazon_all_orders / 5 store-gap (store_id NULL) =====
SELECT organization_id, source_upload_id AS upload_id,
  count(*)                                            AS rows_store_null,
  count(*) FILTER (WHERE resolved_product_id IS NULL) AS rows_store_null_unresolved
FROM public.amazon_all_orders
WHERE store_id IS NULL
GROUP BY 1, 2
ORDER BY rows_store_null DESC
LIMIT 200;
```

---

### 6) `amazon_settlements`

Notes:
- Resolver columns: `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence`.
- Upload column: `upload_id`.
- Native identifiers: `sku`, `order_id`. **No native `asin` or `fnsku`** (may exist in `raw_data` only). SKU is the only safe write-back identifier; ASIN-from-raw_data is Phase 2.
- `store_id` populated for new rows post NEXT-07; historical rows may be NULL.

```sql
-- ===== amazon_settlements / 1 coverage =====
SELECT
  count(*)                                                              AS rows_total,
  count(*) FILTER (WHERE resolved_product_id IS NOT NULL)               AS rows_with_product,
  count(*) FILTER (WHERE resolved_catalog_product_id IS NOT NULL)       AS rows_with_catalog,
  count(*) FILTER (WHERE resolved_product_id IS NULL)                   AS rows_unresolved,
  count(*) FILTER (WHERE organization_id IS NOT NULL)                   AS rows_with_org,
  count(*) FILTER (WHERE store_id IS NOT NULL)                          AS rows_with_store,
  count(DISTINCT organization_id)                                       AS distinct_orgs,
  count(DISTINCT store_id)                                              AS distinct_stores,
  count(DISTINCT upload_id)                                             AS distinct_uploads,
  count(*) FILTER (WHERE identifier_resolution_status IS NOT NULL)      AS rows_with_resolution_status
FROM public.amazon_settlements;
```

```sql
-- ===== amazon_settlements / 2 coverage by org/store/upload =====
SELECT organization_id, store_id, upload_id,
  count(*)                                                              AS rows_total,
  count(*) FILTER (WHERE resolved_product_id IS NOT NULL)               AS rows_resolved,
  count(*) FILTER (WHERE resolved_product_id IS NULL)                   AS rows_unresolved,
  count(*) FILTER (WHERE store_id IS NULL)                              AS rows_store_null
FROM public.amazon_settlements
GROUP BY 1, 2, 3
ORDER BY rows_unresolved DESC
LIMIT 200;
```

```sql
-- ===== amazon_settlements / 3 recoverability by active PIM (SKU only — native) =====
WITH tgt AS (
  SELECT t.id, t.organization_id, t.store_id, t.sku
  FROM public.amazon_settlements t
  WHERE t.resolved_product_id IS NULL AND t.store_id IS NOT NULL AND t.sku IS NOT NULL
), c AS (
  SELECT tgt.*,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL AND p.seller_sku = tgt.sku) AS n_sku
  FROM tgt
)
SELECT
  count(*)                                AS unresolved_with_sku,
  count(*) FILTER (WHERE n_sku = 1)       AS exact_one_via_sku,
  count(*) FILTER (WHERE n_sku = 0)       AS no_match_via_sku,
  count(*) FILTER (WHERE n_sku > 1)       AS ambiguous_via_sku
FROM c;
```

```sql
-- ===== amazon_settlements / 4a top-50 ambiguous SKUs =====
SELECT t.organization_id, t.store_id, t.sku AS identifier,
       (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.seller_sku = t.sku) AS candidate_product_count,
       count(*) AS affected_row_count
FROM public.amazon_settlements t
WHERE t.resolved_product_id IS NULL AND t.sku IS NOT NULL AND t.store_id IS NOT NULL
GROUP BY 1, 2, 3
HAVING (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.seller_sku = t.sku) > 1
ORDER BY affected_row_count DESC LIMIT 50;
```

```sql
-- ===== amazon_settlements / 5 store-gap (store_id NULL) =====
SELECT organization_id, upload_id,
  count(*)                                            AS rows_store_null,
  count(*) FILTER (WHERE resolved_product_id IS NULL) AS rows_store_null_unresolved
FROM public.amazon_settlements
WHERE store_id IS NULL
GROUP BY 1, 2
ORDER BY rows_store_null DESC
LIMIT 200;
```

---

### 7) `amazon_transactions`

Notes:
- Resolver columns: `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence`.
- Upload column: `upload_id`.
- Native identifiers: `sku`, `order_id`. SKU is frequently NULL on the simple summary file (per the comment at [`lib/import-sync-mappers.ts:276`](lib/import-sync-mappers.ts) — "joined via amazon_all_orders for the simple summary file"). The optional all_orders-join recoverability query is provided.
- `store_id` populated for new rows post NEXT-06; historical rows may be NULL.

```sql
-- ===== amazon_transactions / 1 coverage =====
SELECT
  count(*)                                                              AS rows_total,
  count(*) FILTER (WHERE resolved_product_id IS NOT NULL)               AS rows_with_product,
  count(*) FILTER (WHERE resolved_catalog_product_id IS NOT NULL)       AS rows_with_catalog,
  count(*) FILTER (WHERE resolved_product_id IS NULL)                   AS rows_unresolved,
  count(*) FILTER (WHERE organization_id IS NOT NULL)                   AS rows_with_org,
  count(*) FILTER (WHERE store_id IS NOT NULL)                          AS rows_with_store,
  count(*) FILTER (WHERE sku IS NOT NULL)                               AS rows_with_sku,
  count(*) FILTER (WHERE order_id IS NOT NULL)                          AS rows_with_order_id,
  count(DISTINCT organization_id)                                       AS distinct_orgs,
  count(DISTINCT store_id)                                              AS distinct_stores,
  count(DISTINCT upload_id)                                             AS distinct_uploads,
  count(*) FILTER (WHERE identifier_resolution_status IS NOT NULL)      AS rows_with_resolution_status
FROM public.amazon_transactions;
```

```sql
-- ===== amazon_transactions / 2 coverage by org/store/upload =====
SELECT organization_id, store_id, upload_id,
  count(*)                                                              AS rows_total,
  count(*) FILTER (WHERE resolved_product_id IS NOT NULL)               AS rows_resolved,
  count(*) FILTER (WHERE resolved_product_id IS NULL)                   AS rows_unresolved,
  count(*) FILTER (WHERE store_id IS NULL)                              AS rows_store_null,
  count(*) FILTER (WHERE sku IS NULL AND order_id IS NULL)              AS rows_no_identifiers
FROM public.amazon_transactions
GROUP BY 1, 2, 3
ORDER BY rows_unresolved DESC
LIMIT 200;
```

```sql
-- ===== amazon_transactions / 3 recoverability by active PIM (native SKU only) =====
WITH tgt AS (
  SELECT t.id, t.organization_id, t.store_id, t.sku
  FROM public.amazon_transactions t
  WHERE t.resolved_product_id IS NULL AND t.store_id IS NOT NULL AND t.sku IS NOT NULL
), c AS (
  SELECT tgt.*,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL AND p.seller_sku = tgt.sku) AS n_sku
  FROM tgt
)
SELECT
  count(*)                                AS unresolved_with_sku,
  count(*) FILTER (WHERE n_sku = 1)       AS exact_one_via_sku,
  count(*) FILTER (WHERE n_sku = 0)       AS no_match_via_sku,
  count(*) FILTER (WHERE n_sku > 1)       AS ambiguous_via_sku
FROM c;
```

```sql
-- ===== amazon_transactions / 3' optional recoverability via amazon_all_orders.order_id =====
-- Covers the simple-summary-file slice where `sku` is NULL but `order_id` is present.
WITH tgt AS (
  SELECT t.id, t.organization_id, t.store_id, t.order_id,
         coalesce(t.sku, o.sku) AS sku
  FROM public.amazon_transactions t
  LEFT JOIN public.amazon_all_orders o
    ON o.organization_id = t.organization_id
   AND o.store_id IS NOT DISTINCT FROM t.store_id
   AND o.amazon_order_id = t.order_id
  WHERE t.resolved_product_id IS NULL
    AND t.store_id IS NOT NULL
    AND t.order_id IS NOT NULL
    AND t.sku IS NULL
), c AS (
  SELECT tgt.*,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL AND p.seller_sku = tgt.sku
         AND tgt.sku IS NOT NULL) AS n_sku
  FROM tgt
)
SELECT
  count(*)                                AS unresolved_via_order_join_total,
  count(*) FILTER (WHERE sku IS NOT NULL) AS rows_recovered_sku_via_order,
  count(*) FILTER (WHERE n_sku = 1)       AS exact_one_via_order_join,
  count(*) FILTER (WHERE n_sku = 0)       AS no_match_via_order_join,
  count(*) FILTER (WHERE n_sku > 1)       AS ambiguous_via_order_join
FROM c;
```

```sql
-- ===== amazon_transactions / 4a top-50 ambiguous SKUs =====
SELECT t.organization_id, t.store_id, t.sku AS identifier,
       (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.seller_sku = t.sku) AS candidate_product_count,
       count(*) AS affected_row_count
FROM public.amazon_transactions t
WHERE t.resolved_product_id IS NULL AND t.sku IS NOT NULL AND t.store_id IS NOT NULL
GROUP BY 1, 2, 3
HAVING (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.seller_sku = t.sku) > 1
ORDER BY affected_row_count DESC LIMIT 50;
```

```sql
-- ===== amazon_transactions / 5 store-gap (store_id NULL) =====
SELECT organization_id, upload_id,
  count(*)                                            AS rows_store_null,
  count(*) FILTER (WHERE resolved_product_id IS NULL) AS rows_store_null_unresolved
FROM public.amazon_transactions
WHERE store_id IS NULL
GROUP BY 1, 2
ORDER BY rows_store_null DESC
LIMIT 200;
```

---

### 8) `amazon_reports_repository`

Notes — **different column convention**:
- Resolver product column: `product_id` (canonical).
- Resolver catalog column: `catalog_product_id`.
- Status / confidence: `product_match_method`, `product_match_confidence`, `product_matched_at`.
- Upload column: `upload_id`.
- Native identifiers: `sku`, `order_id`. **No native `asin` or `fnsku`** — ASIN may be in `raw_data` only. SKU is the only safe write-back identifier.
- `store_id` populated for new rows post NEXT-04; historical rows may be NULL.

```sql
-- ===== amazon_reports_repository / 1 coverage =====
SELECT
  count(*)                                                              AS rows_total,
  count(*) FILTER (WHERE product_id IS NOT NULL)                        AS rows_with_product,
  count(*) FILTER (WHERE catalog_product_id IS NOT NULL)                AS rows_with_catalog,
  count(*) FILTER (WHERE product_id IS NULL)                            AS rows_unresolved,
  count(*) FILTER (WHERE organization_id IS NOT NULL)                   AS rows_with_org,
  count(*) FILTER (WHERE store_id IS NOT NULL)                          AS rows_with_store,
  count(DISTINCT organization_id)                                       AS distinct_orgs,
  count(DISTINCT store_id)                                              AS distinct_stores,
  count(DISTINCT upload_id)                                             AS distinct_uploads,
  count(*) FILTER (WHERE product_match_method IS NOT NULL)              AS rows_with_match_method
FROM public.amazon_reports_repository;
```

```sql
-- ===== amazon_reports_repository / 2 coverage by org/store/upload =====
SELECT organization_id, store_id, upload_id,
  count(*)                                                              AS rows_total,
  count(*) FILTER (WHERE product_id IS NOT NULL)                        AS rows_resolved,
  count(*) FILTER (WHERE product_id IS NULL)                            AS rows_unresolved,
  count(*) FILTER (WHERE store_id IS NULL)                              AS rows_store_null
FROM public.amazon_reports_repository
GROUP BY 1, 2, 3
ORDER BY rows_unresolved DESC
LIMIT 200;
```

```sql
-- ===== amazon_reports_repository / 3 recoverability by active PIM (SKU only — native) =====
WITH tgt AS (
  SELECT t.id, t.organization_id, t.store_id, t.sku
  FROM public.amazon_reports_repository t
  WHERE t.product_id IS NULL AND t.store_id IS NOT NULL AND t.sku IS NOT NULL
), c AS (
  SELECT tgt.*,
    (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
       WHERE p.organization_id = tgt.organization_id
         AND p.store_id IS NOT DISTINCT FROM tgt.store_id
         AND p.deleted_at IS NULL AND p.seller_sku = tgt.sku) AS n_sku
  FROM tgt
)
SELECT
  count(*)                                AS unresolved_with_sku,
  count(*) FILTER (WHERE n_sku = 1)       AS exact_one_via_sku,
  count(*) FILTER (WHERE n_sku = 0)       AS no_match_via_sku,
  count(*) FILTER (WHERE n_sku > 1)       AS ambiguous_via_sku
FROM c;
```

```sql
-- ===== amazon_reports_repository / 4a top-50 ambiguous SKUs =====
SELECT t.organization_id, t.store_id, t.sku AS identifier,
       (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.seller_sku = t.sku) AS candidate_product_count,
       count(*) AS affected_row_count
FROM public.amazon_reports_repository t
WHERE t.product_id IS NULL AND t.sku IS NOT NULL AND t.store_id IS NOT NULL
GROUP BY 1, 2, 3
HAVING (SELECT count(DISTINCT p.product_id) FROM public.product_identifier_map p
          WHERE p.organization_id = t.organization_id
            AND p.store_id IS NOT DISTINCT FROM t.store_id
            AND p.deleted_at IS NULL AND p.seller_sku = t.sku) > 1
ORDER BY affected_row_count DESC LIMIT 50;
```

```sql
-- ===== amazon_reports_repository / 5 store-gap (store_id NULL) =====
SELECT organization_id, upload_id,
  count(*)                                  AS rows_store_null,
  count(*) FILTER (WHERE product_id IS NULL) AS rows_store_null_unresolved
FROM public.amazon_reports_repository
WHERE store_id IS NULL
GROUP BY 1, 2
ORDER BY rows_store_null DESC
LIMIT 200;
```

---

### Operator workflow

1. Run sections 1, 2, 3, 4 first (smallest tables expected).
2. For sections 5 (all_orders), 6 (settlements), 7 (transactions), 8 (reports_repository), the recoverability and ambiguity blocks may need scoping by `t.organization_id` and `t.upload_id` if the unscoped query is slow. Add the predicates before the `GROUP BY` clause.
3. For each block, capture the result panel as CSV with the `# <table>/<report>` label so labels survive collation.
4. Send the labelled CSVs back to ChatGPT. Specifically required:
   - report `1 coverage` for all 8 tables
   - report `2 coverage by org/store/upload` for all 8 tables
   - report `3 recoverability` for all 8 tables (and `3'` for amazon_transactions)
   - reports `4a/4b/4c` ambiguity for the four high-identifier tables (AFI / ledger / manage_fba / fba)
   - report `4a` ambiguity SKU for the SKU-only tables (all_orders / settlements / transactions / reports_repository)
   - report `5 store-gap` for all 8 tables

### Hard rules (re-iterated)

- All queries are SELECT-only.
- Every `product_identifier_map` join filters `p.deleted_at IS NULL`.
- No UPDATE / INSERT / DELETE / ALTER / CREATE anywhere.
- `product_name` and `title` are not used as match keys.
- `upc_code` is intentionally not used as a write-back key in this audit (non-unique by design per [`supabase/migrations/20260630130000_product_identity_existing_tables.sql:62`](supabase/migrations/20260630130000_product_identity_existing_tables.sql)). If UPC coverage measurement is wanted later, it should be its own report.
- `amazon_reports_repository` queries respect the canonical `product_id`/`catalog_product_id`/`product_match_method`/`product_match_confidence`/`product_matched_at` convention; all other tables use the `resolved_product_id`/`resolved_catalog_product_id`/`identifier_resolution_status`/`identifier_resolution_confidence` convention.

Plan only. No edits.