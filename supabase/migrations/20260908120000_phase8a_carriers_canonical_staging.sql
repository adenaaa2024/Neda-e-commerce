-- PHASE 8A — Canonical carriers + additive carrier_id FK (staging-first)
-- Do NOT drop or rename carrier / carrier_name text columns (snapshots for legacy reads).

BEGIN;

-- ── 1) carriers directory ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.carriers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier_code    text NOT NULL,
  carrier_name    text NOT NULL,
  aliases         jsonb NOT NULL DEFAULT '[]'::jsonb,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carriers_code_upper_chk CHECK (carrier_code = upper(btrim(carrier_code)))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_carriers_carrier_code
  ON public.carriers (carrier_code);

COMMENT ON TABLE public.carriers IS
  'Global canonical carrier codes (UPS, USPS, …). Text columns on ops tables remain snapshots.';

-- ── 2) carrier_aliases (one row per raw Amazon/operator token) ───────────────
CREATE TABLE IF NOT EXISTS public.carrier_aliases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier_id   uuid NOT NULL REFERENCES public.carriers (id) ON DELETE CASCADE,
  alias_token  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carrier_aliases_token_lower_chk CHECK (alias_token = lower(btrim(alias_token)))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_carrier_aliases_token
  ON public.carrier_aliases (alias_token);

COMMENT ON TABLE public.carrier_aliases IS
  'Maps raw carrier text tokens (Amazon report values) to canonical carriers.id.';

-- ── 3) Seed canonical carrier rows ───────────────────────────────────────────
INSERT INTO public.carriers (carrier_code, carrier_name, aliases) VALUES
  ('UPS',    'United Parcel Service',           '["ups","ups ground","ups_gr","ups_gr_pl"]'::jsonb),
  ('USPS',   'United States Postal Service',    '["usps","usps_ats_parcel","usps_ga","usps_ga_cubic","usps_first_class_parcel","usps_ats_std","usps_ups_gr_parcel"]'::jsonb),
  ('FEDEX',  'FedEx',                           '["fedex","fdx","fed ex"]'::jsonb),
  ('DHL',    'DHL',                             '["dhl"]'::jsonb),
  ('AMAZON', 'Amazon Logistics',                '["amzl","amzl_us_premium","amazon logistics","paaf","abnt"]'::jsonb),
  ('EXLA',   'Estes Express Lines',             '["exla","estes"]'::jsonb),
  ('OTHER',  'Other / Unknown',                 '[]'::jsonb)
ON CONFLICT (carrier_code) DO UPDATE
  SET carrier_name = EXCLUDED.carrier_name,
      aliases = EXCLUDED.aliases,
      updated_at = now();

