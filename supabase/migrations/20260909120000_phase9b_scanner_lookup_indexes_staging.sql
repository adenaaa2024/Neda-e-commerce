-- Phase 9B — scanner identity lookup indexes (staging first)
-- Safe: no new tables/columns, no view drops, no scanner_lookup_index table.

-- expected_packages identity columns (org + store scoped exact match)
CREATE INDEX IF NOT EXISTS idx_ep_org_store_fnsku
  ON public.expected_packages (organization_id, store_id, fnsku)
  WHERE fnsku IS NOT NULL AND fnsku <> '';

CREATE INDEX IF NOT EXISTS idx_ep_org_store_sku
  ON public.expected_packages (organization_id, store_id, sku)
  WHERE sku IS NOT NULL AND sku <> '';

CREATE INDEX IF NOT EXISTS idx_ep_org_store_id_slip_contents
  ON public.expected_packages (organization_id, store_id, id_slip_contents)
  WHERE id_slip_contents IS NOT NULL AND id_slip_contents <> '';

-- packages: normalized tracking token for case/whitespace-insensitive lookup
-- _normalize_tracking_token is IMMUTABLE (see 20260830120000_expected_receive_split_item_level.sql)
CREATE INDEX IF NOT EXISTS idx_packages_org_store_tracking_token_lower
  ON public.packages (
    organization_id,
    store_id,
    lower(public._normalize_tracking_token(tracking_number))
  )
  WHERE deleted_at IS NULL
    AND tracking_number IS NOT NULL
    AND tracking_number <> '';

-- Rollback (production / manual):
-- DROP INDEX CONCURRENTLY IF EXISTS idx_ep_org_store_fnsku;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_ep_org_store_sku;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_ep_org_store_id_slip_contents;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_packages_org_store_tracking_token_lower;
