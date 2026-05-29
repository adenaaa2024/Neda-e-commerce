/**
 * ORIGINAL PARITY PHASE 1 SCANNER PLAN (read-only)
 *
 *   npx tsx scripts/original-parity-phase1-scanner-plan.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/original-parity-phase1-scanner-plan";

type GapClass =
  | "already_in_parity"
  | "schema_missing"
  | "data_missing"
  | "code_deploy_only"
  | "unsafe_to_copy_blindly";

type GapItem = {
  id: string;
  surface: string;
  classification: GapClass;
  staging: string | number | boolean | null;
  original: string | number | boolean | null;
  notes: string;
  wave: "A" | "B" | "C" | "D" | "-";
};

const TABLES = [
  "amazon_removals",
  "amazon_removal_shipments",
  "removal_item_allocations",
  "expected_packages",
  "return_items",
  "products",
  "product_identifier_map",
] as const;

const TABLE_KEY_COLUMNS: Record<string, string[]> = {
  amazon_removals: [
    "source_staging_id",
    "upload_id",
    "order_id",
    "order_type",
    "order_date",
    "sku",
    "fnsku",
    "disposition",
    "shipped_quantity",
    "store_id",
  ],
  amazon_removal_shipments: [
    "upload_id",
    "staging_row_number",
    "order_id",
    "order_type",
    "order_date",
    "sku",
    "fnsku",
    "disposition",
    "shipped_quantity",
    "tracking_number",
    "store_id",
  ],
  removal_item_allocations: [
    "removal_detail_row_id",
    "shipment_row_id",
    "allocated_quantity",
    "allocation_status",
    "store_id",
  ],
  expected_packages: [
    "build_source",
    "build_status",
    "source_detail_row_id",
    "source_shipment_row_id",
    "expected_scan_quantity",
    "resolved_product_id",
    "resolution_status",
    "resolution_method",
    "rebuild_run_at",
    "store_id",
  ],
  return_items: [
    "resolved_product_id",
    "resolution_status",
    "resolution_method",
    "product_id",
    "expected_package_id",
  ],
  products: ["id", "sku", "title", "metadata", "deleted_at"],
  product_identifier_map: [
    "product_id",
    "identifier_type",
    "identifier_value",
    "store_id",
    "deleted_at",
  ],
};

const FUNCTIONS = [
  "rebuild_expected_packages_from_removals",
  "rebuild_removal_item_allocations",
  "materialize_removal_shipment_tree",
] as const;

const VIEWS = ["v_inventory_item_status", "v_scanned_items_counted"] as const;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

async function tableExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS ok`,
    [name],
  );
  return Boolean((r.rows[0] as { ok: boolean }).ok);
}

async function viewExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.views
       WHERE table_schema = 'public' AND table_name = $1
     ) AS ok`,
    [name],
  );
  return Boolean((r.rows[0] as { ok: boolean }).ok);
}

async function functionExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = $1
     ) AS ok`,
    [name],
  );
  return Boolean((r.rows[0] as { ok: boolean }).ok);
}

async function tableColumns(client: pg.Client, name: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [name],
  );
  return new Set((r.rows as Array<{ column_name: string }>).map((x) => x.column_name));
}

async function viewDefinitionHash(client: pg.Client, name: string): Promise<string | null> {
  const r = await client.query(
    `SELECT pg_get_viewdef('public.${name.replace(/'/g, "''")}'::regclass, true) AS def`,
  );
  const def = (r.rows[0] as { def?: string } | undefined)?.def;
  if (!def) return null;
  return String(def.length) + ":" + def.replace(/\s+/g, " ").slice(0, 120);
}

async function domainCounts(client: pg.Client) {
  const out: Record<string, number | null> = {};
  for (const t of TABLES) {
    if (!(await tableExists(client, t))) {
      out[t] = null;
      continue;
    }
    const r = await client.query(`SELECT COUNT(*)::int AS c FROM public.${t}`);
    out[t] = (r.rows[0] as { c: number }).c;
  }

  if (await tableExists(client, "amazon_removals")) {
    const r = await client.query(
      `SELECT COUNT(*)::int AS c FROM public.amazon_removals
       WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
      [SAM_ORG, SAM_STORE],
    );
    out.amazon_removals_sam = (r.rows[0] as { c: number }).c;
  } else out.amazon_removals_sam = null;

  if (await tableExists(client, "amazon_removal_shipments")) {
    const r = await client.query(
      `SELECT COUNT(*)::int AS c FROM public.amazon_removal_shipments
       WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
      [SAM_ORG, SAM_STORE],
    );
    out.amazon_removal_shipments_sam = (r.rows[0] as { c: number }).c;
  } else out.amazon_removal_shipments_sam = null;

  if (await tableExists(client, "expected_packages")) {
    const epCols = await tableColumns(client, "expected_packages");
    const hasBuildSource = epCols.has("build_source");
    const hasResolved = epCols.has("resolved_product_id");
    const derivedFilter = hasBuildSource
      ? `COUNT(*) FILTER (WHERE build_source IN ('detail_shipment','detail_remainder'))::int AS derived,
         COUNT(*) FILTER (WHERE build_source = 'detail_shipment')::int AS detail_shipment,
         COUNT(*) FILTER (WHERE build_source = 'detail_remainder')::int AS detail_remainder`
      : `0::int AS derived, 0::int AS detail_shipment, 0::int AS detail_remainder`;
    const resolvedFilter = hasResolved
      ? `COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
         COUNT(*) FILTER (
           WHERE build_source IN ('detail_shipment','detail_remainder') AND resolved_product_id IS NOT NULL
         )::int AS derived_resolved`
      : `0::int AS resolved, 0::int AS derived_resolved`;
    const r = await client.query(
      `
      SELECT COUNT(*)::int AS total, ${derivedFilter}, ${resolvedFilter}
      FROM public.expected_packages
      WHERE organization_id = $1::uuid AND store_id = $2::uuid
      `,
      [SAM_ORG, SAM_STORE],
    );
    Object.assign(out, r.rows[0] as Record<string, number>);
  }

  if (await tableExists(client, "return_items")) {
    const riCols = await tableColumns(client, "return_items");
    const hasResolutionStatus = riCols.has("resolution_status");
    const r = await client.query(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved
        ${hasResolutionStatus ? ", COUNT(*) FILTER (WHERE resolution_status IS NOT NULL)::int AS has_resolution_status" : ""}
      FROM public.return_items
      WHERE organization_id = $1::uuid AND deleted_at IS NULL
      `,
      [SAM_ORG],
    );
    Object.assign(
      out,
      Object.fromEntries(
        Object.entries(r.rows[0] as Record<string, number>).map(([k, v]) => [`return_items_${k}`, v]),
      ),
    );
  }

  if (await tableExists(client, "product_identifier_map")) {
    const r = await client.query(
      `SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`,
    );
    out.product_identifier_map_active = (r.rows[0] as { c: number }).c;
  }

  if (await tableExists(client, "product_packaging_profiles")) {
    const r = await client.query(`SELECT COUNT(*)::int AS c FROM public.product_packaging_profiles`);
    out.product_packaging_profiles = (r.rows[0] as { c: number }).c;
  } else out.product_packaging_profiles = null;

  return out;
}

function classifyColumnGap(table: string, col: string, stagingHas: boolean, originalHas: boolean): GapItem {
  if (stagingHas && originalHas) {
    return {
      id: `${table}.${col}`,
      surface: `${table}.${col}`,
      classification: "already_in_parity",
      staging: true,
      original: true,
      notes: "Column present on both refs.",
      wave: "-",
    };
  }
  if (stagingHas && !originalHas) {
    const wave = ["return_items", "expected_packages"].includes(table)
      ? "A"
      : table.startsWith("amazon_") || table === "removal_item_allocations"
        ? "A"
        : "B";
    return {
      id: `${table}.${col}`,
      surface: `${table}.${col}`,
      classification: "schema_missing",
      staging: true,
      original: false,
      notes: `Apply committed migration / operator DDL on original before data wave.`,
      wave,
    };
  }
  return {
    id: `${table}.${col}`,
    surface: `${table}.${col}`,
    classification: "already_in_parity",
    staging: false,
    original: false,
    notes: "Neither ref has optional column.",
    wave: "-",
  };
}

function approvalWaveA(): string {
  return `# Original parity Phase 1 — Wave A schema/views/functions

**Default:** not approved.

| Field | Value |
|-------|--------|
| Original ref | \`${ORIGINAL_REF}\` |
| Scope | Removal API tables, rebuild functions, scanner view columns |

\`\`\`text
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_A=false
\`\`\`

## Sign-off

\`\`\`
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_A=false
Approved by:
UTC date:
Plan run_id:
\`\`\`
`;
}

function approvalWaveB(): string {
  return `# Original parity Phase 1 — Wave B product/PIM resolver data

**Default:** not approved.

| Field | Value |
|-------|--------|
| Original ref | \`${ORIGINAL_REF}\` |
| Scope | Governed products + product_identifier_map spine deltas from staging |

\`\`\`text
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_B=false
\`\`\`

## Sign-off

\`\`\`
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_B=false
Approved by:
UTC date:
Plan run_id:
\`\`\`
`;
}

function approvalWaveC(): string {
  return `# Original parity Phase 1 — Wave C removal domain + expected_packages rebuild

**Default:** not approved.

| Field | Value |
|-------|--------|
| Original ref | \`${ORIGINAL_REF}\` |
| Scope | amazon_removals/shipments domain sync, rebuild EP, resolver backfill |

\`\`\`text
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_C=false
\`\`\`

## Sign-off

\`\`\`
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_C=false
Approved by:
UTC date:
Plan run_id:
\`\`\`
`;
}

function approvalWaveD(): string {
  return `# Original parity Phase 1 — Wave D scanner smoke on original

**Default:** not approved.

| Field | Value |
|-------|--------|
| Original ref | \`${ORIGINAL_REF}\` |
| Scope | Deploy scanner code to production + smoke scan/compare on original DB |

\`\`\`text
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_D=false
APPROVED_VERCEL_PRODUCTION_DEPLOY=false
\`\`\`

## Sign-off

\`\`\`
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_D=false
APPROVED_VERCEL_PRODUCTION_DEPLOY=false
Approved by:
UTC date:
Plan run_id:
\`\`\`
`;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!stagingUrl || !originalUrl) blockers.push("Missing STAGING_DIRECT_POSTGRES_URL or ORIGINAL_DIRECT_POSTGRES_URL");
  if (stagingUrl && refFromConnectionUrl(stagingUrl) !== STAGING_REF) {
    blockers.push(`Staging URL must target ${STAGING_REF}`);
  }
  if (originalUrl && refFromConnectionUrl(originalUrl) !== ORIGINAL_REF) {
    blockers.push(`Original URL must target ${ORIGINAL_REF}`);
  }
  if (stagingUrl && originalUrl && stagingUrl === originalUrl) {
    blockers.push("Staging and original URLs must differ");
  }

  const gaps: GapItem[] = [];
  let stagingCounts: Record<string, number | null> = {};
  let originalCounts: Record<string, number | null> = {};

  if (!blockers.length) {
    const staging = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    const original = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await staging.connect();
    await original.connect();
    await staging.query("SET statement_timeout = '120s'");
    await original.query("SET statement_timeout = '120s'");

    for (const table of TABLES) {
      const sExists = await tableExists(staging, table);
      const oExists = await tableExists(original, table);
      if (sExists && !oExists) {
        gaps.push({
          id: `table.${table}`,
          surface: table,
          classification: "schema_missing",
          staging: true,
          original: false,
          notes: "Table missing on original — apply migration/DDL in Wave A.",
          wave: table.startsWith("amazon_") || table === "removal_item_allocations" ? "A" : "B",
        });
        continue;
      }
      if (!sExists && oExists) {
        gaps.push({
          id: `table.${table}`,
          surface: table,
          classification: "unsafe_to_copy_blindly",
          staging: false,
          original: true,
          notes: "Original-only table; do not overwrite from staging.",
          wave: "-",
        });
        continue;
      }
      if (!sExists && !oExists) {
        gaps.push({
          id: `table.${table}`,
          surface: table,
          classification: "schema_missing",
          staging: false,
          original: false,
          notes: "Table missing on both refs — investigate migrations.",
          wave: "A",
        });
        continue;
      }

      const sCols = await tableColumns(staging, table);
      const oCols = await tableColumns(original, table);
      for (const col of TABLE_KEY_COLUMNS[table] ?? []) {
        gaps.push(classifyColumnGap(table, col, sCols.has(col), oCols.has(col)));
      }
    }

    for (const fn of FUNCTIONS) {
      const s = await functionExists(staging, fn);
      const o = await functionExists(original, fn);
      gaps.push({
        id: `function.${fn}`,
        surface: fn,
        classification: s && o ? "already_in_parity" : s && !o ? "schema_missing" : "code_deploy_only",
        staging: s,
        original: o,
        notes: s && !o ? "Deploy function DDL on original (Wave A)." : "Function surface compared.",
        wave: "A",
      });
    }

    for (const view of VIEWS) {
      const s = await viewExists(staging, view);
      const o = await viewExists(original, view);
      const sDef = s ? await viewDefinitionHash(staging, view) : null;
      const oDef = o ? await viewDefinitionHash(original, view) : null;
      const sameDef = s && o && sDef === oDef;
      gaps.push({
        id: `view.${view}`,
        surface: view,
        classification: !s || !o ? "schema_missing" : sameDef ? "already_in_parity" : "schema_missing",
        staging: s ? (sameDef ? "present_match" : "present_drift") : false,
        original: o ? (sameDef ? "present_match" : "present_drift") : false,
        notes:
          !o ? "View missing on original." : !sameDef ? "View definition drift — re-apply v193/v205 inventory view parity scripts." : "View definition matches fingerprint.",
        wave: "A",
      });
    }

    stagingCounts = await domainCounts(staging);
    originalCounts = await domainCounts(original);

    const dataPairs: Array<{ id: string; key: string; wave: GapItem["wave"]; unsafe?: boolean }> = [
      { id: "amazon_removals_sam", key: "amazon_removals_sam", wave: "C" },
      { id: "amazon_removal_shipments_sam", key: "amazon_removal_shipments_sam", wave: "C" },
      { id: "expected_packages_derived", key: "derived", wave: "C" },
      { id: "expected_packages_derived_resolved", key: "derived_resolved", wave: "C" },
      { id: "product_identifier_map_active", key: "product_identifier_map_active", wave: "B", unsafe: true },
      { id: "product_packaging_profiles", key: "product_packaging_profiles", wave: "B" },
      { id: "return_items_resolved", key: "return_items_resolved", wave: "D" },
    ];

    for (const p of dataPairs) {
      const s = stagingCounts[p.key] ?? null;
      const o = originalCounts[p.key] ?? null;
      if (s == null && o == null) continue;
      let classification: GapClass = "already_in_parity";
      let notes = "Counts match or within expected tolerance.";
      if (o == null || o === 0) {
        classification = p.unsafe ? "unsafe_to_copy_blindly" : "data_missing";
        notes = p.unsafe
          ? "Map spine delta is staging-only governed work — replay E1/E2/E1B scripts on original, never blind copy."
          : "Original missing staging domain/data — governed import + rebuild required.";
      } else if (s != null && o != null && s !== o) {
        classification = p.id.includes("resolved") ? "data_missing" : "data_missing";
        notes = `Staging ${s} vs original ${o} — reconcile via governed execute, not bulk clone.`;
      }
      gaps.push({
        id: `data.${p.id}`,
        surface: p.id,
        classification,
        staging: s,
        original: o,
        notes,
        wave: p.wave,
      });
    }

    gaps.push({
      id: "deploy.scanner_code",
      surface: "scanner app code + env",
      classification: "code_deploy_only",
      staging: "branch merged",
      original: "Vercel production on original ref",
      notes: "Merge feature/product-canonicalization-v2 + deploy after Wave A–C parity proofs.",
      wave: "D",
    });

    gaps.push({
      id: "deploy.automation_config",
      surface: "SP-API removal fetch / domain sync automation",
      classification: "code_deploy_only",
      staging: "configured",
      original: "not configured for removal API",
      notes: "Wave C includes SP-API fetch + domain sync on original with separate approval.",
      wave: "C",
    });

    await staging.end();
    await original.end();
  }

  const schemaGaps = gaps.filter((g) => g.classification === "schema_missing").length;
  const dataGaps = gaps.filter((g) => g.classification === "data_missing").length;
  const productionReady =
    blockers.length === 0 && schemaGaps === 0 && dataGaps === 0
      ? true
      : false;

  const gapReport = [
    "# Staging vs original gap report — Phase 1 scanner",
    "",
    `Run: \`${runId}\` · Staging \`${STAGING_REF}\` · Original \`${ORIGINAL_REF}\``,
    "",
    "## Summary",
    "",
    `| Metric | Count |`,
    `|--------|------:|`,
    `| Schema gaps | **${schemaGaps}** |`,
    `| Data gaps | **${dataGaps}** |`,
    `| Already in parity | ${gaps.filter((g) => g.classification === "already_in_parity").length} |`,
    `| Code/deploy only | ${gaps.filter((g) => g.classification === "code_deploy_only").length} |`,
    `| Unsafe blind copy | ${gaps.filter((g) => g.classification === "unsafe_to_copy_blindly").length} |`,
    "",
    "## Critical data counts (Sam org/store where applicable)",
    "",
    "| Metric | Staging | Original |",
    "|--------|--------:|---------:|",
    ...Object.keys(stagingCounts)
      .sort()
      .map((k) => `| ${k} | ${stagingCounts[k] ?? "—"} | ${originalCounts[k] ?? "—"} |`),
    "",
    "## Gap inventory",
    "",
    "| Surface | Class | Wave | Staging | Original | Notes |",
    "|---------|-------|------|---------|----------|-------|",
    ...gaps.map(
      (g) =>
        `| ${g.surface} | ${g.classification} | ${g.wave} | ${g.staging} | ${g.original} | ${g.notes} |`,
    ),
  ].join("\n");

  const waves = [
    "# Phase 1 parity execution waves",
    "",
    "## Wave A — schema / views / functions (original DDL apply)",
    "",
    "1. Apply committed migrations not yet on original:",
    "   - `20260519_amazon_removals_one_row_per_staging_line.sql`",
    "   - `20260619_removal_shipment_staging_row_number.sql`",
    "   - `20260528_canonical_cross_file_expected_packages.sql` (rebuild functions + allocation)",
    "   - `20260820120000_expected_packages_resolver_columns.sql`",
    "   - `20260815150000_return_items_rename_and_scanner_resolver.sql` (if not applied)",
    "2. Re-apply inventory view parity if drift detected:",
    "   - `scripts/inventory-views-product-id-columns-v193-original-parity-apply-v195.ts`",
    "   - `scripts/main-v206-package-code-inventory-views-original-parity-apply.ts`",
    "3. Verify functions exist: `rebuild_expected_packages_from_removals`, `rebuild_removal_item_allocations`.",
    "",
    "**Gate:** all Phase 1 tables + scanner columns present on original; view fingerprint match.",
    "",
    "## Wave B — product / PIM resolver spine (governed, not bulk clone)",
    "",
    "1. Replay staging-only governed map/product promotions on original with dry-run first:",
    "   - E1 map bridge (134 rows)",
    "   - E2 product promotion (19 products + 19 map)",
    "   - E1B blocker materialize (10 + 10)",
    "   - PC03B source disagreement (6 map)",
    "2. Packaging parity only where scanner needs dimensions evidence:",
    "   - PC05 packaging backfill — use PC05E/PC05F/PC05G wave plans; original currently ~empty vs staging 191 AFI.",
    "",
    "**Gate:** resolver can resolve EP SKUs/FNSKUs on original without blind create.",
    "",
    "## Wave C — removal domain data + expected_packages rebuild",
    "",
    "1. SP-API removal reports fetch on original (order + shipment detail) — separate approval.",
    "2. Domain sync / normalized import if CSV paths required.",
    "3. `rebuild_expected_packages_from_removals(Sam org, Sam store)` on original.",
    "4. Duplicate remainder cleanup pattern from `removal-rebuild-allocation-fix-execute` if needed.",
    "5. Verify: `removal-rebuild-verify-and-resolver-dryrun.ts` against original ref — `rebuild_valid=yes`, mismatch=0.",
    "6. Resolver backfill on derived EP (`removal-expected-packages-resolver-backfill`) — map-only.",
    "",
    "**Gate:** original derived EP count ≈ staging (~5,468); allocation invariants pass.",
    "",
    "## Wave D — scanner smoke on production",
    "",
    "1. Deploy merged branch to Vercel production (original Supabase ref).",
    "2. Smoke: login, scan tracking, compare view vs EP, product name resolution.",
    "3. Neda handoff checkpoint on original (tracking `2320305295` parity).",
    "",
    "**Gate:** end-to-end scan path works on original without staging-only env vars.",
  ].join("\n");

  const schemaPlan = [
    "# Original schema parity plan",
    "",
    "## Tables",
    "",
    ...TABLES.map((t) => {
      const tg = gaps.filter((g) => g.id.startsWith(`${t}.`) || g.id === `table.${t}`);
      const missing = tg.filter((g) => g.classification === "schema_missing");
      return `### ${t}\n\n${missing.length ? missing.map((m) => `- **MISSING:** ${m.surface} — ${m.notes}`).join("\n") : "- Key columns in parity or N/A."}`;
    }),
    "",
    "## Functions",
    "",
    ...FUNCTIONS.map((fn) => {
      const g = gaps.find((x) => x.id === `function.${fn}`);
      return `- \`${fn}\`: ${g?.classification ?? "unknown"} (${g?.original})`;
    }),
    "",
    "## Views",
    "",
    ...VIEWS.map((v) => {
      const g = gaps.find((x) => x.id === `view.${v}`);
      return `- \`${v}\`: ${g?.classification ?? "unknown"} — ${g?.notes ?? ""}`;
    }),
  ].join("\n");

  const dataPlan = [
    "# Original data parity plan",
    "",
    "## Do NOT bulk-copy from staging to original",
    "",
    "Original is live production. Use governed executes with preimage + rollback per workstream.",
    "",
    "## Required data surfaces for Phase 1 scanner",
    "",
    "| Surface | Staging (Sam) | Original (Sam) | Action |",
    "|---------|--------------:|----------------:|--------|",
    `| amazon_removals | ${stagingCounts.amazon_removals_sam ?? "—"} | ${originalCounts.amazon_removals_sam ?? "—"} | SP-API fetch + import on original |`,
    `| amazon_removal_shipments | ${stagingCounts.amazon_removal_shipments_sam ?? "—"} | ${originalCounts.amazon_removal_shipments_sam ?? "—"} | SP-API fetch on original |`,
    `| derived expected_packages | ${stagingCounts.derived ?? "—"} | ${originalCounts.derived ?? "—"} | rebuild after domain data |`,
    `| EP resolved_product_id | ${stagingCounts.derived_resolved ?? "—"} | ${originalCounts.derived_resolved ?? "—"} | resolver backfill after rebuild |`,
    `| product_identifier_map (active) | ${stagingCounts.product_identifier_map_active ?? "—"} | ${originalCounts.product_identifier_map_active ?? "—"} | governed E1/E2 replays |`,
    `| packaging profiles | ${stagingCounts.product_packaging_profiles ?? "—"} | ${originalCounts.product_packaging_profiles ?? "—"} | PC05 waves as needed for scan UX |`,
    "",
    "## Staging-only DML ledger (from PC06 — must replay, not copy)",
    "",
    "- E1 map bridge, E2 promotion, E1B materialize, PC03B disagreement",
    "- PC05C packaging backfill (191 AFI)",
    "- Removal SP-API fetch + allocation fix + rebuild (20260527–20260528)",
  ].join("\n");

  const riskReport = [
    "# Cutover risk report",
    "",
    "## High risk",
    "",
    "1. **Blind DML clone** — staging spine inserts (~175 map, 29 products) must use governed scripts with rollback.",
    "2. **Production Vercel deploy before Wave A–C** — scanner code expecting columns/functions will 500 on original.",
    "3. **Resolver execute on invalid rebuild** — must verify `rebuild_valid=yes` on original before resolver backfill.",
    "",
    "## Medium risk",
    "",
    "1. **View definition drift** — v_inventory_item_status grain differs from EP; deploy wrong view breaks Neda compare.",
    "2. **Packaging optional vs required** — Phase 1 may work without full 191 AFI if product names resolve via map.",
    "",
    "## Low risk / already mitigated",
    "",
    "1. Inventory view product_id columns — original parity scripts exist (v193/v206).",
    "2. Packaging schema (PC04) — applied both refs.",
    "",
    "## Rollback posture",
    "",
    "Each wave requires operator preimage + rollback.sql pattern from staging executes before original apply.",
  ].join("\n");

  const approvalFiles = [
    "# Approval files created (default false)",
    "",
    "| File | Wave | Flags |",
    "|------|------|-------|",
    "| `.cursor/operator-approvals/original-parity-phase1-wave-a-approval.md` | A | APPROVED_TO_RUN_ORIGINAL, APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_A |",
    "| `.cursor/operator-approvals/original-parity-phase1-wave-b-approval.md` | B | APPROVED_TO_RUN_ORIGINAL, APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_B |",
    "| `.cursor/operator-approvals/original-parity-phase1-wave-c-approval.md` | C | APPROVED_TO_RUN_ORIGINAL, APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_C |",
    "| `.cursor/operator-approvals/original-parity-phase1-wave-d-approval.md` | D | APPROVED_TO_RUN_ORIGINAL, APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_D, APPROVED_VERCEL_PRODUCTION_DEPLOY |",
  ].join("\n");

  const approvalDir = path.join(process.cwd(), ".cursor/operator-approvals");
  fs.mkdirSync(approvalDir, { recursive: true });
  const approvalPaths = [
    ["original-parity-phase1-wave-a-approval.md", approvalWaveA()],
    ["original-parity-phase1-wave-b-approval.md", approvalWaveB()],
    ["original-parity-phase1-wave-c-approval.md", approvalWaveC()],
    ["original-parity-phase1-wave-d-approval.md", approvalWaveD()],
  ] as const;
  for (const [name, content] of approvalPaths) {
    const p = path.join(approvalDir, name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, content.replace("Plan run_id:", `Plan run_id: ${runId}`));
  }

  fs.writeFileSync(path.join(outDir, "staging-original-gap-report.md"), gapReport + "\n");
  fs.writeFileSync(path.join(outDir, "phase1-parity-waves.md"), waves + "\n");
  fs.writeFileSync(path.join(outDir, "original-schema-parity-plan.md"), schemaPlan + "\n");
  fs.writeFileSync(path.join(outDir, "original-data-parity-plan.md"), dataPlan + "\n");
  fs.writeFileSync(path.join(outDir, "cutover-risk-report.md"), riskReport + "\n");
  fs.writeFileSync(path.join(outDir, "approval-files.md"), approvalFiles + "\n");
  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None (read-only plan complete).\n",
  );

  const nextPrompt =
    blockers.length > 0
      ? "ORIGINAL-PARITY-PHASE1-SCANNER-PLAN — fix blockers and re-run"
      : schemaGaps > 0
        ? "ORIGINAL-PARITY-PHASE1-WAVE-A-EXECUTE — apply schema/views/functions on original (approval-gated)"
        : dataGaps > 0
          ? "ORIGINAL-PARITY-PHASE1-WAVE-B-EXECUTE — governed product/map spine replay on original"
          : "ORIGINAL-PARITY-PHASE1-WAVE-C-EXECUTE — removal domain sync + rebuild on original";

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "ORIGINAL-PARITY-PHASE1-SCANNER-PLAN",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        original_ref: ORIGINAL_REF,
        status: blockers.length ? "BLOCKED" : "PASS",
        production_ready: productionReady,
        schema_gaps_count: schemaGaps,
        data_gaps_count: dataGaps,
        staging_counts: stagingCounts,
        original_counts: originalCounts,
        gap_items: gaps.length,
        approval_files: approvalPaths.map(([n]) => `.cursor/operator-approvals/${n}`),
        exact_next_prompt: nextPrompt,
        no_db_writes: true,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: !blockers.length,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        production_ready: productionReady,
        schema_gaps_count: schemaGaps,
        data_gaps_count: dataGaps,
        next_prompt: nextPrompt,
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
