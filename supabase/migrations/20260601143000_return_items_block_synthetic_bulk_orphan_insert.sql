-- Block synthetic bulk-orphan return_items INSERTs (expected_item_id without physical anchor or operator).
-- Staging lockdown: RETURN-ITEMS-BULK-ORPHAN-LOCKDOWN-JOBS-AND-GUARDS

CREATE OR REPLACE FUNCTION public.trg_return_items_block_synthetic_bulk_orphan_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.expected_item_id IS NOT NULL
     AND NEW.package_id IS NULL
     AND NEW.pallet_id IS NULL
     AND NEW.created_by IS NULL
  THEN
    RAISE EXCEPTION
      'return_items_insert_blocked: expected_item_id requires package_id, pallet_id, or operator created_by'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.trg_return_items_block_synthetic_bulk_orphan_insert() IS
  'Rejects INSERT into return_items when row mirrors bulk-orphan EP materialization (no package/pallet/created_by).';

DROP TRIGGER IF EXISTS trg_return_items_block_synthetic_bulk_orphan_insert ON public.return_items;

CREATE TRIGGER trg_return_items_block_synthetic_bulk_orphan_insert
  BEFORE INSERT ON public.return_items
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_return_items_block_synthetic_bulk_orphan_insert();
