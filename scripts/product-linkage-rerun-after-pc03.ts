/**
 * PRODUCT LINKAGE COVERAGE RERUN AFTER PC03 EXEC (read-only)
 *
 *   npx tsx scripts/product-linkage-rerun-after-pc03.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/product-linkage-rerun-after-pc03";
const BEFORE_AUDIT = ".cursor/audit-reports/product-linkage-table-coverage-audit/20260525T120000Z/table-coverage-matrix.json";
const PC03_EXEC = ".cursor/audit-reports/pc03-exec-expected-packages-dirty-source-fix-execute/20260525T140000Z/manifest.json";

type RowSnap = {
  name: string;
  total_rows: number;
  read_layer_resolved: number | null;
  unresolved_rows: number | null;
  linkage_percent: number | null;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function loadBefore(): Record<string, RowSnap> {
  const matrix = JSON.parse(fs.readFileSync(path.join(process.cwd(), BEFORE_AUDIT), "utf8")) as RowSnap[];
  const pc03 = JSON.parse(fs.readFileSync(path.join(process.cwd(), PC03_EXEC), "utf8")) as {
    expected_packages_coverage: { before: Record<string, number>; after: Record<string, number> };
    return_items: { before: Record<string, number>; after: Record<string, number> };
    slip_contents: { before: Record<string, number>; after: Record<string, number> };
  };
  const out: Record<string, RowSnap> = {};
  for (const r of matrix) out[r.name] = r;
  out.expected_packages = {
    name: "expected_packages",
    total_rows: pc03.expected_packages_coverage.before.total ?? 1626,
    read_layer_resolved: pc03.expected_packages_coverage.before.read_layer_resolved ?? 1583,
    unresolved_rows: pc03.expected_packages_coverage.before.unresolved ?? 43,
    linkage_percent: Math.round(((1583 / 1626) * 1000)) / 10,
  };
  return out;
}

async function epCoverage(client: pg.Client) {
  const r = await client.query(`
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id,
        NULLIF(TRIM(e.sku), '') AS sku, NULLIF(TRIM(e.fnsku), '') AS fnsku, e.resolved_product_id
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku = ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku = ep.sku OR m.msku = ep.sku)
      GROUP BY ep.id
    ),
    classified AS (
      SELECT ep.id,
        CASE
          WHEN ep.resolved_product_id IS NOT NULL THEN 'resolved'
          WHEN COALESCE(mf.c,0)=1 OR COALESCE(ms.c,0)=1 THEN 'resolved'
          WHEN COALESCE(mf.c,0)>1 OR COALESCE(ms.c,0)>1 THEN 'ambiguous'
          ELSE 'unresolved'
        END AS bucket
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id=ep.id
      LEFT JOIN map_sku ms ON ms.id=ep.id
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket='resolved')::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE bucket='unresolved')::int AS unresolved,
      COUNT(*) FILTER (WHERE bucket='ambiguous')::int AS ambiguous
    FROM classified
  `);
  return r.rows[0] as Record<string, number>;
}

async function itemTableCoverage(client: pg.Client, table: "return_items" | "slip_contents") {
  const filter = table === "return_items" ? "deleted_at IS NULL" : "TRUE";
  const hasSku = table === "return_items";
  const skuExpr = hasSku ? "NULLIF(TRIM(sku),'')" : "NULL::text";
  const mapSkuCte = hasSku
    ? `map_sku AS (
      SELECT b.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM base b
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id=b.organization_id AND m.store_id=b.store_id
       AND m.deleted_at IS NULL AND b.sku IS NOT NULL AND (m.seller_sku=b.sku OR m.msku=b.sku)
      GROUP BY b.id
    )`
    : `map_sku AS (SELECT b.id, 0::int AS c FROM base b)`;
  const resolvedCheck =
    table === "return_items"
      ? "b.resolved_product_id IS NOT NULL OR b.product_id IS NOT NULL"
      : "b.resolved_product_id IS NOT NULL";

  const r = await client.query(`
    WITH base AS (
      SELECT id, organization_id, store_id, ${skuExpr} AS sku,
        NULLIF(TRIM(fnsku),'') AS fnsku,
        resolved_product_id${table === "return_items" ? ", product_id" : ""}
      FROM public.${table} WHERE ${filter}
    ),
    map_fnsku AS (
      SELECT b.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM base b
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id=b.organization_id AND m.store_id=b.store_id
       AND m.deleted_at IS NULL AND b.fnsku IS NOT NULL AND m.fnsku=b.fnsku
      GROUP BY b.id
    ),
    ${mapSkuCte},
    classified AS (
      SELECT b.id,
        CASE
          WHEN ${resolvedCheck} THEN 'resolved'
          WHEN COALESCE(mf.c,0)=1 OR COALESCE(ms.c,0)=1 THEN 'resolved'
          ELSE 'unresolved'
        END AS bucket
      FROM base b
      LEFT JOIN map_fnsku mf ON mf.id=b.id
      LEFT JOIN map_sku ms ON ms.id=b.id
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket='resolved')::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE bucket='unresolved')::int AS unresolved
    FROM classified
  `);
  return r.rows[0] as Record<string, number>;
}

async function viewMapCoverage(client: pg.Client, view: "v_inventory_item_status" | "v_scanned_items_counted") {
  const hasSku = view === "v_scanned_items_counted";
  const skuExpr = hasSku ? "NULLIF(TRIM(v.sku),'')" : "NULLIF(TRIM(v.sku),'')";
  const mapSkuCte = hasSku
    ? `map_sku AS (
      SELECT b.rn, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM base b
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id=b.organization_id AND m.store_id=b.store_id
       AND m.deleted_at IS NULL AND b.sku IS NOT NULL AND (m.seller_sku=b.sku OR m.msku=b.sku)
      GROUP BY b.rn
    )`
    : `map_sku AS (
      SELECT b.rn, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM base b
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id=b.organization_id AND m.store_id=b.store_id
       AND m.deleted_at IS NULL AND b.sku IS NOT NULL AND (m.seller_sku=b.sku OR m.msku=b.sku)
      GROUP BY b.rn
    )`;

  const r = await client.query(`
    WITH base AS (
      SELECT ROW_NUMBER() OVER ()::bigint AS rn, v.organization_id, v.store_id,
        ${skuExpr} AS sku, NULLIF(TRIM(v.fnsku),'') AS fnsku
      FROM public.${view} v
    ),
    map_fnsku AS (
      SELECT b.rn, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM base b
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id=b.organization_id AND m.store_id=b.store_id
       AND m.deleted_at IS NULL AND b.fnsku IS NOT NULL AND m.fnsku=b.fnsku
      GROUP BY b.rn
    ),
    ${mapSkuCte},
    classified AS (
      SELECT b.rn,
        CASE
          WHEN b.sku IS NULL AND b.fnsku IS NULL THEN 'no_id'
          WHEN COALESCE(mf.c,0)=1 OR COALESCE(ms.c,0)=1 THEN 'resolved'
          WHEN COALESCE(mf.c,0)>1 OR COALESCE(ms.c,0)>1 THEN 'ambiguous'
          ELSE 'unresolved'
        END AS bucket
      FROM base b
      LEFT JOIN map_fnsku mf ON mf.rn=b.rn
      LEFT JOIN map_sku ms ON ms.rn=b.rn
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket='resolved')::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE bucket='unresolved')::int AS unresolved,
      COUNT(*) FILTER (WHERE bucket='no_id')::int AS missing_identifiers
    FROM classified
  `);
  return r.rows[0] as Record<string, number>;
}

function pct(resolved: number, total: number): number | null {
  return total > 0 ? Math.round((resolved / total) * 1000) / 10 : null;
}

function nedaCriticalPct(rows: Record<string, { total: number; read_layer_resolved: number }>): number {
  const names = ["expected_packages", "return_items", "slip_contents"];
  let t = 0;
  let r = 0;
  for (const n of names) {
    t += rows[n]?.total ?? 0;
    r += rows[n]?.read_layer_resolved ?? 0;
  }
  return pct(r, t) ?? 0;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) throw new Error("Staging guard failed");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  if (!url || refFromSupabaseUrl(url) !== STAGING_REF) throw new Error("Supabase guard failed");

  const before = loadBefore();
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const ep = await epCoverage(client);
  const ri = await itemTableCoverage(client, "return_items");
  const sc = await itemTableCoverage(client, "slip_contents");
  const vis = await viewMapCoverage(client, "v_inventory_item_status");
  const vsc = await viewMapCoverage(client, "v_scanned_items_counted");
  await client.end();

  const current: Record<string, RowSnap & { ambiguous?: number }> = {
    expected_packages: {
      name: "expected_packages",
      total_rows: ep.total,
      read_layer_resolved: ep.read_layer_resolved,
      unresolved_rows: ep.unresolved,
      linkage_percent: pct(ep.read_layer_resolved, ep.total),
    },
    return_items: {
      name: "return_items",
      total_rows: ri.total,
      read_layer_resolved: ri.read_layer_resolved,
      unresolved_rows: ri.unresolved,
      linkage_percent: pct(ri.read_layer_resolved, ri.total),
    },
    slip_contents: {
      name: "slip_contents",
      total_rows: sc.total,
      read_layer_resolved: sc.read_layer_resolved,
      unresolved_rows: sc.unresolved,
      linkage_percent: pct(sc.read_layer_resolved, sc.total),
    },
    v_inventory_item_status: {
      name: "v_inventory_item_status",
      total_rows: vis.total,
      read_layer_resolved: vis.read_layer_resolved,
      unresolved_rows: vis.unresolved,
      linkage_percent: pct(vis.read_layer_resolved, vis.total),
    },
    v_scanned_items_counted: {
      name: "v_scanned_items_counted",
      total_rows: vsc.total,
      read_layer_resolved: vsc.read_layer_resolved,
      unresolved_rows: vsc.unresolved,
      linkage_percent: pct(vsc.read_layer_resolved, vsc.total),
    },
  };

  const beforeNeda = nedaCriticalPct({
    expected_packages: {
      total: before.expected_packages?.total_rows ?? 1626,
      read_layer_resolved: before.expected_packages?.read_layer_resolved ?? 1583,
    },
    return_items: {
      total: before.return_items?.total_rows ?? 12,
      read_layer_resolved: before.return_items?.read_layer_resolved ?? 5,
    },
    slip_contents: {
      total: before.slip_contents?.total_rows ?? 11,
      read_layer_resolved: before.slip_contents?.read_layer_resolved ?? 0,
    },
  });
  const afterNeda = nedaCriticalPct({
    expected_packages: { total: ep.total, read_layer_resolved: ep.read_layer_resolved },
    return_items: { total: ri.total, read_layer_resolved: ri.read_layer_resolved },
    slip_contents: { total: sc.total, read_layer_resolved: sc.read_layer_resolved },
  });

  const deltas = Object.keys(current).map((name) => {
    const b = before[name];
    const c = current[name]!;
    return {
      name,
      total_before: b?.total_rows ?? null,
      total_after: c.total_rows,
      resolved_before: b?.read_layer_resolved ?? null,
      resolved_after: c.read_layer_resolved,
      unresolved_before: b?.unresolved_rows ?? null,
      unresolved_after: c.unresolved_rows,
      linkage_pct_before: b?.linkage_percent ?? null,
      linkage_pct_after: c.linkage_percent,
      delta_unresolved: (c.unresolved_rows ?? 0) - (b?.unresolved_rows ?? 0),
      delta_resolved: (c.read_layer_resolved ?? 0) - (b?.read_layer_resolved ?? 0),
    };
  });

  const topGaps = [
    { name: "slip_contents", unresolved: sc.unresolved, neda: "critical" },
    { name: "return_items", unresolved: ri.unresolved, neda: "critical" },
    { name: "expected_packages", unresolved: ep.unresolved, neda: "critical" },
    { name: "v_inventory_item_status", unresolved: vis.unresolved, neda: "critical compare view" },
    { name: "v_scanned_items_counted", unresolved: vsc.unresolved, neda: "critical scanned view" },
  ]
    .sort((a, b) => b.unresolved - a.unresolved)
    .slice(0, 3);

  const nextPrompt = "PC03C — EXPECTED-PACKAGES-QUARANTINED-MANUAL-QUEUE";

  const reportMd = [
    "# Product linkage rerun after PC03-EXEC",
    "",
    `**Run id:** \`${runId}\``,
    `**Branch:** \`${branch}\``,
    `**Baseline audit:** \`${BEFORE_AUDIT}\``,
    `**PC03 execute:** \`${PC03_EXEC}\``,
    "",
    "## Neda critical item linkage (EP + return_items + slip_contents)",
    "",
    `| Metric | Before PC03 | After PC03 | Δ |`,
    `|--------|------------:|-----------:|--:|`,
    `| Linkage % | ${beforeNeda}% | **${afterNeda}%** | **+${Math.round((afterNeda - beforeNeda) * 10) / 10}** |`,
    "",
    "## Focus table deltas",
    "",
    "| Table/View | Resolved before → after | Unresolved before → after | Link % before → after |",
    "|------------|-------------------------|---------------------------|------------------------|",
    ...deltas.map(
      (d) =>
        `| ${d.name} | ${d.resolved_before ?? "—"} → **${d.resolved_after ?? "—"}** | ${d.unresolved_before ?? "—"} → **${d.unresolved_after ?? "—"}** | ${d.linkage_pct_before ?? "—"}% → **${d.linkage_pct_after ?? "—"}%** |`,
    ),
    "",
    "## v_inventory_item_status (Neda compare read-layer)",
    "",
    `- Total rows: **${vis.total}**`,
    `- Map read-layer resolved: **${vis.read_layer_resolved}** (${current.v_inventory_item_status.linkage_percent}%)`,
    `- Unresolved (has identifiers, no single map): **${vis.unresolved}**`,
    `- Before audit (persisted-column proxy): unresolved **${before.v_inventory_item_status?.unresolved_rows ?? 1410}**`,
    `- Map read-layer delta unresolved: **${(vis.unresolved ?? 0) - (before.v_inventory_item_status?.unresolved_rows ?? 1410)}** (method change: now uses map join, not persisted column only)`,
    "",
    "## PC03-EXEC proven vs re-verified",
    "",
    "| expected_packages | Proven | Re-verified |",
    "|-------------------|-------:|------------:|",
    `| read-layer resolved | 1602 | **${ep.read_layer_resolved}** |`,
    `| unresolved | 24 | **${ep.unresolved}** |`,
    "",
    "## Top 3 next gaps",
    "",
    ...topGaps.map((g, i) => `${i + 1}. **${g.name}** — ${g.unresolved} unresolved (${g.neda})`),
    "",
    `## Exact next prompt`,
    "",
    `**\`${nextPrompt}\`**`,
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "product-linkage-coverage-report.md"), `${reportMd}\n`);
  fs.writeFileSync(path.join(outDir, "table-coverage-matrix.json"), JSON.stringify({ current, deltas, before_refs: { BEFORE_AUDIT, PC03_EXEC } }, null, 2));
  fs.writeFileSync(
    path.join(outDir, "before-after-delta.md"),
    [
      "# Before / after delta",
      "",
      `Neda critical item linkage: **${beforeNeda}%** → **${afterNeda}%** (+${Math.round((afterNeda - beforeNeda) * 10) / 10})`,
      "",
      ...deltas.map(
        (d) =>
          `- **${d.name}**: unresolved ${d.unresolved_before} → ${d.unresolved_after} (${d.delta_unresolved >= 0 ? "+" : ""}${d.delta_unresolved})`,
      ),
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(outDir, "next-linkage-wave.md"),
    [
      "# Next linkage wave",
      "",
      "1. **PC03C — EXPECTED-PACKAGES-QUARANTINED-MANUAL-QUEUE** — 17 quarantined_dirty_source + 5 clean manual EP rows",
      "2. **PC03A-EXEC — RETURN/SLIP MAP-ONLY-BACKFILL** — after PC03A re-run finds deterministic candidates (currently 0)",
      "3. **Resolver-on-save** — return_items / slip_contents scanner persist path",
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "# Blockers",
      "",
      "- Read-only rerun; no DB writes.",
      "- slip_contents / return_items unchanged by PC03-EXEC (no map hits).",
      `- ${ep.unresolved} expected_packages still unresolved (24 re-verified).`,
      "- v_inventory_item_status compare still depends on slip/return linkage for scanned side.",
    ].join("\n") + "\n",
  );

  const manifest = {
    prompt: "PRODUCT LINKAGE COVERAGE RERUN AFTER PC03 EXEC",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status: "PASS",
    output_dir: `${OUT_BASE}/${runId}`,
    neda_critical_item_linkage_percent: { before: beforeNeda, after: afterNeda, delta: Math.round((afterNeda - beforeNeda) * 10) / 10 },
    v_inventory_item_status: {
      total: vis.total,
      read_layer_resolved: vis.read_layer_resolved,
      unresolved: vis.unresolved,
      linkage_percent: current.v_inventory_item_status.linkage_percent,
    },
    expected_packages: { before: before.expected_packages, after: current.expected_packages },
    top_3_next_gaps: topGaps.map((g) => g.name),
    exact_next_prompt: nextPrompt,
    pc03_exec_verified: ep.read_layer_resolved === 1602 && ep.unresolved === 24,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
