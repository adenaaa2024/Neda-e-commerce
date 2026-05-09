-- 20260808120000_pim_idempotent_import.sql
--
-- Makes PIM Product Master import idempotent for repeated imports.
--
-- Key insight from schema audit:
--   294 ASIN groups share multiple products (correct — multiple seller SKUs per ASIN).
--   ASIN/FNSKU/UPC are NOT unique per product; only seller_sku is.
--   Therefore unique indexes are applied ONLY to seller_sku in identifier_map.
--
-- Changes:
--   1. Soft-delete column on product_identifier_map
--   2. Pre-cleanup: collapse duplicate seller_sku imap rows (0 found in current DB — safe)
--   3. Unique partial index on (org, store, seller_sku) in identifier_map
--   4. Price deduplication unique index
--   5. Merge-tracking columns on products
--   6. Audit table pim_duplicate_groups
--   7. Admin function pim_find_duplicate_products()
--
-- SAFETY: All DDL uses IF NOT EXISTS / DO $$ guards.
-- Nothing touches Amazon report tables (amazon_*, expected_packages, etc.).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Soft-delete column on product_identifier_map
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.product_identifier_map
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

COMMENT ON COLUMN public.product_identifier_map.deleted_at IS
  'Soft-delete: set by duplicate-merge cleanup. Row excluded from active-identifier '
  'lookups (partial indexes use WHERE deleted_at IS NULL).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Pre-cleanup: soft-delete duplicate seller_sku imap rows.
--    ASIN / FNSKU / UPC can legitimately map to multiple products
--    (multiple seller SKUs per ASIN is normal), so only seller_sku is de-duped.
--    Current DB has 0 seller_sku duplicates; this is a no-op but safe.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_now timestamptz := now();
  v_count integer;
BEGIN
  UPDATE public.product_identifier_map t
  SET    deleted_at = v_now
  FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY organization_id, store_id, seller_sku
             ORDER BY updated_at DESC NULLS LAST, id DESC
           ) AS rn
    FROM   public.product_identifier_map
    WHERE  seller_sku IS NOT NULL
      AND  deleted_at IS NULL
      AND  product_id IS NOT NULL
  ) ranked
  WHERE t.id = ranked.id
    AND ranked.rn > 1;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE 'pim_idempotent_import: soft-deleted % duplicate seller_sku imap rows', v_count;
  ELSE
    RAISE NOTICE 'pim_idempotent_import: no duplicate seller_sku imap rows found (clean)';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Unique partial index: one active seller_sku per store in identifier_map.
--    ASIN/FNSKU/UPC intentionally NOT made unique — multiple products share
--    the same ASIN across different seller SKUs (Amazon marketplace norm).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS uq_imap_org_store_sku
  ON public.product_identifier_map (organization_id, store_id, seller_sku)
  WHERE seller_sku IS NOT NULL AND deleted_at IS NULL;

COMMENT ON INDEX public.uq_imap_org_store_sku IS
  'Enforces one active product link per seller_sku per store. '
  'Used by ON CONFLICT DO UPDATE in _pim_upsert_identifier_map.';

-- Useful lookup index for soft-deleted rows (cleanup queries, audit)
CREATE INDEX IF NOT EXISTS idx_imap_org_store_deleted
  ON public.product_identifier_map (organization_id, store_id)
  WHERE deleted_at IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Price deduplication unique index.
--    Same product + amount + currency + source on the same UTC calendar day
--    from a PIM import is a duplicate row from a re-import.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS uq_prices_product_day_amount_source
  ON public.product_prices (
    organization_id,
    store_id,
    product_id,
    amount,
    currency,
    source,
    date_trunc('day', observed_at)
  )
  WHERE source IN ('product_master_import', 'pim_import_async')
     OR source LIKE 'product_master%';

COMMENT ON INDEX public.uq_prices_product_day_amount_source IS
  'Prevents repeated PIM imports from inserting the same price twice on the same day. '
  'Python apply path uses INSERT ... ON CONFLICT DO NOTHING against this index.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Merge-tracking columns on products
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS merged_into_id uuid
    REFERENCES public.products (id) ON DELETE SET NULL;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS merge_status text;

-- Apply check constraint only if column was just added (idempotent guard)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.products'::regclass
      AND conname = 'products_merge_status_check'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_merge_status_check
      CHECK (merge_status IN ('active', 'merged', 'duplicate'));
  END IF;
END $$;

COMMENT ON COLUMN public.products.merged_into_id IS
  'When merge_status=merged, points to the surviving primary product.';
COMMENT ON COLUMN public.products.merge_status IS
  'NULL or active = normal product; merged = de-duplicated into merged_into_id; '
  'duplicate = flagged but not yet merged.';

