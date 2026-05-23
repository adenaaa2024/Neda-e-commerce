-- BOX scan: line-level packing slip extraction (GPT) stored per package.

CREATE TABLE IF NOT EXISTS public.slip_contents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  package_id uuid NOT NULL REFERENCES public.packages (id) ON DELETE CASCADE,
  rma_number text,
  upc text,
  fnsku text,
  description text,
  quantity integer NOT NULL DEFAULT 0,
  condition text,
  sort_index integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_slip_contents_package_id
  ON public.slip_contents (package_id);

CREATE INDEX IF NOT EXISTS idx_slip_contents_organization_id
  ON public.slip_contents (organization_id);

COMMENT ON TABLE public.slip_contents IS
  'Packing slip line items (UPC, FNSKU, qty, condition) linked to packages after BOX scan GPT vision.';

COMMENT ON COLUMN public.slip_contents.fnsku IS
  'Amazon FNSKU; on paper often labeled ASIN (typically starts with X).';

ALTER TABLE public.slip_contents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "slip_contents_all_own_org"
  ON public.slip_contents FOR ALL
  USING (organization_id = public.get_my_organization_id())
  WITH CHECK (organization_id = public.get_my_organization_id());

NOTIFY pgrst, 'reload schema';
