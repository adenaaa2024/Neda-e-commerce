/**
 * PHASE-8-CANONICAL-VENDOR-CATEGORY-CARRIER-AUDIT-PLAN (read-only)
 *
 *   npx tsx scripts/phase8-canonical-vendor-category-carrier-audit-plan.ts --run-id=<UTC>
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase8-canonical-vendor-category-carrier-audit-plan";

type DbLabel = "original" | "staging";

type ColRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
};

type FkRow = {
  table_name: string;
  column_name: string;
  foreign_table: string;
  foreign_column: string;
};

type TableColAudit = {
  table: string;
  column: string;
  domain: "vendor" | "category" | "brand" | "carrier" | "other_ref";
  data_type: string;
  current_role: "raw_text" | "fk_id" | "snapshot_candidate" | "canonical_table";
  proposed_fk_column: string | null;
  proposed_snapshot_column: string | null;
  backfill_method: string;
  null_handling: string;
  risk_level: "low" | "medium" | "high";
  ui_api_files: string[];
  views_affected: string[];
  rls_impact: string;
};

const REF_PATTERNS = {
  vendor: /vendor/i,
  category: /categor/i,
  brand: /brand/i,
  carrier: /carrier|shipping_carrier|tracking_carrier/i,
};

const TARGET_TABLES = [
  "products",
  "product_identifier_map",
  "product_prices",
  "vendors",
  "product_categories",
  "product_category_links",
  "brands",
  "product_packaging_profiles",
  "product_packaging_evidence",
  "product_packaging_dimensions_current",
  "expected_packages",
  "amazon_removals",
  "amazon_removal_shipments",
  "return_items",
  "packages",
  "pallets",
  "slip_contents",
  "shipment_containers",
  "shipment_boxes",
  "shipment_box_items",
  "carriers",
  "carrier_aliases",
];

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function scanFiles(pattern: string, limit = 6): string[] {
  const dirs = ["app", "lib", "components"];
  const hits: string[] = [];
  for (const dir of dirs) {
    const abs = path.join(process.cwd(), dir);
    if (!fs.existsSync(abs)) continue;
    try {
      const out = execSync(`rg -l --glob "*.{ts,tsx}" "${pattern}" "${abs}"`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      if (out) hits.push(...out.split("\n"));
    } catch {
      /* none */
    }
  }
  return [...new Set(hits.map((f) => path.relative(process.cwd(), f).replace(/\\/g, "/")))].slice(0, limit);
}

function domainForCol(table: string, col: string): TableColAudit["domain"] | null {
  if (table === "vendors" || table === "product_categories" || table === "brands" || table === "carriers") {
    return null;
  }
  if (REF_PATTERNS.carrier.test(col)) return "carrier";
  if (REF_PATTERNS.vendor.test(col)) return "vendor";
  if (REF_PATTERNS.category.test(col)) return "category";
  if (REF_PATTERNS.brand.test(col)) return "brand";
  return null;
}

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");
  return client;
}

