/**
 * PHASE1 ORIGINAL PARITY PLAN AFTER ITEM-LEVEL REPAIR (read-only)
 *
 *   npx tsx scripts/phase1-original-parity-plan-after-item-level-repair.ts
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
const OUT_BASE = ".cursor/audit-reports/phase1-original-parity-plan-after-item-level-repair";
const SCHEMA_APPROVAL = ".cursor/operator-approvals/original-parity-phase1-wave-schema-approval.md";
const DATA_APPROVAL = ".cursor/operator-approvals/original-parity-phase1-wave-data-approval.md";

type GapClass =
  | "already_in_parity"
  | "safe_schema_parity"
  | "safe_data_parity"
  | "needs_execute_on_original"
  | "unsafe_manual"
  | "code_deploy_only";

type GapItem = {
  id: string;
  surface: string;
  classification: GapClass;
  staging: string | boolean | number | null;
  original: string | boolean | number | null;
  wave: "A" | "B" | "C" | "D" | "-";
  notes: string;
};

const PHASE1_MIGRATIONS = [
  {
    id: "v180-ep-resolver-columns",
    file: "20260820120000_expected_packages_resolver_columns.sql",
    probe: { type: "column" as const, table: "expected_packages", column: "resolved_product_id" },
  },
  {
    id: "tracking-group-rebuild",
    file: "20260827160000_expected_packages_tracking_group_allocation.sql",
    probe: { type: "function_body" as const, fn: "rebuild_expected_packages_from_removals", needle: "allocation_group_key" },
  },
  {
    id: "carrier-normalization-views",
    file: "20260828120000_removal_carrier_normalization_views.sql",
    probe: { type: "function" as const, fn: "normalize_removal_carrier_operational" },
  },
  {
    id: "expected-receive-split",
    file: "20260829120000_expected_receive_split.sql",
    probe: { type: "column" as const, table: "expected_packages", column: "parent_expected_package_id" },
  },
  {
    id: "item-level-receive-split",
    file: "20260830120000_expected_receive_split_item_level.sql",
    probe: { type: "function" as const, fn: "allocate_expected_item_unit" },
  },
] as const;

const FUNCTIONS = [
  "normalize_removal_tracking_operational",
  "normalize_removal_carrier_operational",
  "rebuild_expected_packages_from_removals",
  "rebuild_removal_item_allocations",
  "receive_expected_item_with_split",
  "allocate_expected_item_unit",
  "allocate_expected_items_for_return_item_ids",
  "release_expected_item_unit",
  "move_expected_item_unit",
] as const;

const VIEWS = ["v_inventory_item_status", "v_scanned_items_counted", "v_inventory_status"] as const;

const EP_COLS = [
  "resolved_product_id",
  "resolved_catalog_product_id",
  "identifier_resolution_status",
  "identifier_resolution_confidence",
  "allocation_group_key",
  "source_shipment_row_ids",
  "parent_expected_package_id",
  "receive_scope_key",
  "receive_entity_type",
  "allocated_package_id",
  "allocated_pallet_id",
  "receive_idempotency_key",
] as const;

const RI_COLS = ["resolved_product_id", "expected_item_id"] as const;

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
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1) AS ok`,
    [name],
  );
  return Boolean((r.rows[0] as { ok: boolean }).ok);
}

async function tableColumns(client: pg.Client, table: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set((r.rows as Array<{ column_name: string }>).map((x) => x.column_name));
}

async function functionExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname=$1
     ) AS ok`,
    [name],
  );
  return Boolean((r.rows[0] as { ok: boolean }).ok);
}

async function functionBody(client: pg.Client, name: string): Promise<string | null> {
  const r = await client.query(
    `SELECT pg_get_functiondef(p.oid) AS def
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname=$1
     ORDER BY p.oid LIMIT 1`,
    [name],
  );
  return (r.rows[0] as { def?: string } | undefined)?.def ?? null;
}

async function viewExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.views WHERE table_schema='public' AND table_name=$1) AS ok`,
    [name],
  );
  return Boolean((r.rows[0] as { ok: boolean }).ok);
}

function viewFingerprint(def: string | null): string | null {
  if (!def) return null;
  return `${def.length}:${def.replace(/\s+/g, " ").slice(0, 160)}`;
}

async function viewDef(client: pg.Client, name: string): Promise<string | null> {
  const r = await client.query(
    `SELECT pg_get_viewdef('public.${name.replace(/'/g, "''")}'::regclass, true) AS def`,
  );
  return (r.rows[0] as { def?: string } | undefined)?.def ?? null;
}

async function migrationVersions(client: pg.Client): Promise<string[]> {
  try {
    const r = await client.query(
      `SELECT version FROM supabase_migrations.schema_migrations ORDER BY version`,
    );
    return (r.rows as Array<{ version: string }>).map((x) => x.version);
  } catch {
    return [];
  }
}

async function domainCounts(client: pg.Client): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  const tables = [
    "amazon_removals",
    "amazon_removal_shipments",
    "expected_packages",
    "return_items",
    "products",
    "product_identifier_map",
    "product_packaging_profiles",
  ] as const;

  for (const t of tables) {
    if (!(await tableExists(client, t))) {
      out[t] = null;
      continue;
    }
    const r = await client.query(`SELECT COUNT(*)::int AS c FROM public.${t}`);
    out[t] = (r.rows[0] as { c: number }).c;
  }

  if (await tableExists(client, "amazon_removals")) {
    const r = await client.query(
      `SELECT COUNT(*)::int AS c FROM public.amazon_removals WHERE organization_id=$1 AND store_id=$2`,
      [SAM_ORG, SAM_STORE],
    );
    out.amazon_removals_sam = (r.rows[0] as { c: number }).c;
  }
  if (await tableExists(client, "amazon_removal_shipments")) {
    const r = await client.query(
      `SELECT COUNT(*)::int AS c FROM public.amazon_removal_shipments WHERE organization_id=$1 AND store_id=$2`,
      [SAM_ORG, SAM_STORE],
    );
    out.amazon_removal_shipments_sam = (r.rows[0] as { c: number }).c;
  }
  if (await tableExists(client, "expected_packages")) {
    const epCols = await tableColumns(client, "expected_packages");
    const hasBuild = epCols.has("build_source");
    const hasResolved = epCols.has("resolved_product_id");
    const hasGroup = epCols.has("allocation_group_key");
    const r = await client.query(
      `
      SELECT
        COUNT(*)::int AS ep_total,
        ${hasBuild ? "COUNT(*) FILTER (WHERE build_source IN ('detail_shipment','detail_remainder'))::int" : "0::int"} AS ep_derived,
        ${hasResolved ? "COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int" : "0::int"} AS ep_resolved,
        ${hasGroup ? "COUNT(*) FILTER (WHERE allocation_group_key IS NOT NULL)::int" : "0::int"} AS ep_with_group_key,
        ${hasBuild ? "COUNT(*) FILTER (WHERE build_source = 'receive_allocated')::int" : "0::int"} AS ep_receive_allocated
      FROM public.expected_packages
      WHERE organization_id=$1 AND store_id=$2
      `,
      [SAM_ORG, SAM_STORE],
    );
    Object.assign(out, r.rows[0] as Record<string, number>);
  }
  if (await tableExists(client, "return_items")) {
    const riCols = await tableColumns(client, "return_items");
    const r = await client.query(
      `
      SELECT
        COUNT(*)::int AS ri_total,
        ${riCols.has("resolved_product_id") ? "COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int" : "0::int"} AS ri_resolved,
        ${riCols.has("expected_item_id") ? "COUNT(*) FILTER (WHERE expected_item_id IS NOT NULL)::int" : "0::int"} AS ri_expected_item_linked
      FROM public.return_items
      WHERE organization_id=$1 AND deleted_at IS NULL
      `,
      [SAM_ORG],
    );
    Object.assign(out, r.rows[0] as Record<string, number>);
  }
  if (await tableExists(client, "product_identifier_map")) {
    const r = await client.query(
      `SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`,
    );
    out.pim_active = (r.rows[0] as { c: number }).c;
  }
  if (await tableExists(client, "product_packaging_profiles")) {
    const r = await client.query(
      `SELECT COUNT(*)::int AS profiles,
              COUNT(*) FILTER (WHERE display_label LIKE 'SPREADSHEET_%')::int AS spreadsheet_profiles
       FROM public.product_packaging_profiles`,
    );
    Object.assign(out, r.rows[0] as Record<string, number>);
  }
  return out;
}

async function probeMigration(client: pg.Client, probe: (typeof PHASE1_MIGRATIONS)[number]["probe"]): Promise<boolean> {
  if (probe.type === "column") {
    const cols = await tableColumns(client, probe.table);
    return cols.has(probe.column);
  }
  if (probe.type === "function") {
    return functionExists(client, probe.fn);
  }
  const body = await functionBody(client, probe.fn);
  return body != null && body.includes(probe.needle);
}

function classifyMigration(staging: boolean, original: boolean): GapClass {
  if (staging && original) return "already_in_parity";
  if (staging && !original) return "safe_schema_parity";
  return "unsafe_manual";
}

function approvalSchemaContent(runId: string): string {
  return `# Original parity Phase 1 — Wave schema (functions/views/migrations)

**Default:** not approved.

| Field | Value |
|-------|--------|
| Original ref | \`${ORIGINAL_REF}\` |
| Scope | Post item-level repair schema: tracking/carrier normalization, grouped EP rebuild, receive-split RPCs, inventory views |

\`\`\`text
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_SCHEMA=false
\`\`\`

## Sign-off

\`\`\`
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_SCHEMA=false
Approved by:
UTC date:
Plan run_id: ${runId}
\`\`\`
`;
}

function approvalDataContent(runId: string): string {
  return `# Original parity Phase 1 — Wave data (removal domain + resolver + rebuild)

**Default:** not approved.

| Field | Value |
|-------|--------|
| Original ref | \`${ORIGINAL_REF}\` |
| Scope | SP-API removal sync, expected_packages rebuild, resolver backfill — no blind clone |

\`\`\`text
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_DATA=false
\`\`\`

## Sign-off

\`\`\`
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_DATA=false
Approved by:
UTC date:
Plan run_id: ${runId}
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
  if (stagingUrl && refFromConnectionUrl(stagingUrl) !== STAGING_REF) blockers.push(`Staging must be ${STAGING_REF}`);
  if (originalUrl && refFromConnectionUrl(originalUrl) !== ORIGINAL_REF) blockers.push(`Original must be ${ORIGINAL_REF}`);
  if (stagingUrl && originalUrl && stagingUrl === originalUrl) blockers.push("URLs must differ");

  const gaps: GapItem[] = [];

  let stagingCounts: Record<string, number | null> = {};
  let originalCounts: Record<string, number | null> = {};
  let stagingMigrations: string[] = [];
  let originalMigrations: string[] = [];

  if (!blockers.length) {
    const staging = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    const original = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await staging.connect();
    await original.connect();
    await staging.query("SET statement_timeout = '120s'");
    await original.query("SET statement_timeout = '120s'");

    stagingMigrations = await migrationVersions(staging);
    originalMigrations = await migrationVersions(original);

    for (const m of PHASE1_MIGRATIONS) {
      const s = await probeMigration(staging, m.probe);
      const o = await probeMigration(original, m.probe);
      const cls = classifyMigration(s, o);
      gaps.push({
        id: `migration.${m.id}`,
        surface: m.file,
        classification: cls,
        staging: s,
        original: o,
        wave: cls === "safe_schema_parity" ? "A" : "-",
        notes:
          cls === "already_in_parity"
            ? "Migration effects present on both refs."
            : cls === "safe_schema_parity"
              ? "Apply committed migration on original (Wave A schema execute)."
              : "Unexpected state — manual review.",
      });
    }

    for (const fn of FUNCTIONS) {
      const s = await functionExists(staging, fn);
      const o = await functionExists(original, fn);
      gaps.push({
        id: `function.${fn}`,
        surface: fn,
        classification: s && o ? "already_in_parity" : s && !o ? "safe_schema_parity" : !s && o ? "unsafe_manual" : "needs_execute_on_original",
        staging: s,
        original: o,
        wave: s && !o ? "A" : "-",
        notes: s && !o ? "Deploy function/RPC via Wave A migration pack." : s && o ? "Present on both." : "Missing on staging — investigate.",
      });
    }

    const rebuildStaging = await functionBody(staging, "rebuild_expected_packages_from_removals");
    const rebuildOriginal = await functionBody(original, "rebuild_expected_packages_from_removals");
    const groupedStaging = rebuildStaging?.includes("allocation_group_key") ?? false;
    const groupedOriginal = rebuildOriginal?.includes("allocation_group_key") ?? false;
    gaps.push({
      id: "function.rebuild_expected_packages_grouped",
      surface: "rebuild_expected_packages_from_removals (grouped allocation)",
      classification:
        groupedStaging && groupedOriginal
          ? "already_in_parity"
          : groupedStaging && !groupedOriginal
            ? "safe_schema_parity"
            : "unsafe_manual",
      staging: groupedStaging,
      original: groupedOriginal,
      wave: groupedStaging && !groupedOriginal ? "A" : "-",
      notes: "Grouped tracking+carrier+date allocation from 20260827160000 migration.",
    });

    for (const view of VIEWS) {
      const sExists = await viewExists(staging, view);
      const oExists = await viewExists(original, view);
      const sDef = sExists ? await viewDef(staging, view) : null;
      const oDef = oExists ? await viewDef(original, view) : null;
      const sFp = viewFingerprint(sDef);
      const oFp = viewFingerprint(oDef);
      const match = sFp === oFp;
      gaps.push({
        id: `view.${view}`,
        surface: view,
        classification: !sExists || !oExists ? "safe_schema_parity" : match ? "already_in_parity" : "safe_schema_parity",
        staging: sExists ? (match ? "match" : "drift") : false,
        original: oExists ? (match ? "match" : "drift") : false,
        wave: match ? "-" : "A",
        notes: match
          ? "View fingerprint matches staging."
          : "Re-apply carrier normalization + v193/v205 inventory view parity on original.",
      });
    }

    const sEp = await tableColumns(staging, "expected_packages");
    const oEp = await tableColumns(original, "expected_packages");
    for (const col of EP_COLS) {
      const s = sEp.has(col);
      const o = oEp.has(col);
      gaps.push({
        id: `expected_packages.${col}`,
        surface: `expected_packages.${col}`,
        classification: s && o ? "already_in_parity" : s && !o ? "safe_schema_parity" : "unsafe_manual",
        staging: s,
        original: o,
        wave: s && !o ? "A" : "-",
        notes: s && !o ? "Additive column — apply via migration pack." : "",
      });
    }

    const sRi = await tableColumns(staging, "return_items");
    const oRi = await tableColumns(original, "return_items");
    for (const col of RI_COLS) {
      const s = sRi.has(col);
      const o = oRi.has(col);
      gaps.push({
        id: `return_items.${col}`,
        surface: `return_items.${col}`,
        classification: s && o ? "already_in_parity" : s && !o ? "safe_schema_parity" : "unsafe_manual",
        staging: s,
        original: o,
        wave: s && !o ? "A" : "-",
        notes: col === "expected_item_id" ? "Item-level receive split prerequisite." : "",
      });
    }

    stagingCounts = await domainCounts(staging);
    originalCounts = await domainCounts(original);

    const dataPairs: Array<{ id: string; key: string; wave: GapItem["wave"]; unsafe?: boolean }> = [
      { id: "amazon_removals_sam", key: "amazon_removals_sam", wave: "C" },
      { id: "amazon_removal_shipments_sam", key: "amazon_removal_shipments_sam", wave: "C" },
      { id: "ep_derived", key: "ep_derived", wave: "C" },
      { id: "ep_resolved", key: "ep_resolved", wave: "C" },
      { id: "ep_with_group_key", key: "ep_with_group_key", wave: "C" },
      { id: "pim_active", key: "pim_active", wave: "B", unsafe: true },
      { id: "spreadsheet_profiles", key: "spreadsheet_profiles", wave: "B" },
      { id: "ri_expected_item_linked", key: "ri_expected_item_linked", wave: "D" },
    ];

    for (const p of dataPairs) {
      const s = stagingCounts[p.key] ?? null;
      const o = originalCounts[p.key] ?? null;
      let classification: GapClass = "already_in_parity";
      let notes = "Within tolerance or parity verified.";
      if (p.key === "spreadsheet_profiles") {
        classification = s === o && s != null ? "already_in_parity" : "needs_execute_on_original";
        notes = "Re-verify spreadsheet packaging parity (571 checkpoint on both refs expected).";
      } else if (p.unsafe) {
        classification = s !== o ? "unsafe_manual" : "already_in_parity";
        notes = "Governed E1/E2/E1B/PC03B replays — never bulk clone map spine.";
      } else if (o == null || o === 0 || (s != null && o != null && s !== o)) {
        classification = "needs_execute_on_original";
        notes = `Staging ${s ?? "—"} vs original ${o ?? "—"} — governed execute after Wave A schema.`;
      }
      gaps.push({
        id: `data.${p.id}`,
        surface: p.id,
        classification,
        staging: s,
        original: o,
        wave: p.wave,
        notes,
      });
    }

    gaps.push({
      id: "code.scanner_item_actions",
      surface: "app/scanner + receive RPC wiring",
      classification: "code_deploy_only",
      staging: "branch",
      original: "production deploy pending",
      wave: "D",
      notes: "Merge feature/product-canonicalization-v2 + Vercel deploy after schema/data waves.",
    });

    gaps.push({
      id: "automation.sp_api_removal_sync",
      surface: "SP-API removal fetch + domain sync",
      classification: "needs_execute_on_original",
      staging: "executed",
      original: "not executed",
      wave: "C",
      notes: "Separate approvals: sp-api-removal-shipment-fetch, removal-reports-domain-sync.",
    });

    gaps.push({
      id: "execute.resolver_backfill",
      surface: "expected_packages resolver backfill",
      classification: "needs_execute_on_original",
      staging: "partial/executed",
      original: "not executed",
      wave: "C",
      notes: "After rebuild_valid on original — removal-expected-packages-resolver-backfill approval.",
    });

    await staging.end();
    await original.end();
  }

  const schemaGaps = gaps.filter(
    (g) => g.classification === "safe_schema_parity" && g.wave === "A",
  ).length;
  const dataGaps = gaps.filter(
    (g) =>
      g.classification === "needs_execute_on_original" ||
      g.classification === "unsafe_manual" ||
      (g.classification === "safe_data_parity" && g.wave !== "-"),
  ).length;
  const productionReady =
    blockers.length === 0 &&
    gaps.filter((g) => g.classification === "safe_schema_parity").length === 0 &&
    gaps.filter((g) => g.classification === "needs_execute_on_original").length === 0;

  const gapReport = [
    "# Staging vs original gap report — Phase 1 after item-level repair",
    "",
    `Run: \`${runId}\` · Staging \`${STAGING_REF}\` · Original \`${ORIGINAL_REF}\``,
    "",
    "## Summary",
    "",
    "| Metric | Count |",
    "|--------|------:|",
    `| Schema gaps (Wave A) | **${schemaGaps}** |`,
    `| Data gaps (Wave B/C/D) | **${dataGaps}** |`,
    `| Already in parity | ${gaps.filter((g) => g.classification === "already_in_parity").length} |`,
    `| Code/deploy only | ${gaps.filter((g) => g.classification === "code_deploy_only").length} |`,
    "",
    "## Critical counts (Sam org/store)",
    "",
    "| Metric | Staging | Original |",
    "|--------|--------:|---------:|",
    ...Object.keys({ ...stagingCounts, ...originalCounts })
      .filter((k) => stagingCounts[k] != null || originalCounts[k] != null)
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

  const wavePlan = [
    "# Phase 1 parity wave plan (post item-level repair)",
    "",
    "## Wave A — schema / functions / views",
    "",
    "Apply on original only, in order:",
    "",
    "1. `20260827160000_expected_packages_tracking_group_allocation.sql` — tracking normalization + grouped rebuild",
    "2. `20260828120000_removal_carrier_normalization_views.sql` — carrier normalization + inventory views",
    "3. `20260829120000_expected_receive_split.sql` — receive split columns + `receive_expected_item_with_split`",
    "4. `20260830120000_expected_receive_split_item_level.sql` — `expected_item_id` + allocate/release/move RPCs",
    "",
    "Verify Wave A prior work still true:",
    "- `20260820120000_expected_packages_resolver_columns.sql` (Wave A prior execute)",
    "- `rebuild_removal_item_allocations` present",
    "",
    "**Gate:** all PHASE1 functions exist on original; views match staging fingerprint; qty-only receive blocked.",
    "",
    "## Wave B — product / PIM resolver parity",
    "",
    "Governed replays (dry-run first): E1 map bridge, E2 promotion, E1B materialize, PC03B disagreement.",
    "Re-verify spreadsheet packaging: `spreadsheet-packaging-full-parity-verify.ts`.",
    "",
    "**Gate:** resolver can match EP SKUs on original without blind product create.",
    "",
    "## Wave C — removal domain + expected rebuild",
    "",
    "1. SP-API removal fetch on original",
    "2. Domain sync / tracking normalization backfill on shipment rows if needed",
    "3. `rebuild_expected_packages_from_removals` + duplicate remainder cleanup pattern",
    "4. Verify `rebuild_valid=yes` on original",
    "5. Resolver backfill on derived EP",
    "",
    "**Gate:** derived EP + allocation_group_key populated; resolver coverage > 0.",
    "",
    "## Wave D — scanner smoke on original",
    "",
    "1. Vercel production deploy (scanner code + item-actions RPC wiring)",
    "2. Item-level receive smoke (qty=3 → 3 return_items + conservation)",
    "3. Neda tracking compare smoke",
    "",
    "**Gate:** end-to-end scan/receive on original DB.",
  ].join("\n");

  const schemaPlan = [
    "# Schema / function / view plan",
    "",
    "## Migrations (probe-based)",
    "",
    ...PHASE1_MIGRATIONS.map((m) => {
      const g = gaps.find((x) => x.id === `migration.${m.id}`);
      return `- \`${m.file}\`: staging=${g?.staging} original=${g?.original} → **${g?.classification}**`;
    }),
    "",
    "## Functions",
    "",
    ...FUNCTIONS.map((fn) => {
      const g = gaps.find((x) => x.id === `function.${fn}`);
      return `- \`${fn}\`: **${g?.classification ?? "unknown"}**`;
    }),
    "",
    "## Views",
    "",
    ...VIEWS.map((v) => {
      const g = gaps.find((x) => x.id === `view.${v}`);
      return `- \`${v}\`: **${g?.classification ?? "unknown"}** — ${g?.notes ?? ""}`;
    }),
    "",
    "## schema_migrations delta (if available)",
    "",
    `Staging versions: ${stagingMigrations.length}`,
    `Original versions: ${originalMigrations.length}`,
    "",
    "Phase1 files to verify applied on original:",
    ...PHASE1_MIGRATIONS.map((m) => `- ${m.file}`),
  ].join("\n");

  const dataPlan = [
    "# Data parity plan",
    "",
    "## Do not bulk-clone staging → original",
    "",
    "| Surface | Staging | Original | Action |",
    "|---------|--------:|---------:|--------|",
    `| amazon_removals (Sam) | ${stagingCounts.amazon_removals_sam ?? "—"} | ${originalCounts.amazon_removals_sam ?? "—"} | SP-API fetch + sync (Wave C) |`,
    `| amazon_removal_shipments (Sam) | ${stagingCounts.amazon_removal_shipments_sam ?? "—"} | ${originalCounts.amazon_removal_shipments_sam ?? "—"} | SP-API fetch (Wave C) |`,
    `| derived expected_packages | ${stagingCounts.ep_derived ?? "—"} | ${originalCounts.ep_derived ?? "—"} | rebuild after domain (Wave C) |`,
    `| EP resolved_product_id | ${stagingCounts.ep_resolved ?? "—"} | ${originalCounts.ep_resolved ?? "—"} | resolver backfill (Wave C) |`,
    `| EP allocation_group_key | ${stagingCounts.ep_with_group_key ?? "—"} | ${originalCounts.ep_with_group_key ?? "—"} | rebuild with grouped migration (Wave C) |`,
    `| product_identifier_map | ${stagingCounts.pim_active ?? "—"} | ${originalCounts.pim_active ?? "—"} | governed replay (Wave B) |`,
    `| spreadsheet packaging profiles | ${stagingCounts.spreadsheet_profiles ?? "—"} | ${originalCounts.spreadsheet_profiles ?? "—"} | re-verify parity |`,
    "",
    "## Staging-only executes to replay on original",
    "",
    "- Removal SP-API fetch + allocation fix + rebuild",
    "- Resolver backfill dry-run/execute",
    "- Item-level receive repair (schema only in Wave A; data is operational smoke in Wave D)",
  ].join("\n");

  const riskReport = [
    "# Cutover risk report",
    "",
    "## High",
    "",
    "1. **Deploy scanner code before Wave A migrations** — RPCs missing → receive 500.",
    "2. **Bulk map/product clone** — ~4k map delta must use governed scripts.",
    "3. **Grouped rebuild without tracking normalization** — allocation_group_key null / wrong grain.",
    "",
    "## Medium",
    "",
    "1. **View drift** — carrier normalization changes v_inventory_item_status grain.",
    "2. **Resolver execute before rebuild_valid** — learned from staging allocation fix.",
    "",
    "## Low",
    "",
    "1. Packaging spreadsheet parity — both refs at 571 profiles per prior verify.",
    "2. EP resolver columns — already applied on original (prior Wave A execute).",
  ].join("\n");

  const approvalFilesDoc = [
    "# Approval files (default false)",
    "",
    "| File | Scope | Flags |",
    "|------|-------|-------|",
    `| \`${SCHEMA_APPROVAL}\` | Wave A schema/functions/views | APPROVED_TO_RUN_ORIGINAL, APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_SCHEMA |`,
    `| \`${DATA_APPROVAL}\` | Wave B/C data executes | APPROVED_TO_RUN_ORIGINAL, APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_DATA |`,
    "",
    "Wave D deploy uses separate Vercel/production approval when ready.",
  ].join("\n");

  const approvalDir = path.join(process.cwd(), ".cursor/operator-approvals");
  fs.mkdirSync(approvalDir, { recursive: true });
  for (const [rel, content] of [
    [SCHEMA_APPROVAL, approvalSchemaContent(runId)],
    [DATA_APPROVAL, approvalDataContent(runId)],
  ] as const) {
    const p = path.join(process.cwd(), rel);
    if (!fs.existsSync(p)) fs.writeFileSync(p, content);
  }

  fs.writeFileSync(path.join(outDir, "staging-original-gap-report.md"), gapReport + "\n");
  fs.writeFileSync(path.join(outDir, "parity-wave-plan.md"), wavePlan + "\n");
  fs.writeFileSync(path.join(outDir, "schema-function-view-plan.md"), schemaPlan + "\n");
  fs.writeFileSync(path.join(outDir, "data-parity-plan.md"), dataPlan + "\n");
  fs.writeFileSync(path.join(outDir, "risk-report.md"), riskReport + "\n");
  fs.writeFileSync(path.join(outDir, "approval-files.md"), approvalFilesDoc + "\n");
  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None.\n",
  );

  const nextPrompt =
    blockers.length > 0
      ? "PHASE1-ORIGINAL-PARITY-PLAN-AFTER-ITEM-LEVEL-REPAIR — fix blockers and re-run"
      : schemaGaps > 0
        ? "ORIGINAL-PARITY-PHASE1-WAVE-SCHEMA-EXECUTE — apply post-item-level migration pack on original (approval-gated)"
        : dataGaps > 0
          ? "ORIGINAL-PARITY-PHASE1-WAVE-DATA-EXECUTE — governed removal domain + rebuild on original (approval-gated)"
          : "ORIGINAL-PARITY-PHASE1-WAVE-D-SMOKE — deploy + scanner smoke on original";

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PHASE1-ORIGINAL-PARITY-PLAN-AFTER-ITEM-LEVEL-REPAIR",
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
        approval_files: [SCHEMA_APPROVAL, DATA_APPROVAL],
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
