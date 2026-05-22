# NEXT-PRODUCT-ID-15 — STAGED UPDATE IMPLEMENTATION (Wave 1a)

<!-- markdownlint-disable MD013 -->

**Status:** Implementation specification only. **Do not** run in Cursor Agent
without a human DBA executing SQL in the correct Supabase project during an
agreed window.

**Prerequisites:** Complete operational signoff from
[NEXT-PRODUCT-ID-14 signoff pack](../audit-reports/next-product-id-14/20260514T020100Z/wave-1a-signed-approval.md)
(Supabase project ref + execution window must be **non-TBD** before execution).

---

## Hard constraints (non-negotiable)

Do **not**:

- `INSERT` / `UPDATE` / `DELETE` on `public.products`
- Create or merge products
- Mutate `public.product_identifier_map`
- Touch rows outside the **638** Wave 1a eligible PK set
- Call Amazon APIs or AI
- Run this spec against a database other than the ticketed target

Do:

- `UPDATE` **only** `public.amazon_fba_inventory` rows whose `id` appears in
  Wave 1a eligible PK list, with `resolved_product_id IS NULL` before update
- Set resolver fields exactly as specified below
- Verify row counts and run post-verify SQL
- Keep preimage CSV for rollback

---

## Frozen scope

| Item | Value |
| --- | --- |
| Table | `public.amazon_fba_inventory` |
| Wave | **1a** |
| Row count | **638** eligible PKs |
| Join file | [wave-1a-eligible-pks.csv](../audit-reports/next-product-id-11/20260513T231500Z/wave-1a-eligible-pks.csv) |
| Columns | `source_row_id` (= `afi.id`), `organization_id`, `store_id`, `existing_product_id_hit` (→ `resolved_product_id`) |
| Dry-run basis | NEXT-PRODUCT-ID-10 pack `20260513T214753Z` |

---

## Step 0 — Preconditions (human)

1. Record **Supabase project ref** and **UTC execution window** on the ticket.
2. Confirm target DB row count for `amazon_fba_inventory` matches expectations
   (reference: 949 live rows in ID-11 summary; **do not** treat as invariant if
   data drifted).
3. Confirm **all** Wave 1a targets still have resolver fields **NULL** (re-run
   pre-check `SELECT` from ID-11 dry-run gate or equivalent).

---

## Step 1 — Pre-image (mandatory)

1. In Supabase SQL editor for the **target** project, run:

   [wave-1a-preimage-select.sql](../audit-reports/next-product-id-11/20260513T231500Z/wave-1a-preimage-select.sql)

2. Export results as **CSV** and attach to the ticket as **Wave 1a preimage**
   (columns must include current `resolved_product_id`,
   `resolved_catalog_product_id`, `identifier_resolution_status`,
   `identifier_resolution_confidence`, `updated_at`, and primary key `id`).

---

## Step 2 — Staging table (load dry-run join)

Create a **temporary or unlogged** staging table in the **same session** as the
`UPDATE`, or a dedicated `wave_1a_staging` table via a one-off approved migration.
**Recommended pattern for SQL editor:**

```sql
-- Example: define columns matching wave-1a-eligible-pks.csv header
CREATE TEMP TABLE wave_1a_staging (
  source_row_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  store_id uuid,
  proposed_product_id uuid NOT NULL
);

-- Load via Supabase Table Editor CSV import OR \copy from client:
-- source_row_id, organization_id, store_id, bucket_id, match_rank, existing_product_id_hit
-- Map existing_product_id_hit -> proposed_product_id
```

Import [wave-1a-eligible-pks.csv](../audit-reports/next-product-id-11/20260513T231500Z/wave-1a-eligible-pks.csv):

- **`source_row_id`** → staging `source_row_id` (join key to `amazon_fba_inventory.id`)
- **`organization_id`** → must match row’s `organization_id`
- **`existing_product_id_hit`** → staging `proposed_product_id` (must be
  existing `products.id`; **no** product creation)

