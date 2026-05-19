-- Operator item scan: one row per physical unit scanned into a package (links to slip_contents when matched).

CREATE TABLE IF NOT EXISTS public.package_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES public.packages (id) ON DELETE CASCADE,
  store_id uuid REFERENCES public.stores (id) ON DELETE SET NULL,
  slip_content_id uuid REFERENCES public.slip_contents (id) ON DELETE SET NULL,
  scanned_barcode text NOT NULL,
  match_kind text NOT NULL CHECK (match_kind IN ('fnsku', 'upc', 'unexpected')),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0 AND quantity <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_package_items_package_id
  ON public.package_items (package_id);

CREATE INDEX IF NOT EXISTS idx_package_items_slip_content_id
  ON public.package_items (slip_content_id)
  WHERE slip_content_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_package_items_organization_id
  ON public.package_items (organization_id);

COMMENT ON TABLE public.package_items IS
  'Physical units scanned during operator ITEM SCAN; optional FK to slip_contents when barcode matched slip line.';

-- Keep packages.actual_item_count aligned with operator line-item scans (returns trigger still handles returns rows).
CREATE OR REPLACE FUNCTION public.sync_package_actual_from_package_items()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  delta integer;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.package_id IS NOT NULL THEN
    delta := COALESCE(NEW.quantity, 1);
    UPDATE public.packages
       SET actual_item_count = actual_item_count + delta
     WHERE id = NEW.package_id;
  ELSIF TG_OP = 'DELETE' AND OLD.package_id IS NOT NULL THEN
    delta := COALESCE(OLD.quantity, 1);
    UPDATE public.packages
       SET actual_item_count = GREATEST(actual_item_count - delta, 0)
     WHERE id = OLD.package_id;
  ELSIF TG_OP = 'UPDATE'
    AND (OLD.package_id IS DISTINCT FROM NEW.package_id OR OLD.quantity IS DISTINCT FROM NEW.quantity)
  THEN
    IF OLD.package_id IS NOT NULL THEN
      UPDATE public.packages
         SET actual_item_count = GREATEST(actual_item_count - COALESCE(OLD.quantity, 1), 0)
       WHERE id = OLD.package_id;
    END IF;
    IF NEW.package_id IS NOT NULL THEN
      UPDATE public.packages
         SET actual_item_count = actual_item_count + COALESCE(NEW.quantity, 1)
       WHERE id = NEW.package_id;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_package_items_sync_actual ON public.package_items;
CREATE TRIGGER trg_package_items_sync_actual
  AFTER INSERT OR DELETE OR UPDATE OF package_id, quantity ON public.package_items
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_package_actual_from_package_items();

ALTER TABLE public.package_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "package_items_all_own_org"
  ON public.package_items FOR ALL
  USING (organization_id = public.get_my_organization_id())
  WITH CHECK (organization_id = public.get_my_organization_id());

NOTIFY pgrst, 'reload schema';
