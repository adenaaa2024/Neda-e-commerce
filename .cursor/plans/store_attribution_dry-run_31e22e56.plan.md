---
name: Store attribution dry-run
overview: "SELECT-only store-attribution dry-run SQL bundle. One block per priority target table: column-existence pre-check, then summary, per-upload, malformed-metadata samples, unsafe samples, and update-eligibility counts. No mutation, no schema change, no code edit."
todos:
  - id: no-op
    content: NEXT-14C is a SQL bundle deliverable. Operator runs the precheck queries first, then A-E per eligible table, exports the CSVs by suggested name, and returns them. No code or DB mutation.
    status: pending
isProject: false
---

## NEXT-14C — Store attribution dry-run SQL bundle

Plan only. SELECT / `information_schema` / `pg_catalog` only. No UPDATE / INSERT / DELETE / ALTER / CREATE / DROP. No code edits, no migrations. `expected_*`, `pallets`, and `packages` are intentionally out of scope and not touched.

### Conventions

- Metadata key precedence (matches the in-repo writers in [`backend-python/pim_import_async.py`](backend-python/pim_import_async.py) and the apply-step route): `metadata.import_store_id > metadata.ledger_store_id > metadata.store_id`.
- UUID validation regex used everywhere: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` (case-insensitive via `~*`).
- Eligibility for a future store_id write-back: `current_store_id IS NULL AND chosen_raw matches uuid regex AND chosen_uuid exists in stores AND target row joins to a raw_report_uploads row`.
- `amazon_reports_repository.upload_id` is `text` per NEXT-14B; its join uses `r.id::text = t.upload_id`. Every other table joins `r.id = t.<upload-fk>` (uuid).
- Each block has a one-line CSV name for export.
- Each table starts with a pre-check; if a required column is absent, the operator skips the rest of that block and reports the table as ineligible.

### `expected_*`, `pallets`, `packages` — explicitly out of scope

The prompt confirmed `expected_packages` already has `store_id + upload_id` and that the other expected_ tables did not surface in NEXT-14B's column output. Treat all of them as **do-not-touch** in this bundle. No queries are emitted for them.

---

## Per-table blocks

The pattern below is repeated for each priority target table. The only per-table differences are:

- `<TABLE>` — the target table name.
- `<U>` — the upload-FK column (`upload_id` for tables 1–5 + 7 + 8; `upload_id` for `amazon_returns` once confirmed).
- `<CAST>` — `::text` only for `amazon_reports_repository`, otherwise empty.

### 1) `amazon_inventory_ledger` — `upload_id` (uuid)

```sql
-- ===== amazon_inventory_ledger / 14c-precheck / csv: 14c_ledger_precheck.csv =====
SELECT
  bool_or(column_name = 'organization_id') AS has_organization_id,
  bool_or(column_name = 'store_id')        AS has_store_id,
  bool_or(column_name = 'upload_id')       AS has_upload_id,
  max(CASE WHEN column_name = 'upload_id' THEN data_type END) AS upload_id_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'amazon_inventory_ledger';