CREATE INDEX IF NOT EXISTS idx_products_merged_into_id
  ON public.products (organization_id, store_id, merged_into_id)
  WHERE merged_into_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Duplicate-group audit table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.pim_duplicate_groups (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid        NOT NULL,
  store_id             uuid        NOT NULL,
  primary_id           uuid        REFERENCES public.products (id) ON DELETE CASCADE,
  duplicate_ids        uuid[]      NOT NULL,
  shared_identifiers   jsonb       NOT NULL DEFAULT '{}',
  safe_to_merge        boolean     NOT NULL DEFAULT false,
  merge_reason         text,
  merge_status         text        NOT NULL DEFAULT 'pending'
    CHECK (merge_status IN ('pending', 'merged', 'blocked', 'dismissed')),
  detected_at          timestamptz NOT NULL DEFAULT now(),
  merged_at            timestamptz,
  merged_by            uuid        REFERENCES public.profiles (id) ON DELETE SET NULL,
  metadata             jsonb       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_pim_dup_groups_org_store_status
  ON public.pim_duplicate_groups (organization_id, store_id, merge_status);

COMMENT ON TABLE public.pim_duplicate_groups IS
  'Audit log of detected duplicate product groups and their merge outcomes. '
  'Populated by normalizePimProductDuplicates() server action.';

ALTER TABLE public.pim_duplicate_groups ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'pim_duplicate_groups'
      AND policyname = 'pim_dup_groups_org_select'
  ) THEN
    CREATE POLICY pim_dup_groups_org_select
      ON public.pim_duplicate_groups FOR SELECT
      USING (
        organization_id IN (
          SELECT organization_id FROM public.profiles WHERE id = auth.uid()
        )
      );
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. pim_find_duplicate_products()
--
--    Finds true duplicates: products sharing the SAME seller_sku within the
--    same org+store. (ASIN/FNSKU/UPC duplication across products is normal.)
--
--    Also surfaces identifier_map cross-linking: same seller_sku in imap
--    pointing to different product_ids (should not happen after phase-2 fix).
--
--    Returns one row per duplicate group.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.pim_find_duplicate_products(
  p_organization_id uuid,
  p_store_id        uuid
)
RETURNS TABLE (
  primary_id           uuid,
  duplicate_ids        uuid[],
  shared_identifiers   jsonb,
  safe_to_merge        boolean,
  reason               text
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH
  -- Products sharing the same seller_sku (true duplicates; UNIQUE constraint
  -- should prevent this, but check for historical edge cases)
  sku_product_dupes AS (
    SELECT
      sku                                              AS id_val,
      'seller_sku'                                     AS id_type,
      array_agg(id ORDER BY created_at ASC, id ASC)   AS pids
    FROM public.products
    WHERE organization_id = p_organization_id
      AND store_id        = p_store_id
      AND sku IS NOT NULL
      AND deleted_at IS NULL
      AND (merge_status IS NULL OR merge_status = 'active')
    GROUP BY sku
    HAVING count(*) > 1
  ),
  -- Identifier_map: same seller_sku → multiple product_ids (cross-link anomaly)
  sku_imap_dupes AS (
    SELECT
      seller_sku                                               AS id_val,
      'imap_seller_sku'                                        AS id_type,
      array_agg(DISTINCT product_id ORDER BY product_id ASC)  AS pids
    FROM public.product_identifier_map
    WHERE organization_id = p_organization_id
      AND store_id        = p_store_id
      AND seller_sku IS NOT NULL
      AND deleted_at IS NULL
      AND product_id IS NOT NULL
    GROUP BY seller_sku
    HAVING count(DISTINCT product_id) > 1
  ),
  all_groups AS (
    SELECT id_val, id_type, pids FROM sku_product_dupes
    UNION ALL
    SELECT id_val, id_type, pids FROM sku_imap_dupes
  )
  SELECT
    pids[1]                                         AS primary_id,
    pids[2:]                                        AS duplicate_ids,
    jsonb_build_object(id_type, id_val)             AS shared_identifiers,
    -- safe_to_merge: exactly two products share one strong identifier
    (array_length(pids, 1) = 2)                     AS safe_to_merge,
    id_type                                         AS reason
  FROM all_groups
  WHERE array_length(pids, 1) >= 2;
$$;

COMMENT ON FUNCTION public.pim_find_duplicate_products(uuid, uuid) IS
  'Returns duplicate product groups scoped to seller_sku (the only true-unique '
  'identifier per product). ASIN/FNSKU/UPC duplication is NOT flagged as '
  'duplicates because multiple products can legitimately share those values.';

GRANT EXECUTE ON FUNCTION public.pim_find_duplicate_products(uuid, uuid)
  TO service_role, authenticated;

COMMIT;