-- ── 4) Token → carrier_code classifier (61+ raw tokens → canonical) ───────────
CREATE OR REPLACE FUNCTION public.map_carrier_code_from_token(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p_raw IS NULL OR btrim(p_raw) = '' THEN NULL
    WHEN upper(btrim(p_raw)) IN ('UPS', 'UPS GROUND') OR upper(btrim(p_raw)) LIKE 'UPS\_%' ESCAPE '\' THEN 'UPS'
    WHEN upper(btrim(p_raw)) LIKE 'USPS%' OR upper(btrim(p_raw)) LIKE 'USPS\_%' ESCAPE '\' THEN 'USPS'
    WHEN upper(btrim(p_raw)) LIKE 'FEDEX%' OR lower(btrim(p_raw)) = 'fedex' THEN 'FEDEX'
    WHEN upper(btrim(p_raw)) LIKE 'DHL%' THEN 'DHL'
    WHEN upper(btrim(p_raw)) LIKE 'AMZL%' OR upper(btrim(p_raw)) LIKE 'AMAZON%' THEN 'AMAZON'
    WHEN upper(btrim(p_raw)) IN ('EXLA', 'ESTES') THEN 'EXLA'
    WHEN upper(btrim(p_raw)) IN ('PAAF', 'ABNT') THEN 'AMAZON'
    WHEN upper(btrim(p_raw)) IN ('ONTRAC') OR lower(btrim(p_raw)) = 'ontrac' THEN 'OTHER'
    WHEN btrim(p_raw) ~ '^[0-9A-Z]{8,12}$' THEN 'OTHER'
    WHEN lower(btrim(p_raw)) LIKE '%distribution center%' THEN 'OTHER'
    ELSE 'OTHER'
  END;
$$;

COMMENT ON FUNCTION public.map_carrier_code_from_token(text) IS
  'Classifies raw carrier text to canonical carrier_code; unknown → OTHER.';

-- Seed alias rows from all distinct tokens currently in ops tables
INSERT INTO public.carrier_aliases (carrier_id, alias_token)
SELECT DISTINCT
  c.id,
  lower(btrim(u.token))
FROM (
  SELECT btrim(carrier) AS token FROM public.expected_packages
    WHERE carrier IS NOT NULL AND btrim(carrier) <> ''
  UNION
  SELECT btrim(carrier) FROM public.amazon_removal_shipments
    WHERE carrier IS NOT NULL AND btrim(carrier) <> ''
  UNION
  SELECT btrim(carrier) FROM public.shipment_containers
    WHERE carrier IS NOT NULL AND btrim(carrier) <> ''
  UNION
  SELECT btrim(carrier_name) FROM public.packages
    WHERE carrier_name IS NOT NULL AND btrim(carrier_name) <> ''
  UNION
  SELECT btrim(carrier_name) FROM public.pallets
    WHERE carrier_name IS NOT NULL AND btrim(carrier_name) <> ''
) u
JOIN public.carriers c ON c.carrier_code = public.map_carrier_code_from_token(u.token)
WHERE btrim(u.token) <> ''
ON CONFLICT (alias_token) DO NOTHING;

-- Explicit alias seeds from audit (covers tokens even if absent on empty DB)
INSERT INTO public.carrier_aliases (carrier_id, alias_token)
SELECT c.id, v.alias
FROM public.carriers c
JOIN (VALUES
  ('AMAZON', 'amzl_us_premium'),
  ('USPS',   'usps_ats_parcel'),
  ('EXLA',   'exla'),
  ('UPS',    'ups'),
  ('UPS',    'ups_gr'),
  ('UPS',    'ups_gr_pl'),
  ('UPS',    'ups ground'),
  ('USPS',   'usps'),
  ('USPS',   'usps_ga'),
  ('USPS',   'usps_ga_cubic'),
  ('USPS',   'usps_first_class_parcel'),
  ('USPS',   'usps_ats_std'),
  ('USPS',   'usps_ups_gr_parcel'),
  ('AMAZON', 'paaf'),
  ('AMAZON', 'abnt'),
  ('FEDEX',  'fedex'),
  ('EXLA',   'estes'),
  ('OTHER',  'ontrac'),
  ('DHL',    'dhl')
) AS v(code, alias)
  ON c.carrier_code = v.code
ON CONFLICT (alias_token) DO NOTHING;

-- ── 5) Resolve helper ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_carrier_id_from_text(p_raw text)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH norm AS (
    SELECT n.operational, n.status
    FROM public.normalize_removal_carrier_operational(p_raw) AS n(operational, status, token_count)
  ),
  token AS (
    SELECT lower(btrim(COALESCE(
      (SELECT operational FROM norm WHERE status NOT IN ('empty', 'multi_conflict')),
      p_raw
    ))) AS alias_token
  )
  SELECT ca.carrier_id
  FROM token t
  JOIN public.carrier_aliases ca ON ca.alias_token = t.alias_token
  LIMIT 1
$$;

COMMENT ON FUNCTION public.resolve_carrier_id_from_text(text) IS
  'Resolve carriers.id from raw text via alias map; NULL when empty/unmapped.';

-- Fallback resolver used during backfill (alias → map → OTHER)
CREATE OR REPLACE FUNCTION public.resolve_carrier_id_from_text_with_fallback(p_raw text)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(
    public.resolve_carrier_id_from_text(p_raw),
    (SELECT id FROM public.carriers WHERE carrier_code = public.map_carrier_code_from_token(p_raw) LIMIT 1),
    (SELECT id FROM public.carriers WHERE carrier_code = 'OTHER' LIMIT 1)
  )
  WHERE p_raw IS NOT NULL AND btrim(p_raw) <> ''
$$;

-- ── 6) Additive carrier_id FK columns ─────────────────────────────────────────
ALTER TABLE public.expected_packages
  ADD COLUMN IF NOT EXISTS carrier_id uuid REFERENCES public.carriers (id) ON DELETE SET NULL;
ALTER TABLE public.amazon_removal_shipments
  ADD COLUMN IF NOT EXISTS carrier_id uuid REFERENCES public.carriers (id) ON DELETE SET NULL;
ALTER TABLE public.shipment_containers
  ADD COLUMN IF NOT EXISTS carrier_id uuid REFERENCES public.carriers (id) ON DELETE SET NULL;
ALTER TABLE public.packages
  ADD COLUMN IF NOT EXISTS carrier_id uuid REFERENCES public.carriers (id) ON DELETE SET NULL;
ALTER TABLE public.pallets
  ADD COLUMN IF NOT EXISTS carrier_id uuid REFERENCES public.carriers (id) ON DELETE SET NULL;

COMMENT ON COLUMN public.expected_packages.carrier IS
  'Snapshot of source carrier text; prefer carrier_id for logic. Do not drop in 8A.';
COMMENT ON COLUMN public.amazon_removal_shipments.carrier IS
  'Snapshot of Amazon removal report carrier token; prefer carrier_id for logic.';
COMMENT ON COLUMN public.shipment_containers.carrier IS
  'Snapshot carrier text; prefer carrier_id for logic.';