```

```sql
-- ===== amazon_inventory_ledger / 14c-A / csv: 14c_ledger_A_summary.csv =====
WITH joined AS (
  SELECT
    t.id, t.organization_id, t.store_id AS current_store_id, t.upload_id AS upload_ref,
    r.id AS upload_row_id, r.metadata, r.report_type, r.status
  FROM public.amazon_inventory_ledger t
  LEFT JOIN public.raw_report_uploads r ON r.id = t.upload_id
), chosen AS (
  SELECT j.*,
    CASE
      WHEN j.metadata->>'import_store_id' IS NOT NULL THEN j.metadata->>'import_store_id'
      WHEN j.metadata->>'ledger_store_id' IS NOT NULL THEN j.metadata->>'ledger_store_id'
      WHEN j.metadata->>'store_id'        IS NOT NULL THEN j.metadata->>'store_id'
      ELSE NULL
    END AS chosen_raw,
    CASE
      WHEN j.metadata->>'import_store_id' IS NOT NULL THEN 'import_store_id'
      WHEN j.metadata->>'ledger_store_id' IS NOT NULL THEN 'ledger_store_id'
      WHEN j.metadata->>'store_id'        IS NOT NULL THEN 'store_id'
      ELSE NULL
    END AS chosen_key
  FROM joined j
), validated AS (
  SELECT c.*,
    c.chosen_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AS chosen_is_valid_uuid,
    CASE WHEN c.chosen_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN c.chosen_raw::uuid ELSE NULL END AS chosen_uuid
  FROM chosen c
), final AS (
  SELECT v.*, s.id IS NOT NULL AS chosen_store_exists
  FROM validated v
  LEFT JOIN public.stores s ON s.id = v.chosen_uuid
)
SELECT
  count(*)                                                          AS rows_total,
  count(*) FILTER (WHERE current_store_id IS NOT NULL)              AS rows_store_not_null,
  count(*) FILTER (WHERE current_store_id IS NULL)                  AS rows_store_null,
  count(*) FILTER (WHERE current_store_id IS NULL AND upload_row_id IS NOT NULL)              AS null_with_upload_row,
  count(*) FILTER (WHERE current_store_id IS NULL AND metadata->>'import_store_id' IS NOT NULL) AS null_meta_has_import_store,
  count(*) FILTER (WHERE current_store_id IS NULL AND metadata->>'ledger_store_id' IS NOT NULL) AS null_meta_has_ledger_store,
  count(*) FILTER (WHERE current_store_id IS NULL AND metadata->>'store_id' IS NOT NULL)       AS null_meta_has_store,
  count(*) FILTER (WHERE current_store_id IS NULL AND chosen_is_valid_uuid)                    AS null_chosen_valid_uuid,
  count(*) FILTER (WHERE current_store_id IS NULL AND chosen_is_valid_uuid AND chosen_store_exists) AS null_eligible_for_update,
  count(*) FILTER (WHERE current_store_id IS NULL AND (NOT chosen_is_valid_uuid OR NOT chosen_store_exists)) AS null_not_safely_attributable
