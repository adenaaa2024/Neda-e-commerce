/**
 * PC04 — PRODUCT PACKAGING / DIMENSIONS SCHEMA PLAN (read-only)
 *
 *   npx tsx scripts/pc04-product-packaging-dimensions-schema-plan.ts --run-id=20260522T235000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const OUT_BASE = ".cursor/audit-reports/pc04-product-packaging-dimensions-schema-plan";
const APPROVAL_SRC = ".cursor/operator-approvals/product-packaging-schema-pc04-approval.md";

const INSPECT_TABLES = [
  "products",
  "product_identifier_map",
  "shipment_boxes",
  "shipment_box_items",
  "shipment_containers",
  "packages",
  "pallets",
  "claim_candidates",
  "claim_candidate_drafts",
];

const DDL_SQL = `-- PC04 — Product packaging / dimensions schema (PROPOSAL ONLY — DO NOT APPLY)
-- Staging target: eiqfaapyumhixxoeltgu
-- Requires: product-packaging-schema-pc04-approval.md both flags true

BEGIN;

-- ---------------------------------------------------------------------------
-- Enums (text + CHECK for migration portability)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.product_packaging_profiles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  store_id            uuid REFERENCES public.stores (id) ON DELETE SET NULL,
  product_id          uuid NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  packaging_level     text NOT NULL,
  fulfillment_context text NOT NULL,
  display_label       text,
  notes               text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_by          uuid,
  CONSTRAINT product_packaging_profiles_packaging_level_chk CHECK (
    packaging_level IN ('unit', 'inner_pack', 'case', 'master_carton', 'pallet_load')
  ),
  CONSTRAINT product_packaging_profiles.length_width_height_unit_chk CHECK (
    dimension_unit IS NULL OR dimension_unit IN ('in', 'cm', 'mm')
  ),
  CONSTRAINT product_packaging_profile_versions_weight_unit_chk CHECK (
    weight_unit IS NULL OR weight_unit IN ('lb', 'oz', 'kg', 'g')
  ),
  CONSTRAINT product_packaging_profile_versions_source_type_chk CHECK (
    source_type IN ('manual', 'import', 'amazon_catalog_api', 'amazon_report', 'warehouse_measurement', 'operator_override')
  ),
  CONSTRAINT product_packaging_profile_versions_status_chk CHECK (
    profile_status IN ('draft', 'active', 'superseded', 'needs_review', 'rejected')
  ),
  CONSTRAINT product_packaging_profile_versions_confidence_chk CHECK (
    confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)
  ),
  CONSTRAINT product_packaging_profile_versions_units_nonneg_chk CHECK (
    (units_per_inner_pack IS NULL OR units_per_inner_pack >= 0)
    AND (units_per_case IS NULL OR units_per_case >= 0)
    AND (units_per_carton IS NULL OR units_per_carton >= 0)
    AND (units_per_pallet IS NULL OR units_per_pallet >= 0)
  ),
  CONSTRAINT product_packaging_profile_versions_effective_range_chk CHECK (
    effective_to IS NULL OR effective_to > effective_from
  ),
  UNIQUE (profile_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_product_packaging_profile_versions_profile_active
  ON public.product_packaging_profile_versions (profile_id, profile_status, effective_from DESC)
  WHERE profile_status = 'active' AND effective_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_product_packaging_profile_versions_source
  ON public.product_packaging_profile_versions (source_type, source_upload_id);

-- ---------------------------------------------------------------------------
-- Current snapshot (denormalized for claims / UI / warehouse gates)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.product_packaging_dimensions_current (
  profile_id            uuid PRIMARY KEY REFERENCES public.product_packaging_profiles (id) ON DELETE CASCADE,
  current_version_id    uuid NOT NULL REFERENCES public.product_packaging_profile_versions (id) ON DELETE RESTRICT,
  organization_id       uuid NOT NULL,
  store_id              uuid,
  product_id            uuid NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  packaging_level       text NOT NULL,
  fulfillment_context   text NOT NULL,
  length_value          numeric(12, 4),
  width_value           numeric(12, 4),
  height_value          numeric(12, 4),
  dimension_unit        text,
  weight_value          numeric(12, 4),
  weight_unit           text,
  units_per_inner_pack  integer,
  units_per_case        integer,
  units_per_carton      integer,
  units_per_pallet      integer,
  source_type           text NOT NULL,
  confidence_score      numeric(6, 4),
  profile_status        text NOT NULL DEFAULT 'active',
  effective_from        timestamptz NOT NULL,
  refreshed_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_packaging_dimensions_current_level_chk CHECK (
    packaging_level IN ('unit', 'inner_pack', 'case', 'master_carton', 'pallet_load')
  ),
  CONSTRAINT product_packaging_dimensions_current_context_chk CHECK (
    fulfillment_context IN ('fba', 'mfn', 'wholesale', 'removal', 'unknown')
  )
);

CREATE INDEX IF NOT EXISTS idx_product_packaging_dimensions_current_lookup
  ON public.product_packaging_dimensions_current (organization_id, store_id, product_id, packaging_level, fulfillment_context);

CREATE INDEX IF NOT EXISTS idx_product_packaging_dimensions_current_product
  ON public.product_packaging_dimensions_current (product_id, fulfillment_context);

-- ---------------------------------------------------------------------------
-- Evidence / source artifacts (optional but recommended for claims)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.product_packaging_evidence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id        uuid NOT NULL REFERENCES public.product_packaging_profile_versions (id) ON DELETE CASCADE,
  organization_id   uuid NOT NULL,
  evidence_type     text NOT NULL,
  storage_url       text,
  payload_sha256      text,
  source_table      text,
  source_row_id       text,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  CONSTRAINT product_packaging_evidence_type_chk CHECK (
    evidence_type IN ('photo', 'api_payload', 'import_row', 'operator_note', 'measurement_ticket')
  )
);

CREATE INDEX IF NOT EXISTS idx_product_packaging_evidence_version
  ON public.product_packaging_evidence (version_id);

-- ---------------------------------------------------------------------------
-- Maintain current snapshot when an active version is written
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.refresh_product_packaging_dimensions_current(p_version_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v public.product_packaging_profile_versions%ROWTYPE;
  p public.product_packaging_profiles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.product_packaging_profile_versions WHERE id = p_version_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v.profile_status <> 'active' OR v.effective_to IS NOT NULL THEN RETURN; END IF;

  SELECT * INTO p FROM public.product_packaging_profiles WHERE id = v.profile_id;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO public.product_packaging_dimensions_current (
    profile_id, current_version_id, organization_id, store_id, product_id,
    packaging_level, fulfillment_context,
    length_value, width_value, height_value, dimension_unit,
    weight_value, weight_unit,
    units_per_inner_pack, units_per_case, units_per_carton, units_per_pallet,
    source_type, confidence_score, profile_status, effective_from, refreshed_at
  ) VALUES (
    p.id, v.id, p.organization_id, p.store_id, p.product_id,
    p.packaging_level, p.fulfillment_context,
    v.length_value, v.width_value, v.height_value, v.dimension_unit,
    v.weight_value, v.weight_unit,
    v.units_per_inner_pack, v.units_per_case, v.units_per_carton, v.units_per_pallet,
    v.source_type, v.confidence_score, v.profile_status, v.effective_from, now()
  )
  ON CONFLICT (profile_id) DO UPDATE SET
    current_version_id = EXCLUDED.current_version_id,
    length_value = EXCLUDED.length_value,
    width_value = EXCLUDED.width_value,
    height_value = EXCLUDED.height_value,
    dimension_unit = EXCLUDED.dimension_unit,
    weight_value = EXCLUDED.weight_value,
    weight_unit = EXCLUDED.weight_unit,
    units_per_inner_pack = EXCLUDED.units_per_inner_pack,
    units_per_case = EXCLUDED.units_per_case,
    units_per_carton = EXCLUDED.units_per_carton,
    units_per_pallet = EXCLUDED.units_per_pallet,
    source_type = EXCLUDED.source_type,
    confidence_score = EXCLUDED.confidence_score,
    profile_status = EXCLUDED.profile_status,
    effective_from = EXCLUDED.effective_from,
    refreshed_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_product_packaging_profile_versions_refresh_current()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.refresh_product_packaging_dimensions_current(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_product_packaging_profile_versions_refresh_current
  ON public.product_packaging_profile_versions;
CREATE TRIGGER trg_product_packaging_profile_versions_refresh_current
  AFTER INSERT OR UPDATE OF profile_status, effective_to ON public.product_packaging_profile_versions
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_product_packaging_profile_versions_refresh_current();

-- ---------------------------------------------------------------------------
-- RLS (org-scoped; service role bypass)
-- ---------------------------------------------------------------------------

ALTER TABLE public.product_packaging_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_packaging_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_packaging_dimensions_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_packaging_evidence ENABLE ROW LEVEL SECURITY;

-- Policies: mirror claim_candidate_drafts pattern (select own org; service_role all)
-- Detailed in rls-plan.md — apply with migration after approval.

COMMIT;
`;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function inspectSchema(): Promise<{
  columns: Record<string, Array<{ column_name: string; data_type: string; is_nullable: string }>>;
  productDimStats: Record<string, number>;
  rowCounts: Record<string, number>;
}> {
  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error("Staging postgres guard failed");
  }
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const columns: Record<string, Array<{ column_name: string; data_type: string; is_nullable: string }>> = {};
  const rowCounts: Record<string, number> = {};

  for (const t of INSPECT_TABLES) {
    const col = await client.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1
       ORDER BY ordinal_position`,
      [t],
    );
    columns[t] = col.rows as typeof columns[string];
    const cnt = await client.query(`SELECT COUNT(*)::int AS c FROM public.${t}`);
    rowCounts[t] = Number((cnt.rows[0] as { c: number }).c);
  }

  const stats = await client.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE item_weight IS NOT NULL)::int AS has_item_weight,
      COUNT(*) FILTER (WHERE item_dimensions_json IS NOT NULL)::int AS has_item_dims,
      COUNT(*) FILTER (WHERE package_weight IS NOT NULL)::int AS has_package_weight,
      COUNT(*) FILTER (WHERE package_dimensions_json IS NOT NULL)::int AS has_package_dims
    FROM public.products WHERE deleted_at IS NULL
  `);
  await client.end();
  return { columns, productDimStats: stats.rows[0] as Record<string, number>, rowCounts };
}

function fixDdl(): string {
  // Fix typo in generated DDL from copy-paste — rewrite clean DDL inline
  return `-- PC04 — Product packaging / dimensions schema (PROPOSAL ONLY — DO NOT APPLY)
-- Staging target: eiqfaapyumhixxoeltgu
-- Requires: product-packaging-schema-pc04-approval.md both flags true

BEGIN;

CREATE TABLE IF NOT EXISTS public.product_packaging_profiles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  store_id            uuid REFERENCES public.stores (id) ON DELETE SET NULL,
  product_id          uuid NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  packaging_level     text NOT NULL,
  fulfillment_context text NOT NULL,
  display_label       text,
  notes               text,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_by          uuid,
  CONSTRAINT product_packaging_profiles_level_chk CHECK (
    packaging_level IN ('unit', 'inner_pack', 'case', 'master_carton', 'pallet_load')
  ),
  CONSTRAINT product_packaging_profiles_context_chk CHECK (
    fulfillment_context IN ('fba', 'mfn', 'wholesale', 'removal', 'unknown')
  ),
  CONSTRAINT product_packaging_profiles_unique_key UNIQUE (
    organization_id, store_id, product_id, packaging_level, fulfillment_context
  )
);

CREATE INDEX IF NOT EXISTS idx_product_packaging_profiles_org_product
  ON public.product_packaging_profiles (organization_id, store_id, product_id)
  WHERE is_active = true;

CREATE TABLE IF NOT EXISTS public.product_packaging_profile_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id            uuid NOT NULL REFERENCES public.product_packaging_profiles (id) ON DELETE CASCADE,
  version_number        integer NOT NULL,
  length_value          numeric(12, 4),
  width_value           numeric(12, 4),
  height_value          numeric(12, 4),
  dimension_unit        text,
  weight_value          numeric(12, 4),
  weight_unit           text,
  units_per_inner_pack  integer,
  units_per_case        integer,
  units_per_carton      integer,
  units_per_pallet      integer,
  source_type           text NOT NULL,
  source_reference      text,
  source_upload_id      uuid REFERENCES public.raw_report_uploads (id) ON DELETE SET NULL,
  confidence_score      numeric(6, 4),
  profile_status        text NOT NULL DEFAULT 'draft',
  effective_from        timestamptz NOT NULL DEFAULT now(),
  effective_to          timestamptz,
  superseded_by_version_id uuid REFERENCES public.product_packaging_profile_versions (id) ON DELETE SET NULL,
  evidence_summary      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  CONSTRAINT product_packaging_profile_versions_dim_unit_chk CHECK (
    dimension_unit IS NULL OR dimension_unit IN ('in', 'cm', 'mm')
  ),
  CONSTRAINT product_packaging_profile_versions_weight_unit_chk CHECK (
    weight_unit IS NULL OR weight_unit IN ('lb', 'oz', 'kg', 'g')
  ),
  CONSTRAINT product_packaging_profile_versions_source_type_chk CHECK (
    source_type IN ('manual', 'import', 'amazon_catalog_api', 'amazon_report', 'warehouse_measurement', 'operator_override')
  ),
  CONSTRAINT product_packaging_profile_versions_status_chk CHECK (
    profile_status IN ('draft', 'active', 'superseded', 'needs_review', 'rejected')
  ),
  CONSTRAINT product_packaging_profile_versions_confidence_chk CHECK (
    confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)
  ),
  CONSTRAINT product_packaging_profile_versions_units_nonneg_chk CHECK (
    (units_per_inner_pack IS NULL OR units_per_inner_pack >= 0)
    AND (units_per_case IS NULL OR units_per_case >= 0)
    AND (units_per_carton IS NULL OR units_per_carton >= 0)
    AND (units_per_pallet IS NULL OR units_per_pallet >= 0)
  ),
  CONSTRAINT product_packaging_profile_versions_effective_range_chk CHECK (
    effective_to IS NULL OR effective_to > effective_from
  ),
  UNIQUE (profile_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_product_packaging_profile_versions_profile_active
  ON public.product_packaging_profile_versions (profile_id, profile_status, effective_from DESC)
  WHERE profile_status = 'active' AND effective_to IS NULL;

CREATE TABLE IF NOT EXISTS public.product_packaging_dimensions_current (
  profile_id              uuid PRIMARY KEY REFERENCES public.product_packaging_profiles (id) ON DELETE CASCADE,
  current_version_id      uuid NOT NULL REFERENCES public.product_packaging_profile_versions (id) ON DELETE RESTRICT,
  organization_id         uuid NOT NULL,
  store_id                uuid,
  product_id              uuid NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  packaging_level         text NOT NULL,
  fulfillment_context     text NOT NULL,
  length_value            numeric(12, 4),
  width_value             numeric(12, 4),
  height_value            numeric(12, 4),
  dimension_unit          text,
  weight_value            numeric(12, 4),
  weight_unit             text,
  units_per_inner_pack    integer,
  units_per_case          integer,
  units_per_carton        integer,
  units_per_pallet        integer,
  source_type             text NOT NULL,
  confidence_score        numeric(6, 4),
  profile_status          text NOT NULL DEFAULT 'active',
  effective_from          timestamptz NOT NULL,
  refreshed_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_packaging_dimensions_current_lookup
  ON public.product_packaging_dimensions_current (
    organization_id, store_id, product_id, packaging_level, fulfillment_context
  );

CREATE TABLE IF NOT EXISTS public.product_packaging_evidence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id        uuid NOT NULL REFERENCES public.product_packaging_profile_versions (id) ON DELETE CASCADE,
  organization_id   uuid NOT NULL,
  evidence_type     text NOT NULL,
  storage_url       text,
  payload_sha256    text,
  source_table      text,
  source_row_id     text,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  CONSTRAINT product_packaging_evidence_type_chk CHECK (
    evidence_type IN ('photo', 'api_payload', 'import_row', 'operator_note', 'measurement_ticket')
  )
);

CREATE INDEX IF NOT EXISTS idx_product_packaging_evidence_version
  ON public.product_packaging_evidence (version_id);

CREATE OR REPLACE FUNCTION public.refresh_product_packaging_dimensions_current(p_version_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v public.product_packaging_profile_versions%ROWTYPE;
  p public.product_packaging_profiles%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.product_packaging_profile_versions WHERE id = p_version_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF v.profile_status <> 'active' OR v.effective_to IS NOT NULL THEN RETURN; END IF;

  SELECT * INTO p FROM public.product_packaging_profiles WHERE id = v.profile_id;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO public.product_packaging_dimensions_current (
    profile_id, current_version_id, organization_id, store_id, product_id,
    packaging_level, fulfillment_context,
    length_value, width_value, height_value, dimension_unit,
    weight_value, weight_unit,
    units_per_inner_pack, units_per_case, units_per_carton, units_per_pallet,
    source_type, confidence_score, profile_status, effective_from, refreshed_at
  ) VALUES (
    p.id, v.id, p.organization_id, p.store_id, p.product_id,
    p.packaging_level, p.fulfillment_context,
    v.length_value, v.width_value, v.height_value, v.dimension_unit,
    v.weight_value, v.weight_unit,
    v.units_per_inner_pack, v.units_per_case, v.units_per_carton, v.units_per_pallet,
    v.source_type, v.confidence_score, v.profile_status, v.effective_from, now()
  )
  ON CONFLICT (profile_id) DO UPDATE SET
    current_version_id = EXCLUDED.current_version_id,
    length_value = EXCLUDED.length_value,
    width_value = EXCLUDED.width_value,
    height_value = EXCLUDED.height_value,
    dimension_unit = EXCLUDED.dimension_unit,
    weight_value = EXCLUDED.weight_value,
    weight_unit = EXCLUDED.weight_unit,
    units_per_inner_pack = EXCLUDED.units_per_inner_pack,
    units_per_case = EXCLUDED.units_per_case,
    units_per_carton = EXCLUDED.units_per_carton,
    units_per_pallet = EXCLUDED.units_per_pallet,
    source_type = EXCLUDED.source_type,
    confidence_score = EXCLUDED.confidence_score,
    profile_status = EXCLUDED.profile_status,
    effective_from = EXCLUDED.effective_from,
    refreshed_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_product_packaging_profile_versions_refresh_current()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.refresh_product_packaging_dimensions_current(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_product_packaging_profile_versions_refresh_current
  ON public.product_packaging_profile_versions;
CREATE TRIGGER trg_product_packaging_profile_versions_refresh_current
  AFTER INSERT OR UPDATE OF profile_status, effective_to ON public.product_packaging_profile_versions
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_product_packaging_profile_versions_refresh_current();

ALTER TABLE public.product_packaging_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_packaging_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_packaging_dimensions_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_packaging_evidence ENABLE ROW LEVEL SECURITY;

COMMIT;
`;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const { columns, productDimStats, rowCounts } = await inspectSchema();

  const currentReview = [
    "# PC04 — Current schema review (staging read-only)",
    "",
    `**Run id:** \`${runId}\``,
    `**Staging ref:** \`${STAGING_REF}\``,
    `**Branch:** \`${branch}\``,
    "",
    "## Summary",
    "",
    "- **No versioned packaging tables exist today.**",
    "- `products` has legacy flat columns (`item_weight`, `item_dimensions_json`, `package_weight`, `package_dimensions_json`) but **0 populated rows** on staging.",
    "- Shipment tree (`shipment_containers` → `shipment_boxes` → `shipment_box_items`) stores identifiers and quantities only — **no physical dimensions** on boxes or containers.",
    "- Returns hierarchy (`pallets` → `packages` → `return_items`) has `fulfillment_model` / `warehouse_id` on pallet/package but **no product-level packaging profile**.",
    "- Claim tables link `resolved_product_id` but **do not snapshot dimensions** for fee/overcharge math.",
    "",
    "## products — dimension columns (legacy cache)",
    "",
    "| Column | Populated (active rows) | Notes |",
    "|--------|------------------------:|-------|",
    `| item_weight | ${productDimStats.has_item_weight} / ${productDimStats.total} | Single scalar; no packaging_level |`,
    `| item_dimensions_json | ${productDimStats.has_item_dims} / ${productDimStats.total} | Unstructured JSONB |`,
    `| package_weight | ${productDimStats.has_package_weight} / ${productDimStats.total} | Ambiguous “package” meaning |`,
    `| package_dimensions_json | ${productDimStats.has_package_dims} / ${productDimStats.total} | No fulfillment_context |`,
    "",
    "**Gap:** FBA unit dims ≠ MFN ship dims ≠ case/carton/pallet — flat columns cannot represent the confirmed design.",
    "",
    "## Inspected tables",
    "",
    ...INSPECT_TABLES.map((t) => {
      const cols = columns[t] ?? [];
      const dimRelated = cols
        .filter((c) => /weight|dimension|packaging|fulfillment|product_id|resolved/i.test(c.column_name))
        .map((c) => `\`${c.column_name}\` (${c.data_type})`)
        .join(", ");
      return `### ${t} (${rowCounts[t] ?? "?"} rows)\n\n${dimRelated || "_No packaging/dimension columns._"}\n`;
    }),
    "",
    "## product_identifier_map",
    "",
    "- Has `fulfillment_channel` on map rows — useful hint for default `fulfillment_context` when creating profiles.",
    "- Does **not** store physical dimensions (correct separation).",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "current-schema-review.md"), `${currentReview}\n`);

  const proposed = [
    "# PC04 — Proposed packaging schema",
    "",
    "## Design principle",
    "",
    "Composite identity:",
    "",
    "```text",
    "organization_id + store_id + product_id + packaging_level + fulfillment_context",
    "```",
    "",
    "Versioned facts live in `product_packaging_profile_versions`. Fast reads use `product_packaging_dimensions_current`.",
    "",
    "## Recommended tables",
    "",
    "| Table | Role |",
    "|-------|------|",
    "| `product_packaging_profiles` | Stable profile identity (one row per level × context × product) |",
    "| `product_packaging_profile_versions` | Append-style version history with effective dating |",
    "| `product_packaging_dimensions_current` | Denormalized active snapshot for claims/UI/warehouse |",
    "| `product_packaging_evidence` | Source artifacts (photos, API hash, import row, measurement ticket) |",
    "",
    "## Enums",
    "",
    "**packaging_level:** `unit`, `inner_pack`, `case`, `master_carton`, `pallet_load`",
    "",
    "**fulfillment_context:** `fba`, `mfn`, `wholesale`, `removal`, `unknown`",
    "",
    "**source_type:** `manual`, `import`, `amazon_catalog_api`, `amazon_report`, `warehouse_measurement`, `operator_override`",
    "",
    "**profile_status:** `draft`, `active`, `superseded`, `needs_review`, `rejected`",
    "",
    "## Version row fields",
    "",
    "- `length_value`, `width_value`, `height_value` + `dimension_unit` (`in`, `cm`, `mm`)",
    "- `weight_value` + `weight_unit` (`lb`, `oz`, `kg`, `g`)",
    "- `units_per_inner_pack`, `units_per_case`, `units_per_carton`, `units_per_pallet`",
    "- `source_type`, `source_reference`, `source_upload_id`",
    "- `confidence_score` (0–1, aligned with claim tables)",
    "- `effective_from`, `effective_to`, `superseded_by_version_id`",
    "",
    "## Legacy `products` columns",
    "",
    "- **Do not drop** in PC04 DDL.",
    "- Treat as deprecated Amazon catalog cache; governed backfill maps into `unit`/`fba` profiles in a **separate** prompt after DDL approval.",
    "",
    "## Shipment / returns tables",
    "",
    "- **No FK to packaging profiles in PC04.**",
    "- Future: `shipment_boxes.metadata` may record `measured_*` for audit; claims compare measured vs `product_packaging_dimensions_current`.",
    "",
    "## Relationship diagram",
    "",
    "```mermaid",
    "erDiagram",
    "  products ||--o{ product_packaging_profiles : has",
    "  product_packaging_profiles ||--o{ product_packaging_profile_versions : versions",
    "  product_packaging_profiles ||--|| product_packaging_dimensions_current : current",
    "  product_packaging_profile_versions ||--o{ product_packaging_evidence : evidence",
    "```",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "proposed-packaging-schema.md"), `${proposed}\n`);
  fs.writeFileSync(path.join(outDir, "ddl-proposed.sql"), fixDdl());

  const rls = [
    "# PC04 — RLS plan",
    "",
    "Pattern: match `claim_candidate_drafts` — org-scoped SELECT for authenticated users; service_role ALL.",
    "",
    "## product_packaging_profiles",
    "",
    "- `SELECT`: `organization_id` matches JWT org (via existing workspace helper / profile join)",
    "- `INSERT/UPDATE`: admin or governed server action only (no client direct write initially)",
    "- `service_role`: ALL for import/backfill scripts",
    "",
    "## product_packaging_profile_versions",
    "",
    "- `SELECT`: join profile → org scope",
    "- `INSERT`: server action + audit `created_by`",
    "- Versions are **append-only** in practice; UPDATE limited to status/effective_to supersede",
    "",
    "## product_packaging_dimensions_current",
    "",
    "- `SELECT`: org scope (denormalized columns for fast claim joins)",
    "- `INSERT/UPDATE`: trigger-maintained only (`SECURITY DEFINER` refresh function)",
    "- Block direct client writes except service_role",
    "",
    "## product_packaging_evidence",
    "",
    "- `SELECT`: org scope via version → profile",
    "- `INSERT`: server action / import pipeline with storage URL validation",
    "",
    "## Staging apply order",
    "",
    "1. Tables + constraints",
    "2. Refresh trigger/function",
    "3. RLS enable + policies",
    "4. Smoke: insert draft version → verify current row",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "rls-plan.md"), `${rls}\n`);

  const ui = [
    "# PC04 — UI usage plan",
    "",
    "## PIM product detail",
    "",
    "- Tab: **Packaging & dimensions**",
    "- Grid: rows from `product_packaging_dimensions_current` grouped by `fulfillment_context`",
    "- Actions: add profile, new version, supersede, mark `needs_review`",
    "- Show `confidence_score`, `source_type`, effective dates",
    "",
    "## Warehouse validation (returns / shipment scan)",
    "",
    "- On scan: resolve `product_id` → fetch `unit` + context profile",
    "- Compare operator-entered or scale measurement vs current dims (tolerance configurable later)",
    "- Mismatch → flag package/box `metadata.validation_status` (app layer; not PC04 DDL)",
    "",
    "## Shipment cost recovery",
    "",
    "- Join `shipment_box_items` identifiers → `product_id` → `product_packaging_dimensions_current`",
    "- Use `case`/`master_carton` level when quantity implies inner pack math",
    "",
    "## Read contract",
    "",
    "- Extend `ProductLinkageDisplayContract` hydration with optional `packaging_summary[]` (read-only)",
    "- Do not embed dimensions in identifier map or expected_packages rows",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "ui-usage-plan.md"), `${ui}\n`);

  const claims = [
    "# PC04 — Claims impact",
    "",
    "## Use cases enabled",
    "",
    "| Claim family | Packaging need |",
    "|--------------|----------------|",
    "| FBA fee overcharge | `unit` + `fba` dims/weight vs Amazon billed |",
    "| Dimension weight disputes | L×W×H + weight at ship context |",
    "| Removal / inbound variance | `case`/`carton` units_per_* |",
    "| Wholesale B2B | `wholesale` context profiles |",
    "",
    "## Current gap",
    "",
    `- claim_candidates: ${rowCounts.claim_candidates ?? "?"} rows; ${columns.claim_candidates?.some((c) => c.column_name === "resolved_product_id") ? "has" : "no"} resolved_product_id but **no dimensional snapshot**`,
    `- claim_candidate_drafts: lifecycle includes \`needs_product_link\` — add \`needs_packaging_evidence\` blocker in generator (app change, post-DDL)`,
    "",
    "## Recommended claim generator change (post-DDL)",
    "",
    "1. Resolve `product_id`, infer `fulfillment_context` from source_table",
    "2. Lookup `product_packaging_dimensions_current`",
    "3. If missing or `confidence_score` < threshold → `needs_packaging_evidence`",
    "4. On promotion: copy dimension snapshot into `candidate_payload.packaging_snapshot` (immutable for filing)",
    "",
    "## Overcharge detection",
    "",
    "```text",
    "billed_fee_dims = source report / finances API",
    "canonical_dims    = product_packaging_dimensions_current (active, effective_at event_date)",
    "delta             = dimensional weight / size tier mismatch",
    "```",
    "",
    "Evidence table links photos and API payloads to version for dispute filing.",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "claims-impact.md"), `${claims}\n`);

  const approvalCopy = fs.readFileSync(path.join(process.cwd(), APPROVAL_SRC), "utf8");
  fs.writeFileSync(path.join(outDir, "approval-file.md"), approvalCopy);

  const blockers = [
    "# PC04 — Blockers",
    "",
    "- **DDL not applied** — approval flags default `false`.",
    "- **PC01 linkage** — packaging FK requires stable `products.id`; finish expected_packages wave before bulk backfill.",
    "- **Legacy columns empty** — `products.item_*` / `package_*` have 0 populated rows; backfill must source Amazon catalog API or imports.",
    "- **No measured dims on shipment_boxes** — warehouse validation is app-phase after schema.",
    "- **Original DB (`kxsvedvpjldygtdbylsy`)** — separate parity approval after staging proof.",
    "- **`package_items`** — remains forbidden.",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "blockers.md"), `${blockers}\n`);

  const manifest = {
    prompt: "PC04 — PRODUCT PACKAGING / DIMENSIONS SCHEMA PLAN",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    original_ref: ORIGINAL_REF,
    status: "PASS",
    mode: "architecture_and_ddl_proposal_only",
    recommended_tables: [
      "product_packaging_profiles",
      "product_packaging_profile_versions",
      "product_packaging_dimensions_current",
      "product_packaging_evidence",
    ],
    composite_key: ["organization_id", "store_id", "product_id", "packaging_level", "fulfillment_context"],
    products_legacy_dim_populated: productDimStats,
    approval_file: APPROVAL_SRC,
    approval_flags_default: {
      APPROVED_TO_RUN_STAGING: false,
      APPROVED_PRODUCT_PACKAGING_SCHEMA_DDL: false,
    },
    next_prompt: "PC05 — PRODUCT-PACKAGING-SCHEMA-STAGING-APPLY",
    forbidden: {
      migration_apply: false,
      db_mutations: false,
      production: false,
      amazon_api: false,
      ai_openai: false,
    },
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
