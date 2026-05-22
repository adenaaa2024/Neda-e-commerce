-- =============================================================================
-- GUARDED PIM / CATALOG CLEANUP — MANUAL ONLY (do not add as a migration)
-- =============================================================================
-- This file is for human review in Supabase SQL Editor or psql. It does NOT run
-- automatically. Default behavior: all DELETEs match zero rows because the
-- session guard table keeps execute_deletes = false until you flip it.
--
-- Workflow:
--   1. Set v_organization_id (and optionally v_store_id) in §0 below.
--   2. Run only the SELECT blocks in §1 (previews). Review counts and samples.
--   3. Optionally tighten/loosen predicates in §2 to match your intent.
--   4. When satisfied, in the SAME session:  UPDATE _pim_cleanup_guard SET execute_deletes = true;
--   5. Run §2 DELETE statements once. Verify with SELECT counts again.
--   6. For §2: default ROLLBACK at file end undoes any deletes once you enable the guard;
--      replace ROLLBACK with COMMIT only when counts match your intent.
--
-- First full dry run (recommended):
--   BEGIN;
--     \i ... or paste §0 + §1 + §2
--   ROLLBACK;
--
-- Supabase SQL Editor: run BEGIN, then sections, inspect notices, then ROLLBACK
-- or COMMIT explicitly.
-- =============================================================================

-- ── §0 Session guard + parameters (edit UUIDs) ─────────────────────────────

DROP TABLE IF EXISTS _pim_cleanup_guard;

CREATE TEMP TABLE _pim_cleanup_guard (
  execute_deletes boolean NOT NULL
);

INSERT INTO _pim_cleanup_guard (execute_deletes)
VALUES (false);

-- CHANGEME: replace every occurrence of the placeholder org UUID below with yours
-- (search/replace in this file or editor):
--   00000000-0000-0000-0000-000000000000
--
-- Optional: add AND store_id = '...'::uuid to each §1 SELECT and §2 DELETE for one store.
--
-- To allow §2 DELETEs to take effect (same session), run once before §2:
--   UPDATE _pim_cleanup_guard SET execute_deletes = true;
-- Default false => all DELETEs match zero rows (guarded no-op).

-- ── §1 PREVIEW ONLY (safe to run anytime) ──────────────────────────────────

-- Soft-deleted catalog products (PIM hidden rows still in public.products)
SELECT
  p.organization_id,
  p.store_id,
  count(*)::bigint AS soft_deleted_products
FROM public.products p
WHERE p.organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND p.deleted_at IS NOT NULL
  -- AND p.store_id = '00000000-0000-0000-0000-000000000000'::uuid  -- optional
GROUP BY p.organization_id, p.store_id
ORDER BY p.store_id;

-- Sample ids (limit)
SELECT p.id, p.store_id, p.sku, p.product_name, p.deleted_at
FROM public.products p
WHERE p.organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND p.deleted_at IS NOT NULL
ORDER BY p.updated_at DESC NULLS LAST
LIMIT 50;

-- product_identifier_map rows pointing at products soft-deleted in same org/store
SELECT count(*)::bigint AS map_rows_on_soft_deleted_products
FROM public.product_identifier_map m
INNER JOIN public.products p
  ON p.id = m.product_id
  AND p.organization_id = m.organization_id
  AND p.store_id = m.store_id
WHERE m.organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND p.deleted_at IS NOT NULL;

-- product_prices rows for soft-deleted products
SELECT count(*)::bigint AS price_rows_on_soft_deleted_products
FROM public.product_prices pp
INNER JOIN public.products p
  ON p.id = pp.product_id
  AND p.organization_id = pp.organization_id
  AND p.store_id = pp.store_id
WHERE pp.organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND p.deleted_at IS NOT NULL;

-- Orphan bridge rows: map claims a product_id that does not exist (data drift)
SELECT count(*)::bigint AS orphan_product_identifier_map_rows
FROM public.product_identifier_map m
WHERE m.organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND m.product_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.products p WHERE p.id = m.product_id
  );

SELECT m.id, m.store_id, m.product_id, m.seller_sku, m.asin
FROM public.product_identifier_map m
WHERE m.organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND m.product_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = m.product_id)
LIMIT 50;

-- Orphan prices: product_id missing from products (should be rare if FKs enforced)
SELECT count(*)::bigint AS orphan_product_prices_rows
FROM public.product_prices pp
WHERE pp.organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = pp.product_id);

-- ── §2 GUARDED DELETE (no-op until UPDATE _pim_cleanup_guard SET execute_deletes = true) ─
-- Replace UUID literals with your v_organization_id before running.
-- Optional: add AND m.store_id = '...'::uuid on each statement.

BEGIN;

-- 2a) Remove identifier-map rows tied to soft-deleted products (same org/store as product)
DELETE FROM public.product_identifier_map m
USING public.products p, _pim_cleanup_guard g
WHERE g.execute_deletes
  AND p.id = m.product_id
  AND p.organization_id = m.organization_id
  AND p.store_id = m.store_id
  AND p.organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND p.deleted_at IS NOT NULL;

-- 2b) Remove price rows tied to soft-deleted products
DELETE FROM public.product_prices pp
USING public.products p, _pim_cleanup_guard g
WHERE g.execute_deletes
  AND p.id = pp.product_id
  AND p.organization_id = pp.organization_id
  AND p.store_id = pp.store_id
  AND pp.organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND p.deleted_at IS NOT NULL;

-- 2c) Hard-remove soft-deleted product rows (only where deleted_at IS NOT NULL)
DELETE FROM public.products p
USING _pim_cleanup_guard g
WHERE g.execute_deletes
  AND p.organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND p.deleted_at IS NOT NULL;

-- 2d) Orphan product_identifier_map (no product row) — org-scoped
DELETE FROM public.product_identifier_map m
USING _pim_cleanup_guard g
WHERE g.execute_deletes
  AND m.organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND m.product_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = m.product_id);

-- 2e) Orphan product_prices — org-scoped
DELETE FROM public.product_prices pp
USING _pim_cleanup_guard g
WHERE g.execute_deletes
  AND pp.organization_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = pp.product_id);

-- First run with guard false should report DELETE 0 for each. Inspect then:
--   UPDATE _pim_cleanup_guard SET execute_deletes = true;
-- Re-run §2 statements (still inside transaction) if you intend to commit.

ROLLBACK;
-- When you intend to persist, replace ROLLBACK with COMMIT after verification.

-- ── §3 Optional session cleanup ──────────────────────────────────────────────
-- Run when you are done with this session (guard table is TEMP — dropped on disconnect anyway).

-- DROP TABLE IF EXISTS _pim_cleanup_guard;