COMMENT ON COLUMN public.packages.carrier_name IS
  'Snapshot carrier name from scan/intake; prefer carrier_id for logic.';
COMMENT ON COLUMN public.pallets.carrier_name IS
  'Snapshot carrier name; prefer carrier_id for logic.';

-- ── 7) Backfill carrier_id (text columns unchanged) ─────────────────────────
UPDATE public.expected_packages
SET carrier_id = public.resolve_carrier_id_from_text_with_fallback(carrier)
WHERE carrier_id IS NULL AND carrier IS NOT NULL AND btrim(carrier) <> '';

UPDATE public.amazon_removal_shipments
SET carrier_id = public.resolve_carrier_id_from_text_with_fallback(carrier)
WHERE carrier_id IS NULL AND carrier IS NOT NULL AND btrim(carrier) <> '';

UPDATE public.shipment_containers
SET carrier_id = public.resolve_carrier_id_from_text_with_fallback(carrier)
WHERE carrier_id IS NULL AND carrier IS NOT NULL AND btrim(carrier) <> '';

UPDATE public.packages
SET carrier_id = public.resolve_carrier_id_from_text_with_fallback(carrier_name)
WHERE carrier_id IS NULL AND carrier_name IS NOT NULL AND btrim(carrier_name) <> '';

UPDATE public.pallets
SET carrier_id = public.resolve_carrier_id_from_text_with_fallback(carrier_name)
WHERE carrier_id IS NULL AND carrier_name IS NOT NULL AND btrim(carrier_name) <> '';

-- ── 8) Indexes on carrier_id ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_expected_packages_carrier_id
  ON public.expected_packages (carrier_id) WHERE carrier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_amazon_removal_shipments_carrier_id
  ON public.amazon_removal_shipments (carrier_id) WHERE carrier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shipment_containers_carrier_id
  ON public.shipment_containers (carrier_id) WHERE carrier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_packages_carrier_id
  ON public.packages (carrier_id) WHERE carrier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pallets_carrier_id
  ON public.pallets (carrier_id) WHERE carrier_id IS NOT NULL;

-- ── 9) Additive read views (do not replace inventory views) ───────────────────
CREATE OR REPLACE VIEW public.v_expected_packages_carrier_enriched AS
SELECT
  ep.*,
  c.carrier_code AS canonical_carrier_code,
  c.carrier_name AS canonical_carrier_name
FROM public.expected_packages ep
LEFT JOIN public.carriers c ON c.id = ep.carrier_id;

CREATE OR REPLACE VIEW public.v_packages_carrier_enriched AS
SELECT
  p.*,
  c.carrier_code AS canonical_carrier_code,
  c.carrier_name AS canonical_carrier_name
FROM public.packages p
LEFT JOIN public.carriers c ON c.id = p.carrier_id;

CREATE OR REPLACE VIEW public.v_pallets_carrier_enriched AS
SELECT
  pl.*,
  c.carrier_code AS canonical_carrier_code,
  c.carrier_name AS canonical_carrier_name
FROM public.pallets pl
LEFT JOIN public.carriers c ON c.id = pl.carrier_id;

CREATE OR REPLACE VIEW public.v_amazon_removal_shipments_carrier_enriched AS
SELECT
  ars.*,
  c.carrier_code AS canonical_carrier_code,
  c.carrier_name AS canonical_carrier_name
FROM public.amazon_removal_shipments ars
LEFT JOIN public.carriers c ON c.id = ars.carrier_id;

COMMENT ON VIEW public.v_expected_packages_carrier_enriched IS
  'Additive: snapshot carrier text + canonical FK fields. Inventory views unchanged.';

-- ── 10) RLS — narrow; imports use service_role ───────────────────────────────
ALTER TABLE public.carriers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carrier_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "carriers: authenticated select" ON public.carriers;
CREATE POLICY "carriers: authenticated select"
  ON public.carriers FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "carriers: service_role bypass" ON public.carriers;
CREATE POLICY "carriers: service_role bypass"
  ON public.carriers AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "carrier_aliases: authenticated select" ON public.carrier_aliases;
CREATE POLICY "carrier_aliases: authenticated select"
  ON public.carrier_aliases FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "carrier_aliases: service_role bypass" ON public.carrier_aliases;
CREATE POLICY "carrier_aliases: service_role bypass"
  ON public.carrier_aliases AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);

GRANT SELECT ON public.carriers TO authenticated;
GRANT SELECT ON public.carrier_aliases TO authenticated;
GRANT SELECT ON public.v_expected_packages_carrier_enriched TO authenticated;
GRANT SELECT ON public.v_packages_carrier_enriched TO authenticated;
GRANT SELECT ON public.v_pallets_carrier_enriched TO authenticated;
GRANT SELECT ON public.v_amazon_removal_shipments_carrier_enriched TO authenticated;

COMMIT;