**Validate before UPDATE:**

```sql
SELECT count(*) FROM wave_1a_staging;  -- expect 638
SELECT count(DISTINCT source_row_id) FROM wave_1a_staging;  -- expect 638
```

---

## Step 3 — Staged `UPDATE` (single transaction)

Pattern from
[wave-1a-update-draft_DO_NOT_RUN.sql](../audit-reports/next-product-id-11/20260513T231500Z/wave-1a-update-draft_DO_NOT_RUN.sql).
Adapt table name of staging to your import.

```sql
BEGIN;

UPDATE public.amazon_fba_inventory AS afi
SET
  resolved_product_id = st.proposed_product_id,
  resolved_catalog_product_id = NULL,
  identifier_resolution_status = 'resolved',
  identifier_resolution_confidence = 0.95,
  updated_at = now()
FROM wave_1a_staging AS st
WHERE afi.id = st.source_row_id
  AND afi.organization_id = st.organization_id
  AND afi.resolved_product_id IS NULL;

-- CRITICAL: must report exactly 638 rows updated
GET DIAGNOSTICS updated_ct = ROW_COUNT;
-- In psql: use \echo or SELECT updated_ct pattern appropriate to client

COMMIT;
```

If `ROW_COUNT` ≠ **638**: **`ROLLBACK`** immediately, open incident, do not
commit partial state without explicit approval.

---

## Step 4 — Post-update verification

1. Run [wave-1a-postverify-select.sql](../audit-reports/next-product-id-11/20260513T231500Z/wave-1a-postverify-select.sql)
   in the target project; save output / attach to ticket.
2. Run [04_amazon_fba_inventory_resolver_verify.sql](../../docs/product-identity/sql/04_amazon_fba_inventory_resolver_verify.sql)
   (column presence, index, null fractions as appropriate for post-update state).
3. Confirm **no** rows outside the 638 PK set were modified (e.g. compare
   `updated_at` window + join to eligible list).

---

## Step 5 — Rollback (if required)

Follow [rollback-plan.md](../audit-reports/next-product-id-11/20260513T231500Z/rollback-plan.md):

1. Use **preimage CSV** from Step 1.
2. `UPDATE amazon_fba_inventory` from staging built from preimage, restricted
   to the **638** PKs only, restoring `resolved_product_id`,
   `resolved_catalog_product_id`, `identifier_resolution_status`,
   `identifier_resolution_confidence`, and `updated_at` (per policy).
3. Re-run post-verify adapted for rolled-back state if needed.

---

## Field values (frozen for Wave 1a)

| Column | Value |
| --- | --- |
| `resolved_product_id` | `existing_product_id_hit` from CSV (via staging) |
| `resolved_catalog_product_id` | `NULL` |
| `identifier_resolution_status` | `'resolved'` |
| `identifier_resolution_confidence` | `0.95` |

---

## After success

- Attach verification outputs and final row counts to the ticket.
- Close Wave 1a execution; schedule Wave 1b+ only under a new audit prompt.

---

## References

| Document | Path |
| --- | --- |
| Eligible PKs + dry-run hits | `.cursor/audit-reports/next-product-id-11/20260513T231500Z/wave-1a-eligible-pks.csv` |
| Preimage SELECT | `.cursor/audit-reports/next-product-id-11/20260513T231500Z/wave-1a-preimage-select.sql` |
| Post-verify SELECT | `.cursor/audit-reports/next-product-id-11/20260513T231500Z/wave-1a-postverify-select.sql` |
| UPDATE draft | `.cursor/audit-reports/next-product-id-11/20260513T231500Z/wave-1a-update-draft_DO_NOT_RUN.sql` |
| Resolver verify | `docs/product-identity/sql/04_amazon_fba_inventory_resolver_verify.sql` |
| Rollback plan | `.cursor/audit-reports/next-product-id-11/20260513T231500Z/rollback-plan.md` |
