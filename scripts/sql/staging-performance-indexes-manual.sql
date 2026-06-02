-- =============================================================
-- Staging performance indexes — expected_packages tracking
-- Target: eiqfaapyumhixxoeltgu (staging only)
-- Applied: 2026-06-02 via Supabase MCP execute_sql
-- =============================================================
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction.
-- These were applied non-CONCURRENTLY on a 5k-row staging table.
-- For production (larger tables), prefer CONCURRENTLY outside any BEGIN block.

-- ---------------------------------------------------------------
-- Index 1: Compound raw tracking lookup
-- ---------------------------------------------------------------
-- Benefit: removes post-index Filter on (org, store) for exact tracking queries.
-- EXPLAIN before: cost=3.61, Filter on org+store after idx_expected_packages_tracking.
-- EXPLAIN after:  cost=1.89, Index Cond covers org+store, Filter only on tracking_number.
-- Already applied on staging.

CREATE INDEX IF NOT EXISTS idx_ep_org_store_tracking
  ON public.expected_packages (organization_id, store_id, tracking_number)
  WHERE tracking_number IS NOT NULL;

-- Rollback:
-- DROP INDEX CONCURRENTLY IF EXISTS idx_ep_org_store_tracking;

-- ---------------------------------------------------------------
-- Index 2: Normalized tracking token expression index
-- ---------------------------------------------------------------
-- Benefit: supports lower(_normalize_tracking_token(tracking_number)) lookups.
-- Function _normalize_tracking_token is IMMUTABLE (confirmed).
-- On staging (5k rows) planner still uses Seq Scan — correct, table too small.
-- Will engage in production with hundreds-of-thousands of rows.
-- Already applied on staging.

CREATE INDEX IF NOT EXISTS idx_ep_org_store_tracking_token_lower
  ON public.expected_packages (
    organization_id,
    store_id,
    lower(_normalize_tracking_token(tracking_number))
  )
  WHERE tracking_number IS NOT NULL;

-- Rollback:
-- DROP INDEX CONCURRENTLY IF EXISTS idx_ep_org_store_tracking_token_lower;

-- ---------------------------------------------------------------
-- Production notes
-- ---------------------------------------------------------------
-- Run CONCURRENTLY on tables with > 100k rows:
--   SET lock_timeout = '5s';
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ep_org_store_tracking
--     ON public.expected_packages (organization_id, store_id, tracking_number)
--     WHERE tracking_number IS NOT NULL;
-- Run ANALYZE after to update planner statistics.