async function censusDb(client: pg.Client, label: DbLabel) {
  const tablesRes = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  const colsRes = await client.query(`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);

  const fkRes = await client.query(`
    SELECT
      tc.table_name,
      kcu.column_name,
      ccu.table_name AS foreign_table,
      ccu.column_name AS foreign_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.table_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'
    ORDER BY tc.table_name, kcu.column_name
  `);

  const idxRes = await client.query(`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND (
        indexdef ILIKE '%vendor%' OR indexdef ILIKE '%category%' OR indexdef ILIKE '%brand%'
        OR indexdef ILIKE '%carrier%'
      )
    ORDER BY tablename, indexname
  `);

  const viewsRes = await client.query(`
    SELECT table_name AS view_name
    FROM information_schema.views
    WHERE table_schema = 'public'
      AND (
        view_definition ILIKE '%carrier%' OR view_definition ILIKE '%vendor%'
        OR view_definition ILIKE '%category%' OR view_definition ILIKE '%brand%'
      )
    ORDER BY table_name
  `);

  const viewDefs = await client.query(`
    SELECT viewname, definition
    FROM pg_views
    WHERE schemaname = 'public'
      AND (
        definition ILIKE '%carrier%' OR definition ILIKE '%vendor%'
        OR definition ILIKE '%category%' OR definition ILIKE '%brand%'
      )
  `);

  const refCols = (colsRes.rows as ColRow[]).filter((c) => {
    const d = domainForCol(c.table_name, c.column_name);
    return d !== null || ["vendor_id", "category_id", "brand_id", "carrier_id", "primary_category_id"].includes(c.column_name);
  });

  const fillRates: Record<string, unknown> = {};
  const statsQueries: Array<{ key: string; sql: string }> = [
    {
      key: "products_vendor_id_fill",
      sql: `SELECT COUNT(*)::int total, COUNT(vendor_id)::int with_fk, COUNT(*) FILTER (WHERE vendor_name IS NOT NULL AND btrim(vendor_name) <> '')::int with_name FROM products WHERE deleted_at IS NULL`,
    },
    {
      key: "products_category_id_fill",
      sql: `SELECT COUNT(*)::int total, COUNT(category_id)::int with_fk, COUNT(*) FILTER (WHERE category_id IS NOT NULL)::int with_cat FROM products WHERE deleted_at IS NULL`,
    },
    {
      key: "products_brand_fill",
      sql: `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE brand IS NOT NULL AND btrim(brand) <> '')::int with_brand FROM products WHERE deleted_at IS NULL`,
    },
    {
      key: "vendors_count",
      sql: `SELECT COUNT(*)::int c, COUNT(DISTINCT lower(btrim(name)))::int distinct_names FROM vendors`,
    },
    {
      key: "product_categories_count",
      sql: `SELECT COUNT(*)::int c, COUNT(DISTINCT lower(btrim(name)))::int distinct_names FROM product_categories`,
    },
    {
      key: "expected_packages_carrier_distinct",
      sql: `SELECT COUNT(DISTINCT btrim(carrier))::int FROM expected_packages WHERE carrier IS NOT NULL AND btrim(carrier) <> ''`,
    },
    {
      key: "packages_carrier_name_distinct",
      sql: `SELECT COUNT(DISTINCT btrim(carrier_name))::int FROM packages WHERE carrier_name IS NOT NULL AND btrim(carrier_name) <> ''`,
    },
    {
      key: "pallets_carrier_name_distinct",
      sql: `SELECT COUNT(DISTINCT btrim(carrier_name))::int FROM pallets WHERE carrier_name IS NOT NULL AND btrim(carrier_name) <> ''`,
    },
    {
      key: "amazon_removal_shipments_carrier_distinct",
      sql: `SELECT COUNT(DISTINCT btrim(carrier))::int FROM amazon_removal_shipments WHERE carrier IS NOT NULL AND btrim(carrier) <> ''`,
    },
  ];

  for (const q of statsQueries) {
    try {
      if (q.key.includes("products") && !(tablesRes.rows as { table_name: string }[]).some((t) => t.table_name === "products")) continue;
      fillRates[q.key] = (await client.query(q.sql)).rows[0];
    } catch (e) {
      fillRates[q.key] = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  let carrierSamples: unknown[] = [];
  try {
    carrierSamples = (
      await client.query(`
        SELECT src, raw, cnt FROM (
          SELECT 'expected_packages.carrier' AS src, btrim(carrier) AS raw, COUNT(*)::int AS cnt
          FROM expected_packages WHERE carrier IS NOT NULL AND btrim(carrier) <> '' GROUP BY 1,2
          UNION ALL
          SELECT 'packages.carrier_name', btrim(carrier_name), COUNT(*)::int
          FROM packages WHERE carrier_name IS NOT NULL AND btrim(carrier_name) <> '' GROUP BY 1,2
          UNION ALL
          SELECT 'pallets.carrier_name', btrim(carrier_name), COUNT(*)::int
          FROM pallets WHERE carrier_name IS NOT NULL AND btrim(carrier_name) <> '' GROUP BY 1,2
          UNION ALL
          SELECT 'amazon_removal_shipments.carrier', btrim(carrier), COUNT(*)::int
          FROM amazon_removal_shipments WHERE carrier IS NOT NULL AND btrim(carrier) <> '' GROUP BY 1,2
        ) u ORDER BY cnt DESC LIMIT 40
      `)
    ).rows;
  } catch {
    carrierSamples = [];
  }

  let vendorDupes: unknown[] = [];
  try {
    vendorDupes = (
      await client.query(`
        SELECT lower(btrim(name)) AS norm, COUNT(*)::int AS c
        FROM vendors GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY c DESC LIMIT 20
      `)
    ).rows;
  } catch {
    vendorDupes = [];
  }

  let categoryDupes: unknown[] = [];
  try {
    categoryDupes = (
      await client.query(`
        SELECT lower(btrim(name)) AS norm, COUNT(*)::int AS c
        FROM product_categories GROUP BY 1 HAVING COUNT(*) > 1 ORDER BY c DESC LIMIT 20
      `)
    ).rows;
  } catch {
    categoryDupes = [];
  }

  let fkOrphans: unknown[] = [];
  try {
    fkOrphans = (
      await client.query(`
        SELECT 'products.vendor_id' AS fk, COUNT(*)::int AS orphans
        FROM products p WHERE p.vendor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vendors v WHERE v.id = p.vendor_id)
        UNION ALL
        SELECT 'products.category_id', COUNT(*)::int
        FROM products p WHERE p.category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM product_categories c WHERE c.id = p.category_id)
      `)
    ).rows;
  } catch {
    fkOrphans = [];
  }

  return {
    label,
    tables: (tablesRes.rows as { table_name: string }[]).map((r) => r.table_name),
    columns: colsRes.rows as ColRow[],
    fks: fkRes.rows as FkRow[],
    indexes: idxRes.rows,
    views: (viewsRes.rows as { view_name: string }[]).map((r) => r.view_name),
    viewDefs: viewDefs.rows as { viewname: string; definition: string }[],
    refCols,
    fillRates,
    carrierSamples,
    vendorDupes,
    categoryDupes,
    fkOrphans,
  };
}

function buildColAudits(cols: ColRow[], viewNames: string[]): TableColAudit[] {
  const audits: TableColAudit[] = [];
  for (const c of cols) {
    const domain = domainForCol(c.table_name, c.column_name);
    if (!domain && !["vendor_id", "category_id", "brand_id", "carrier_id", "primary_category_id"].includes(c.column_name)) {
      continue;
    }
    const d = domain ?? (c.column_name.endsWith("_id") ? "vendor" : "other_ref");
    const isFk = c.column_name.endsWith("_id") && c.data_type === "uuid";
    const isText = c.data_type.includes("character") || c.data_type === "text";

    let proposedFk: string | null = null;
    let proposedSnap: string | null = null;
    let backfill = "";
    let nullHandling = "NULL until matched; OTHER carrier for unknown";
    let risk: TableColAudit["risk_level"] = "medium";

    if (d === "vendor") {
      if (c.column_name === "vendor_id") {
        proposedFk = "vendor_id";
        proposedSnap = "vendor_name_snapshot";
        backfill = "Match products.vendor_name → vendors.name (org-scoped, lower trim); snapshot existing vendor_name";
        risk = "low";
      } else if (c.column_name === "vendor_name") {
        proposedSnap = "vendor_name_snapshot";
        backfill = "Rename to vendor_name_snapshot after vendor_id backfill";
        risk = "medium";
      }
    } else if (d === "category") {
      if (c.column_name === "category_id" || c.column_name === "primary_category_id") {
        proposedFk = c.column_name;
        proposedSnap = "category_name_snapshot";
        backfill = "Match metadata/import category text → product_categories; M2M via product_category_links";
      } else if (c.column_name.includes("category") && isText) {
        proposedSnap = `${c.table_name}_${c.column_name}_snapshot`;
        backfill = "Keep as snapshot only";
      }
    } else if (d === "brand") {
      if (c.column_name === "brand_id") {
        proposedFk = "brand_id";
        proposedSnap = "brand_name_snapshot";
        backfill = "Match products.brand → brands.name (org-scoped)";
      } else if (c.column_name === "brand") {
        proposedSnap = "brand_name_snapshot";
        backfill = "Rename brand → brand_name_snapshot after brand_id FK";
        risk = "medium";
      }
    } else if (d === "carrier") {
      if (c.column_name === "carrier_id") {
        proposedFk = "carrier_id";
        proposedSnap = "carrier_code_snapshot + carrier_name_snapshot";
        backfill = "normalize_removal_carrier_operational() → carriers.carrier_code lookup";
        risk = "high";
      } else {
        proposedSnap = c.column_name.includes("code") ? "carrier_code_snapshot" : "carrier_name_snapshot";
        proposedFk = "carrier_id";
        backfill = "Backfill carrier_id from text via alias map; retain original text as snapshot";
        risk = "high";
      }
    }

    const viewsAffected = viewNames.filter((v) => {
      /* filled from view defs scan below */
      return false;
    });

    audits.push({
      table: c.table_name,
      column: c.column_name,
      domain: d === "other_ref" ? "vendor" : d,
      data_type: c.data_type,
      current_role: isFk ? "fk_id" : isText ? "raw_text" : "snapshot_candidate",
      proposed_fk_column: proposedFk,
      proposed_snapshot_column: proposedSnap,
      backfill_method: backfill || "TBD",
      null_handling: nullHandling,
      risk_level: risk,
      ui_api_files: scanFiles(`${c.table_name}|${c.column_name}`, 4),
      views_affected: viewsAffected,
      rls_impact: isFk ? "New FK table needs org-scoped RLS (Phase 8D)" : "Existing table RLS unchanged until join rewrite",
    });
  }
  return audits;
}

function schemaDiff(
  orig: Awaited<ReturnType<typeof censusDb>>,
  stg: Awaited<ReturnType<typeof censusDb>>,
): string[] {
  const diffs: string[] = [];
  const origTables = new Set(orig.tables);
  const stgTables = new Set(stg.tables);
  for (const t of TARGET_TABLES) {
    if (origTables.has(t) !== stgTables.has(t)) {
      diffs.push(`table \`${t}\`: original=${origTables.has(t)} staging=${stgTables.has(t)}`);
    }
  }
  const origColKey = (c: ColRow) => `${c.table_name}.${c.column_name}`;
  const stgColSet = new Set(stg.columns.map(origColKey));
  const origColSet = new Set(orig.columns.map(origColKey));
  for (const c of orig.refCols) {
    const k = origColKey(c);
    if (!stgColSet.has(k)) diffs.push(`column missing on staging: \`${k}\``);
  }
  for (const c of stg.refCols) {
    const k = origColKey(c);
    if (!origColSet.has(k)) diffs.push(`column missing on original: \`${k}\``);
  }
  return diffs;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const origUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stgUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!origUrl || !stgUrl) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL and STAGING_DIRECT_POSTGRES_URL required");

  const origClient = await connect(origUrl);
  const stgClient = await connect(stgUrl);
  const original = await censusDb(origClient, "original");
  const staging = await censusDb(stgClient, "staging");
  await origClient.end();
  await stgClient.end();

  const diffs = schemaDiff(original, staging);

  // Attach views to column audits from original view defs
  const colAudits = buildColAudits(original.refCols, original.views);
  for (const a of colAudits) {
    a.views_affected = original.viewDefs
      .filter((v) => v.definition.includes(a.column) || v.definition.includes(a.table))
      .map((v) => v.viewname)
      .slice(0, 8);
  }

  const hasVendors = original.tables.includes("vendors");
  const hasCategories = original.tables.includes("product_categories");
  const hasBrands = original.tables.includes("brands");
  const hasCarriers = original.tables.includes("carriers");
  const hasCategoryLinks = original.tables.includes("product_category_links");

  const vendorFill = original.fillRates.products_vendor_id_fill as { total?: number; with_fk?: number; with_name?: number } | undefined;
  const catFill = original.fillRates.products_category_id_fill as { total?: number; with_fk?: number } | undefined;
  const brandFill = original.fillRates.products_brand_fill as { total?: number; with_brand?: number } | undefined;

  const canonicalVendorStatus = hasVendors
    ? vendorFill?.with_fk && vendorFill.total
      ? `partial — vendors table exists; ${vendorFill.with_fk}/${vendorFill.total} products have vendor_id; vendor_name text still authoritative in places`
      : "table_exists_fill_unknown"
    : "missing_table";
  const canonicalCategoryStatus = hasCategories
    ? hasCategoryLinks
      ? `partial — product_categories + links exist; products.category_id ${catFill?.with_fk ?? 0}/${catFill?.total ?? "?"} filled`
      : `partial — product_categories exists; no product_category_links; single category_id on products only`
    : "missing_table";
  const canonicalBrandStatus = hasBrands
    ? "brands_table_exists"
    : `text_only — products.brand text (${brandFill?.with_brand ?? "?"}/${brandFill?.total ?? "?"} filled); no brands table`;
  const canonicalCarrierStatus = hasCarriers
    ? "carriers_table_exists"
    : "text_only — normalize_removal_carrier_operational() function exists; no carriers table; carrier text on EP/packages/pallets/shipments";

  const tablesNeedingFk = [
    ...new Set(
      colAudits
        .filter((a) => a.current_role === "raw_text" && a.proposed_fk_column)
        .map((a) => a.table),
    ),
  ];

  const rawNameCols = colAudits.filter((a) => a.current_role === "raw_text").map((a) => `${a.table}.${a.column}`);
  const carrierCols = colAudits.filter((a) => a.domain === "carrier").map((a) => `${a.table}.${a.column}`);

  const migrationFiles = [
    "supabase/migrations/20260908120000_phase8a_carriers_table_and_backfill.sql",
    "supabase/migrations/20260908130000_phase8b_product_vendor_category_brand_fk.sql",
    "supabase/migrations/20260908140000_phase8c_views_api_carrier_joins.sql",
    "supabase/migrations/20260908150000_phase8d_reference_table_rls.sql",
    "supabase/migrations/20260908160000_phase8e_deprecate_raw_name_usage.sql",
  ];

  const blockers = [
    ...(diffs.length > 0 ? [`Schema drift original↔staging (${diffs.length} diffs) — align before dual-DB apply`] : []),
    "Scanner/import rebuild RPCs read carrier text — Phase 8A must add carrier_id as additive column only",
    "PIM RPCs join vendors/category_id — vendor_id orphan check required before FK enforce",
    "products.brand is text; brands table must be created in 8B before brand_id FK",
    "product_category_links table absent on original — create in 8B before M2M migration",
    "Do not drop raw text columns in Phase 8 — snapshot rename only after UI reads FK+join",
    "RLS on new carriers/brands tables must include service_role bypass for import workers",
  ];

  const phase8CompletePct = Math.round(
    ((hasVendors ? 15 : 0) +
      (hasCategories ? 15 : 0) +
      (hasBrands ? 10 : 0) +
      (hasCarriers ? 25 : 5) +
      (vendorFill?.with_fk && vendorFill.total ? (vendorFill.with_fk / vendorFill.total) * 15 : 0) +
      (catFill?.with_fk && catFill.total ? (catFill.with_fk / catFill.total) * 10 : 0) +
      (original.fks.some((f) => f.column_name === "vendor_id") ? 10 : 0)) /
      1,
  );

  const safe8aStaging =
    !hasCarriers &&
    diffs.filter((d) => d.includes("carriers")).length === 0 &&
    blockers.every((b) => !b.includes("CRITICAL"));

  // Write migration draft SQL files (DO NOT APPLY)
  const phase8aSql = `-- PHASE 8A — carriers canonical table + additive carrier_id columns
-- DO NOT APPLY WITHOUT OPERATOR APPROVAL
-- Target: staging first, then original after smoke

BEGIN;

CREATE TABLE IF NOT EXISTS public.carriers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  carrier_code text NOT NULL,
  carrier_name text NOT NULL,
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carriers_code_upper_chk CHECK (carrier_code = upper(btrim(carrier_code)))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_carriers_global_code
  ON public.carriers (carrier_code)
  WHERE organization_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_carriers_org_code
  ON public.carriers (organization_id, carrier_code)
  WHERE organization_id IS NOT NULL;

COMMENT ON TABLE public.carriers IS 'Canonical carrier directory; global rows (organization_id NULL) + optional org overrides.';

-- Seed global carriers
INSERT INTO public.carriers (organization_id, carrier_code, carrier_name, aliases) VALUES
  (NULL, 'UPS', 'United Parcel Service', '["ups","u.p.s."]'),
  (NULL, 'USPS', 'United States Postal Service', '["usps","u.s.p.s."]'),
  (NULL, 'FEDEX', 'FedEx', '["fedex","fdx","fed ex"]'),
  (NULL, 'DHL', 'DHL', '["dhl"]'),
  (NULL, 'AMAZON', 'Amazon Logistics', '["amzl","amazon logistics"]'),
  (NULL, 'EXLA', 'Estes Express Lines', '["exla","estes"]'),
  (NULL, 'OTHER', 'Other / Unknown', '[]')
ON CONFLICT DO NOTHING;

-- Additive columns (do not drop carrier / carrier_name yet)
ALTER TABLE public.expected_packages ADD COLUMN IF NOT EXISTS carrier_id uuid REFERENCES public.carriers(id);
ALTER TABLE public.expected_packages ADD COLUMN IF NOT EXISTS carrier_code_snapshot text;
ALTER TABLE public.expected_packages ADD COLUMN IF NOT EXISTS carrier_name_snapshot text;

ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS carrier_id uuid REFERENCES public.carriers(id);
ALTER TABLE public.packages ADD COLUMN IF NOT EXISTS carrier_code_snapshot text;

ALTER TABLE public.pallets ADD COLUMN IF NOT EXISTS carrier_id uuid REFERENCES public.carriers(id);
ALTER TABLE public.pallets ADD COLUMN IF NOT EXISTS carrier_code_snapshot text;

ALTER TABLE public.amazon_removal_shipments ADD COLUMN IF NOT EXISTS carrier_id uuid REFERENCES public.carriers(id);
ALTER TABLE public.amazon_removal_shipments ADD COLUMN IF NOT EXISTS carrier_code_snapshot text;

-- Backfill function (uses existing normalize_removal_carrier_operational)
CREATE OR REPLACE FUNCTION public.resolve_carrier_id_from_text(p_raw text, p_org_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE sql STABLE SET search_path = public AS $$
  WITH norm AS (
    SELECT operational FROM public.normalize_removal_carrier_operational(p_raw)
  )
  SELECT c.id FROM public.carriers c, norm n
  WHERE c.active
    AND (c.organization_id IS NULL OR c.organization_id = p_org_id)
    AND (
      upper(btrim(n.operational)) = c.carrier_code
      OR c.aliases ? lower(btrim(n.operational))
    )
  ORDER BY c.organization_id NULLS LAST
  LIMIT 1;
$$;

COMMIT;
`;

  const phase8bSql = `-- PHASE 8B — vendor/category/brand canonical FKs on products
-- DO NOT APPLY WITHOUT OPERATOR APPROVAL

BEGIN;

CREATE TABLE IF NOT EXISTS public.brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_brands_org_lower_name ON public.brands (organization_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS public.product_category_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.product_categories(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, category_id)
);

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS brand_id uuid REFERENCES public.brands(id) ON DELETE SET NULL;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS brand_name_snapshot text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS vendor_name_snapshot text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS category_name_snapshot text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS primary_category_id uuid REFERENCES public.product_categories(id) ON DELETE SET NULL;

-- Snapshot copy (no drop of vendor_name/brand yet)
UPDATE public.products SET vendor_name_snapshot = vendor_name WHERE vendor_name_snapshot IS NULL AND vendor_name IS NOT NULL;
UPDATE public.products SET brand_name_snapshot = brand WHERE brand_name_snapshot IS NULL AND brand IS NOT NULL;

COMMIT;
`;

  const phase8cSql = `-- PHASE 8C — views/API join carriers + canonical refs
-- DO NOT APPLY WITHOUT OPERATOR APPROVAL
-- Update v_inventory_item_status, v_inventory_status to COALESCE(c.carrier_name, ep.carrier_name_snapshot, ep.carrier)
-- Update pim_catalog_products_page joins to brands table
-- See lib/scanner/v-inventory-status.ts, app/api/dashboard/products/*
`;

  const phase8dSql = `-- PHASE 8D — RLS for carriers, brands, product_category_links
-- DO NOT APPLY WITHOUT OPERATOR APPROVAL

ALTER TABLE public.carriers ENABLE ROW LEVEL SECURITY;
CREATE POLICY carriers_select ON public.carriers FOR SELECT TO authenticated
  USING (organization_id IS NULL OR organization_id = public.get_my_organization_id());
CREATE POLICY carriers_service ON public.carriers FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;
CREATE POLICY brands_org ON public.brands FOR ALL TO authenticated
  USING (organization_id = public.get_my_organization_id())
  WITH CHECK (organization_id = public.get_my_organization_id());
CREATE POLICY brands_service ON public.brands FOR ALL TO service_role USING (true) WITH CHECK (true);
`;

  const phase8eSql = `-- PHASE 8E — deprecate raw-name-only usage (no column drops)
-- DO NOT APPLY WITHOUT OPERATOR APPROVAL
-- Add comments marking vendor_name, brand, carrier as snapshot-only
COMMENT ON COLUMN public.products.vendor_name IS 'DEPRECATED display snapshot — use vendor_id FK + vendors.name';
COMMENT ON COLUMN public.products.brand IS 'DEPRECATED display snapshot — use brand_id FK + brands.name';
COMMENT ON COLUMN public.expected_packages.carrier IS 'DEPRECATED display snapshot — use carrier_id FK';
`;

  fs.writeFileSync(path.join(outDir, "01_domain_audit.md"), [
    "# Phase 8 — Canonical reference domain audit",
    "",
    `**Run:** \`${runId}\`  `,
    `**Original:** \`${ORIGINAL_REF}\`  `,
    `**Staging:** \`${STAGING_REF}\`  `,
    "**Mode:** audit + plan only — no migrations applied",
    "",
    "## Status summary",
    "",
    `| Domain | Status |`,
    `|--------|--------|`,
    `| Vendors | ${canonicalVendorStatus} |`,
    `| Categories | ${canonicalCategoryStatus} |`,
    `| Brands | ${canonicalBrandStatus} |`,
    `| Carriers | ${canonicalCarrierStatus} |`,
    "",
    "## Per-column audit",
    "",
    "| Table | Column | Domain | Role | Proposed FK | Proposed snapshot | Backfill | Risk | Views |",
    "|-------|--------|--------|------|-------------|-------------------|----------|------|-------|",
    ...colAudits.map(
      (a) =>
        `| \`${a.table}\` | \`${a.column}\` | ${a.domain} | ${a.current_role} | ${a.proposed_fk_column ?? "—"} | ${a.proposed_snapshot_column ?? "—"} | ${a.backfill_method.slice(0, 60)}… | ${a.risk_level} | ${a.views_affected.slice(0, 2).join(", ") || "—"} |`,
    ),
  ].join("\n") + "\n");

  fs.writeFileSync(path.join(outDir, "02_carrier_column_inventory.md"), [
    "# Carrier columns found",
    "",
    `**Count:** ${carrierCols.length}`,
    "",
    ...carrierCols.map((c) => `- \`${c}\``),
    "",
    "## Top raw carrier values (original)",
    "",
    "| Source | Raw | Count |",
    "|--------|-----|------:|",
    ...(original.carrierSamples as { src: string; raw: string; cnt: number }[]).map(
      (r) => `| ${r.src} | ${r.raw?.slice(0, 40)} | ${r.cnt} |`,
    ),
  ].join("\n") + "\n");

  fs.writeFileSync(path.join(outDir, "03_staging_original_schema_diff.md"), [
    "# Staging vs original schema diff (reference domains)",
    "",
    diffs.length ? diffs.map((d) => `- ${d}`).join("\n") : "_No diffs in target tables/columns_",
    "",
    "## Target table presence",
    "",
    "| Table | Original | Staging |",
    "|-------|:--------:|:-------:|",
    ...TARGET_TABLES.map((t) => {
      const o = original.tables.includes(t);
      const s = staging.tables.includes(t);
      return `| \`${t}\` | ${o ? "yes" : "no"} | ${s ? "yes" : "no"} |`;
    }),
  ].join("\n") + "\n");

  fs.writeFileSync(path.join(outDir, "04_migration_plan.md"), [
    "# Phase 8 migration plan",
    "",
    "## Order (both DBs: staging proof → original)",
    "",
    "1. **8A** — `carriers` table + additive `carrier_id` + snapshots + backfill RPC",
    "2. **8B** — `brands`, `product_category_links`, product FK columns + snapshot copy",
    "3. **8C** — Rewrite views (`v_inventory_*`) and API joins to prefer FK",
    "4. **8D** — RLS on new reference tables",
    "5. **8E** — Deprecate comments; no column drops",
    "",
    "## FK orphan risk (original)",
    "",
    ...(original.fkOrphans as { fk: string; orphans: number }[]).map((r) => `- \`${r.fk}\`: ${r.orphans} orphans`),
    "",
    "## Duplicate names",
    "",
    "**Vendors:**",
    ...(original.vendorDupes as { norm: string; c: number }[]).map((d) => `- \`${d.norm}\` × ${d.c}`),
    "**Categories:**",
    ...(original.categoryDupes as { norm: string; c: number }[]).map((d) => `- \`${d.norm}\` × ${d.c}`),
    "",
    "## Blockers",
    "",
    ...blockers.map((b) => `- ${b}`),
  ].join("\n") + "\n");

  fs.mkdirSync(path.join(outDir, "migrations"), { recursive: true });

  fs.writeFileSync(path.join(outDir, "migrations/03_phase8a_carriers.sql"), phase8aSql);
  fs.writeFileSync(path.join(outDir, "migrations/04_phase8b_product_refs.sql"), phase8bSql);
  fs.writeFileSync(path.join(outDir, "migrations/05_phase8c_views_api.sql"), phase8cSql);
  fs.writeFileSync(path.join(outDir, "migrations/06_phase8d_rls.sql"), phase8dSql);
  fs.writeFileSync(path.join(outDir, "migrations/07_phase8e_deprecate.sql"), phase8eSql);

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PHASE-8-CANONICAL-VENDOR-CATEGORY-CARRIER-AUDIT-PLAN",
        run_id: runId,
        phase_number: 8,
        original_ref: ORIGINAL_REF,
        staging_ref: STAGING_REF,
        canonical_vendor_status: canonicalVendorStatus,
        canonical_category_status: canonicalCategoryStatus,
        canonical_brand_status: canonicalBrandStatus,
        canonical_carrier_status: canonicalCarrierStatus,
        tables_needing_fk: tablesNeedingFk,
        raw_name_columns_found: rawNameCols,
        carrier_columns_found: carrierCols,
        staging_original_schema_diff_count: diffs.length,
        staging_original_schema_diff: diffs.slice(0, 30),
        migration_files_proposed: migrationFiles,
        SAFE_TO_APPLY_PHASE_8A_STAGING: safe8aStaging ? "yes" : "no",
        new_phase_8_percent: Math.min(phase8CompletePct, 100),
        blockers,
        original_fill_rates: original.fillRates,
        no_db_writes: true,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        phase_number: 8,
        canonical_vendor_status: canonicalVendorStatus,
        canonical_category_status: canonicalCategoryStatus,
        canonical_brand_status: canonicalBrandStatus,
        canonical_carrier_status: canonicalCarrierStatus,
        tables_needing_fk: tablesNeedingFk.length,
        raw_name_columns_found: rawNameCols.length,
        carrier_columns_found: carrierCols.length,
        staging_original_schema_diff: diffs.length,
        SAFE_TO_APPLY_PHASE_8A_STAGING: safe8aStaging ? "yes" : "no",
        new_phase_8_percent: Math.min(phase8CompletePct, 100),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