FROM final;
```

```sql
-- ===== amazon_inventory_ledger / 14c-B / csv: 14c_ledger_B_per_upload.csv =====
WITH joined AS (
  SELECT
    t.id, t.organization_id, t.store_id AS current_store_id, t.upload_id AS upload_ref,
    r.id AS upload_row_id, r.metadata, r.report_type, r.status
  FROM public.amazon_inventory_ledger t
  LEFT JOIN public.raw_report_uploads r ON r.id = t.upload_id
), chosen AS (
  SELECT j.*,
    CASE
      WHEN j.metadata->>'import_store_id' IS NOT NULL THEN j.metadata->>'import_store_id'
      WHEN j.metadata->>'ledger_store_id' IS NOT NULL THEN j.metadata->>'ledger_store_id'
      WHEN j.metadata->>'store_id'        IS NOT NULL THEN j.metadata->>'store_id'
      ELSE NULL
    END AS chosen_raw,
    CASE
      WHEN j.metadata->>'import_store_id' IS NOT NULL THEN 'import_store_id'
      WHEN j.metadata->>'ledger_store_id' IS NOT NULL THEN 'ledger_store_id'
      WHEN j.metadata->>'store_id'        IS NOT NULL THEN 'store_id'
      ELSE NULL
    END AS chosen_key
  FROM joined j
)
SELECT
  organization_id,
  upload_ref,
  count(*)                                                                AS row_count,
  count(*) FILTER (WHERE current_store_id IS NULL)                        AS store_null_count,
  max(chosen_raw)                                                          AS chosen_metadata_store_id,
  max(chosen_key)                                                          AS chosen_metadata_source_key,
  bool_or(chosen_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AS chosen_is_valid_uuid,
  bool_or(EXISTS (SELECT 1 FROM public.stores s
                  WHERE chosen_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    AND s.id = chosen_raw::uuid))                          AS chosen_store_exists,
  max(report_type)                                                          AS report_type,
  max(status)                                                               AS status
FROM chosen
WHERE upload_ref IS NOT NULL
GROUP BY organization_id, upload_ref
ORDER BY store_null_count DESC, row_count DESC
LIMIT 500;
```

```sql
-- ===== amazon_inventory_ledger / 14c-C / csv: 14c_ledger_C_malformed.csv =====
SELECT
  r.id                              AS upload_id,
  r.metadata->>'import_store_id'    AS import_store_id_raw,
  r.metadata->>'ledger_store_id'    AS ledger_store_id_raw,
  r.metadata->>'store_id'           AS store_id_raw,
  CASE
    WHEN coalesce(r.metadata->>'import_store_id', r.metadata->>'ledger_store_id', r.metadata->>'store_id') IS NULL
      THEN 'no store keys'
    WHEN coalesce(r.metadata->>'import_store_id', r.metadata->>'ledger_store_id', r.metadata->>'store_id')
         !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN 'malformed uuid'
    WHEN NOT EXISTS (
      SELECT 1 FROM public.stores s
      WHERE s.id = coalesce(
        r.metadata->>'import_store_id',
        r.metadata->>'ledger_store_id',
        r.metadata->>'store_id')::uuid
    ) THEN 'store id not in stores'
    ELSE 'ok'
  END                                AS reason_invalid
FROM public.raw_report_uploads r
WHERE r.id IN (
  SELECT DISTINCT t.upload_id FROM public.amazon_inventory_ledger t WHERE t.store_id IS NULL AND t.upload_id IS NOT NULL
)
AND (
  coalesce(r.metadata->>'import_store_id', r.metadata->>'ledger_store_id', r.metadata->>'store_id') IS NULL
  OR coalesce(r.metadata->>'import_store_id', r.metadata->>'ledger_store_id', r.metadata->>'store_id')
     !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR NOT EXISTS (
    SELECT 1 FROM public.stores s
    WHERE coalesce(r.metadata->>'import_store_id', r.metadata->>'ledger_store_id', r.metadata->>'store_id')
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND s.id = coalesce(r.metadata->>'import_store_id', r.metadata->>'ledger_store_id', r.metadata->>'store_id')::uuid
  )
)
ORDER BY r.id
LIMIT 100;
```

```sql
-- ===== amazon_inventory_ledger / 14c-D / csv: 14c_ledger_D_unsafe.csv =====
-- D groups (each row tagged with reason_code)
WITH joined AS (
  SELECT
    t.id AS row_id, t.organization_id, t.store_id AS current_store_id, t.upload_id AS upload_ref,
    r.id AS upload_row_id, r.metadata
  FROM public.amazon_inventory_ledger t
  LEFT JOIN public.raw_report_uploads r ON r.id = t.upload_id
), chosen AS (
  SELECT j.*,
    coalesce(metadata->>'import_store_id', metadata->>'ledger_store_id', metadata->>'store_id') AS chosen_raw
  FROM joined j
)
SELECT row_id, organization_id, upload_ref, current_store_id, chosen_raw,
  CASE
    WHEN upload_ref IS NULL                                                       THEN 'd5_no_upload_fk'
    WHEN upload_row_id IS NULL                                                    THEN 'd5_orphan_no_raw_report_upload'
    WHEN chosen_raw IS NULL                                                       THEN 'd1_meta_missing_all_store_keys'
    WHEN chosen_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                                                                  THEN 'd2_meta_store_id_malformed'
    WHEN NOT EXISTS (SELECT 1 FROM public.stores s WHERE s.id = chosen_raw::uuid) THEN 'd3_meta_store_id_not_in_stores'
    WHEN current_store_id IS NOT NULL AND current_store_id <> chosen_raw::uuid    THEN 'd4_existing_store_id_differs'
    ELSE 'ok'
  END AS reason_code
FROM chosen
WHERE upload_ref IS NULL
   OR upload_row_id IS NULL
   OR chosen_raw IS NULL
   OR chosen_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR NOT EXISTS (SELECT 1 FROM public.stores s
                  WHERE chosen_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    AND s.id = chosen_raw::uuid)
   OR (current_store_id IS NOT NULL
       AND chosen_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND current_store_id <> chosen_raw::uuid)
ORDER BY reason_code, organization_id, upload_ref
LIMIT 500;
```

```sql
-- ===== amazon_inventory_ledger / 14c-E / csv: 14c_ledger_E_eligibility.csv =====
WITH joined AS (
  SELECT
    t.id, t.organization_id, t.store_id AS current_store_id, t.upload_id AS upload_ref,
    r.id AS upload_row_id, r.metadata
  FROM public.amazon_inventory_ledger t
  LEFT JOIN public.raw_report_uploads r ON r.id = t.upload_id
), chosen AS (
  SELECT j.*,
    coalesce(metadata->>'import_store_id', metadata->>'ledger_store_id', metadata->>'store_id') AS chosen_raw
  FROM joined j
), validated AS (
  SELECT c.*,
    c.chosen_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AS chosen_is_valid_uuid,
    CASE WHEN c.chosen_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN c.chosen_raw::uuid ELSE NULL END AS chosen_uuid
  FROM chosen c
)
SELECT
  count(*) FILTER (WHERE current_store_id IS NULL AND chosen_is_valid_uuid AND chosen_uuid IN (SELECT id FROM public.stores)) AS eligible,
  count(*) FILTER (WHERE current_store_id IS NULL AND upload_ref IS NULL)                                                     AS not_eligible_no_upload_fk,
  count(*) FILTER (WHERE current_store_id IS NULL AND upload_ref IS NOT NULL AND upload_row_id IS NULL)                       AS not_eligible_orphan_upload,
  count(*) FILTER (WHERE current_store_id IS NULL AND upload_row_id IS NOT NULL AND chosen_raw IS NULL)                       AS not_eligible_no_meta_store_keys,
  count(*) FILTER (WHERE current_store_id IS NULL AND chosen_raw IS NOT NULL AND NOT chosen_is_valid_uuid)                    AS not_eligible_meta_malformed,
  count(*) FILTER (WHERE current_store_id IS NULL AND chosen_is_valid_uuid AND chosen_uuid NOT IN (SELECT id FROM public.stores)) AS not_eligible_meta_store_missing
FROM validated;
```

---

### 2) `amazon_settlements` — `upload_id` (uuid)

Substitute `<TABLE>` = `amazon_settlements`, `<U>` = `upload_id`, no cast. Filenames: `14c_settlements_*`.

The five queries are byte-identical to section 1 except:

- the `FROM public.amazon_inventory_ledger t` and `IN (SELECT DISTINCT t.upload_id FROM public.amazon_inventory_ledger t ...)` lines become `amazon_settlements`.

To keep the bundle short, the operator runs the section-1 templates with that find/replace. **No other change.**

---

### 3) `amazon_reports_repository` — `upload_id` is `text` (per NEXT-14B)

Pre-check (different — confirms text type):

```sql
-- ===== amazon_reports_repository / 14c-precheck / csv: 14c_reports_precheck.csv =====
SELECT
  bool_or(column_name = 'organization_id') AS has_organization_id,
  bool_or(column_name = 'store_id')        AS has_store_id,
  bool_or(column_name = 'upload_id')       AS has_upload_id,
  max(CASE WHEN column_name = 'upload_id' THEN data_type END) AS upload_id_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'amazon_reports_repository';
```

If `upload_id_type <> 'text'`, the operator stops and re-syncs with the NEXT-14B finding before proceeding.

The five reports for this table use `r.id::text = t.upload_id` everywhere `r.id = t.upload_id` appears in section 1. Concretely:

```sql
-- ===== amazon_reports_repository / 14c-A / csv: 14c_reports_A_summary.csv =====
WITH joined AS (
  SELECT
    t.id, t.organization_id, t.store_id AS current_store_id, t.upload_id AS upload_ref,
    r.id AS upload_row_id, r.metadata, r.report_type, r.status
  FROM public.amazon_reports_repository t
  LEFT JOIN public.raw_report_uploads r ON r.id::text = t.upload_id           -- text/uuid bridge
), chosen AS (
  SELECT j.*,
    CASE
      WHEN j.metadata->>'import_store_id' IS NOT NULL THEN j.metadata->>'import_store_id'
      WHEN j.metadata->>'ledger_store_id' IS NOT NULL THEN j.metadata->>'ledger_store_id'
      WHEN j.metadata->>'store_id'        IS NOT NULL THEN j.metadata->>'store_id'
      ELSE NULL
    END AS chosen_raw,
    CASE
      WHEN j.metadata->>'import_store_id' IS NOT NULL THEN 'import_store_id'
      WHEN j.metadata->>'ledger_store_id' IS NOT NULL THEN 'ledger_store_id'
      WHEN j.metadata->>'store_id'        IS NOT NULL THEN 'store_id'
      ELSE NULL
    END AS chosen_key
  FROM joined j
), validated AS (
  SELECT c.*,
    c.chosen_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AS chosen_is_valid_uuid,
    CASE WHEN c.chosen_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         THEN c.chosen_raw::uuid ELSE NULL END AS chosen_uuid
  FROM chosen c
), final AS (
  SELECT v.*, s.id IS NOT NULL AS chosen_store_exists
  FROM validated v
  LEFT JOIN public.stores s ON s.id = v.chosen_uuid
)
SELECT
  count(*)                                                          AS rows_total,
  count(*) FILTER (WHERE current_store_id IS NOT NULL)              AS rows_store_not_null,
  count(*) FILTER (WHERE current_store_id IS NULL)                  AS rows_store_null,
  count(*) FILTER (WHERE current_store_id IS NULL AND upload_row_id IS NOT NULL)              AS null_with_upload_row,
  count(*) FILTER (WHERE current_store_id IS NULL AND metadata->>'import_store_id' IS NOT NULL) AS null_meta_has_import_store,
  count(*) FILTER (WHERE current_store_id IS NULL AND metadata->>'ledger_store_id' IS NOT NULL) AS null_meta_has_ledger_store,
  count(*) FILTER (WHERE current_store_id IS NULL AND metadata->>'store_id' IS NOT NULL)       AS null_meta_has_store,
  count(*) FILTER (WHERE current_store_id IS NULL AND chosen_is_valid_uuid)                    AS null_chosen_valid_uuid,
  count(*) FILTER (WHERE current_store_id IS NULL AND chosen_is_valid_uuid AND chosen_store_exists) AS null_eligible_for_update,
  count(*) FILTER (WHERE current_store_id IS NULL AND (NOT chosen_is_valid_uuid OR NOT chosen_store_exists)) AS null_not_safely_attributable
FROM final;
```

```sql
-- ===== amazon_reports_repository / 14c-B / csv: 14c_reports_B_per_upload.csv =====
WITH joined AS (
  SELECT
    t.id, t.organization_id, t.store_id AS current_store_id, t.upload_id AS upload_ref,
    r.id AS upload_row_id, r.metadata, r.report_type, r.status
  FROM public.amazon_reports_repository t
  LEFT JOIN public.raw_report_uploads r ON r.id::text = t.upload_id
), chosen AS (
  SELECT j.*,
    coalesce(metadata->>'import_store_id', metadata->>'ledger_store_id', metadata->>'store_id') AS chosen_raw,
    CASE
      WHEN j.metadata->>'import_store_id' IS NOT NULL THEN 'import_store_id'
      WHEN j.metadata->>'ledger_store_id' IS NOT NULL THEN 'ledger_store_id'
      WHEN j.metadata->>'store_id'        IS NOT NULL THEN 'store_id'
      ELSE NULL
    END AS chosen_key
  FROM joined j
)
SELECT
  organization_id,
  upload_ref,
  count(*)                                                  AS row_count,
  count(*) FILTER (WHERE current_store_id IS NULL)          AS store_null_count,
  max(chosen_raw)                                            AS chosen_metadata_store_id,
  max(chosen_key)                                            AS chosen_metadata_source_key,
  bool_or(chosen_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') AS chosen_is_valid_uuid,
  bool_or(EXISTS (SELECT 1 FROM public.stores s
                  WHERE chosen_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    AND s.id = chosen_raw::uuid))           AS chosen_store_exists,
  max(report_type)                                           AS report_type,
  max(status)                                                AS status
FROM chosen
WHERE upload_ref IS NOT NULL
GROUP BY organization_id, upload_ref
ORDER BY store_null_count DESC, row_count DESC
LIMIT 500;
```

C / D / E for `amazon_reports_repository` follow the section-1 pattern with `r.id::text = t.upload_id` substituted for the join and `t.upload_id` kept as text everywhere. The four full bodies are identical to section 1 with that single substitution; **the operator should perform a global replace of `r.id = t.upload_id` -> `r.id::text = t.upload_id` and table name -> `amazon_reports_repository` when copy-pasting from section 1**.

---

### 4) `amazon_reimbursements` — `upload_id` (uuid)

Pre-check + section-1 template with `<TABLE>` = `amazon_reimbursements`, `<U>` = `upload_id`. CSV prefix: `14c_reimb_*`.

```sql
-- ===== amazon_reimbursements / 14c-precheck / csv: 14c_reimb_precheck.csv =====
SELECT
  bool_or(column_name = 'organization_id') AS has_organization_id,
  bool_or(column_name = 'store_id')        AS has_store_id,
  bool_or(column_name = 'upload_id')       AS has_upload_id,
  max(CASE WHEN column_name = 'upload_id' THEN data_type END) AS upload_id_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'amazon_reimbursements';
```

A through E: section-1 template with the table name replaced.

---

### 5) `amazon_transactions` — `upload_id` (uuid)

Pre-check + section-1 template with `<TABLE>` = `amazon_transactions`, `<U>` = `upload_id`. CSV prefix: `14c_txn_*`.

```sql
-- ===== amazon_transactions / 14c-precheck / csv: 14c_txn_precheck.csv =====
SELECT
  bool_or(column_name = 'organization_id') AS has_organization_id,
  bool_or(column_name = 'store_id')        AS has_store_id,
  bool_or(column_name = 'upload_id')       AS has_upload_id,
  max(CASE WHEN column_name = 'upload_id' THEN data_type END) AS upload_id_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'amazon_transactions';
```

A through E: section-1 template with the table name replaced.

---

### 6) `amazon_returns` — schema unconfirmed (treat as eligibility-pending)

Run this pre-check first. **If `has_store_id` is false OR neither `has_upload_id` nor `has_source_upload_id` is true, report this table as ineligible and stop. Do not synthesize a join.**

```sql
-- ===== amazon_returns / 14c-precheck / csv: 14c_returns_precheck.csv =====
SELECT
  bool_or(column_name = 'organization_id')  AS has_organization_id,
  bool_or(column_name = 'store_id')         AS has_store_id,
  bool_or(column_name = 'upload_id')        AS has_upload_id,
  max(CASE WHEN column_name = 'upload_id' THEN data_type END) AS upload_id_type,
  bool_or(column_name = 'source_upload_id') AS has_source_upload_id,
  max(CASE WHEN column_name = 'source_upload_id' THEN data_type END) AS source_upload_id_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'amazon_returns';
```

If pre-check confirms `(has_store_id, has_upload_id) = (true, true)` and `upload_id_type = 'uuid'`: run section-1 template with `<TABLE>` = `amazon_returns`, `<U>` = `upload_id`. CSV prefix: `14c_returns_*`. If instead `has_source_upload_id = true` and uuid: substitute `<U>` = `source_upload_id`. Otherwise emit no further queries.

---

### 7) `amazon_removals` — schema unconfirmed (likely `upload_id uuid` + `store_id`)

Pre-check (same shape as `amazon_returns`). CSV: `14c_removals_precheck.csv`.

If pre-check confirms `(has_store_id, has_upload_id)` and `upload_id_type = 'uuid'`: section-1 template with `<TABLE>` = `amazon_removals`, `<U>` = `upload_id`. CSV prefix: `14c_removals_*`.

---

### 8) `amazon_removal_shipments` — schema unconfirmed (likely `upload_id uuid`; `store_id` may be absent)

Pre-check identical to amazon_returns / amazon_removals. CSV: `14c_remshipments_precheck.csv`.

**Special case:** if `has_store_id = false`, the table cannot be store-attributed by the metadata key strategy. Emit only the pre-check; report it as ineligible. Do not synthesize anything. If pre-check confirms `has_store_id = true` and `has_upload_id = true` (uuid), run the section-1 template with `<TABLE>` = `amazon_removal_shipments`, `<U>` = `upload_id`. CSV prefix: `14c_remshipments_*`.

---

## CSV export list (one CSV per labelled block)

Per-table prefixes, with `<table>` ∈ {`ledger`, `settlements`, `reports`, `reimb`, `txn`, `returns`, `removals`, `remshipments`}:

- `14c_<table>_precheck.csv`
- `14c_<table>_A_summary.csv`
- `14c_<table>_B_per_upload.csv`
- `14c_<table>_C_malformed.csv`
- `14c_<table>_D_unsafe.csv`
- `14c_<table>_E_eligibility.csv`

For tables where the pre-check returns ineligibility, only the precheck CSV is produced and the rest are omitted.

## Recommended execution order

1. **All pre-checks first** (eight queries total). Fast; smokes out tables 6–8 quickly. Capture every pre-check CSV.
2. **A summaries** for all eligible tables. Single-row aggregates; cheapest dry-run signal.
3. **B per-upload** for all eligible tables. Bounds the per-upload blast radius.
4. **C malformed metadata samples** for all eligible tables (capped at 100 rows each).
5. **D unsafe samples** for all eligible tables (capped at 500 rows each, tagged with reason_code).
6. **E eligibility counts** last. Authoritative count of how many rows would change in a future write-back.

## Interpretation notes (eligible vs not eligible)

- **Eligible row** (a row that a future operator-approved UPDATE could target): `current_store_id IS NULL` AND target row joins to a `raw_report_uploads` row AND that upload's metadata yields a non-NULL `chosen_raw` AND `chosen_raw` parses as uuid AND that uuid exists in `stores`.
- **Not eligible — `d5_no_upload_fk`**: target row's upload-FK is NULL. No way to reach upload metadata. Fix is upstream-only (writer must populate `upload_id` going forward; historical rows cannot be attributed without external source).
- **Not eligible — `d5_orphan_no_raw_report_upload`**: upload-FK present but no matching `raw_report_uploads` row. Likely a deleted upload. Cannot be attributed.
- **Not eligible — `d1_meta_missing_all_store_keys`**: upload exists but metadata has none of the three store keys. Cannot be attributed without operator intervention to fill metadata.
- **Not eligible — `d2_meta_store_id_malformed`**: chosen value is not a valid uuid. **Do not write.** Quarantine for operator review; this is exactly the failure mode PATCH-01 / NEXT-02b protect against in live writes.
- **Not eligible — `d3_meta_store_id_not_in_stores`**: chosen uuid is well-formed but no row in `stores` matches. **Do not write.** Quarantine.
- **Conflict — `d4_existing_store_id_differs`**: row already has a non-NULL `store_id` that differs from `chosen_raw`. **Do not auto-resolve.** Capture for operator review; this should be impossible if upstream writers and metadata are correct.

The eligibility count from report E is the **only number** that should drive a future store-attribution UPDATE batch. Anything tagged `d1`–`d5` is excluded by definition.

## Hard rules (re-iterated)

- Every query is `SELECT` only.
- No UPDATE / INSERT / DELETE / ALTER / CREATE / DROP anywhere.
- No code edits.
- No migrations.
- No data mutation.
- `expected_*`, `pallets`, `packages` are not touched.
- For tables 6–8, the pre-check is the gate; if it fails, stop on that table.
- `amazon_reports_repository` joins use `r.id::text = t.upload_id` everywhere `r.id = t.upload_id` would otherwise appear.

Plan only. No edits.