-- Increase statement_timeout for removal Phase 4 rebuild RPCs (production sync timeout recovery).
-- Vercel Phase 4 calls these via PostgREST; default statement_timeout was too low for full rebuild.

ALTER FUNCTION public.rebuild_removal_item_allocations(uuid, uuid)
  SET statement_timeout = '1800s';

ALTER FUNCTION public.rebuild_shipment_tree_from_removal_shipments(uuid, uuid)
  SET statement_timeout = '1800s';

DO $do$
BEGIN
  IF to_regprocedure('public.rebuild_expected_packages_from_removals(uuid,uuid)') IS NOT NULL THEN
    EXECUTE $sql$
      ALTER FUNCTION public.rebuild_expected_packages_from_removals(uuid, uuid)
        SET statement_timeout = '1800s'
    $sql$;
  END IF;
END
$do$;

COMMENT ON FUNCTION public.rebuild_removal_item_allocations(uuid, uuid) IS
  'FIFO removal_item_allocations rebuild. statement_timeout=1800s for production Phase 4.';
