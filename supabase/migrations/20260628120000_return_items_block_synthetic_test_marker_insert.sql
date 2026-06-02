-- Block synthetic test/smoke/parity return_items INSERTs (null raw_return_data + script markers).
-- Complements trg_return_items_block_synthetic_bulk_orphan_insert (EP-only bulk rows).

CREATE OR REPLACE FUNCTION public.return_items_field_has_test_marker(p_value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT CASE
    WHEN p_value IS NULL OR btrim(p_value) = '' THEN false
    ELSE lower(btrim(p_value)) LIKE ANY (ARRAY[
      'box-slip-alloc-parity-%',
      'neda-item-level-smoke-%',
      'v2-%'
    ])
      OR lower(btrim(p_value)) LIKE ANY (ARRAY[
        '%test%',
        '%smoke%',
        '%parity%',
        '%phase1-delete-move-parity%',
        '%delete-release-over-scan%',
        '%neda-item-level-receive-smoke%',
        '%neda-scanner-expected-link-write-verify%',
        '%guard noop smoke%',
        '%scanner-claim-smoke%',
        '%test-delete-undo-v2%',
        '%test-box-slip-alloc%',
        '%phase1-delete-move-parity-staging%'
      ])
      OR lower(btrim(p_value)) = ANY (ARRAY[
        'v191 smoke item',
        'phase1-delete-move-parity-smoke'
      ])
  END;
$fn$;

CREATE OR REPLACE FUNCTION public.return_items_row_has_test_marker(
  p_item_name text,
  p_sku text,
  p_fnsku text,
  p_notes text,
  p_product_identifier text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT public.return_items_field_has_test_marker(p_item_name)
      OR public.return_items_field_has_test_marker(p_sku)
      OR public.return_items_field_has_test_marker(p_fnsku)
      OR public.return_items_field_has_test_marker(p_notes)
      OR public.return_items_field_has_test_marker(p_product_identifier);
$fn$;

CREATE OR REPLACE FUNCTION public.trg_return_items_block_synthetic_test_marker_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF NEW.raw_return_data IS NULL
     AND public.return_items_row_has_test_marker(
       NEW.item_name,
       NEW.sku,
       NEW.fnsku,
       NEW.notes,
       NEW.product_identifier
     )
  THEN
    RAISE EXCEPTION
      'return_items_insert_blocked: synthetic test/smoke/parity marker with null raw_return_data'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.trg_return_items_block_synthetic_test_marker_insert() IS
  'Rejects INSERT into return_items when row matches script/smoke/parity markers and raw_return_data is null.';

DROP TRIGGER IF EXISTS trg_return_items_block_synthetic_test_marker_insert ON public.return_items;

CREATE TRIGGER trg_return_items_block_synthetic_test_marker_insert
  BEFORE INSERT ON public.return_items
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_return_items_block_synthetic_test_marker_insert();
