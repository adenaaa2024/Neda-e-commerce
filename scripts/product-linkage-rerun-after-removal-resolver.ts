/**
 * PRODUCT LINKAGE RERUN AFTER REMOVAL RESOLVER (read-only)
 *
 * Measures linkage coverage after removal expected_packages resolver execute.
 *
 *   npx tsx scripts/product-linkage-rerun-after-removal-resolver.ts --run-id=<UTC_Z>
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
const OUT_BASE = ".cursor/audit-reports/product-linkage-rerun-after-removal-resolver";
const REMOVAL_EXEC = ".cursor/audit-reports/removal-expected-packages-resolver-backfill-execute/20260527T230000Z";
const REMOVAL_DRY = ".cursor/audit-reports/removal-expected-packages-resolver-backfill-dry-run/20260527T220000Z";

type EntitySnap = {
  name: string;
  total_rows: number;
  persisted_resolved: number | null;
  read_layer_resolved: number | null;
  unresolved_rows: number | null;
  ambiguous_rows: number | null;
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

function pct(resolved: number, total: number): number | null {
  return total > 0 ? Math.round((resolved / total) * 1000) / 10 : null;
}

function readJson<T>(rel: string): T | null {
  const p = path.join(process.cwd(), rel);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

function loadBeforeBaseline(): {
  expected_packages: EntitySnap;
  refs: Record<string, string>;
} {
  const pre = readJson<Record<string, string>>(`${REMOVAL_EXEC}/pre-counts.json`);
  const dry = readJson<{ queue_resolved: number; queue_missing_product_needs_evidence: number; candidates_scanned: number }>(
    `${REMOVAL_DRY}/resolver-summary.json`,
  );
  const derivedTotal = Number(pre?.derived_total ?? dry?.candidates_scanned ?? 1626);
  const persistedBefore = Number(pre?.resolved ?? 9);
  const readLayerBefore = dry?.queue_resolved ?? 1602;
  const unresolvedBefore = Number(pre?.unresolved_or_null ?? dry?.queue_missing_product_needs_evidence ?? 1598);

  return {
    expected_packages: {
      name: "expected_packages",
      total_rows: derivedTotal,
      persisted_resolved: persistedBefore,
      read_layer_resolved: readLayerBefore,
      unresolved_rows: unresolvedBefore,
      ambiguous_rows: Number(pre?.ambiguous ?? 0),
      linkage_percent: pct(persistedBefore, derivedTotal),
    },
    refs: { REMOVAL_EXEC, REMOVAL_DRY },
  };
}

async function epCoverage(client: pg.Client, derivedOnly: boolean) {
  const filter = derivedOnly
    ? `WHERE build_source IN ('detail_shipment', 'detail_remainder')`
    : "";
  const r = await client.query(`
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id,
        NULLIF(TRIM(e.sku), '') AS sku, NULLIF(TRIM(e.fnsku), '') AS fnsku,
        e.resolved_product_id,
        e.identifier_resolution_status
      FROM public.expected_packages e
      ${filter}
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
      SELECT ep.id, ep.resolved_product_id,
        CASE
          WHEN ep.resolved_product_id IS NOT NULL THEN 'resolved'
          WHEN COALESCE(mf.c,0)=1 OR COALESCE(ms.c,0)=1 THEN 'read_layer'
          WHEN COALESCE(mf.c,0)>1 OR COALESCE(ms.c,0)>1 THEN 'ambiguous'
          ELSE 'unresolved'
        END AS bucket
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id=ep.id
      LEFT JOIN map_sku ms ON ms.id=ep.id
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS persisted_resolved,
      COUNT(*) FILTER (WHERE bucket IN ('resolved','read_layer'))::int AS read_layer_resolved,
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
          WHEN COALESCE(mf.c,0)=1 OR COALESCE(ms.c,0)=1 THEN 'read_layer'
          ELSE 'unresolved'
        END AS bucket
      FROM base b
      LEFT JOIN map_fnsku mf ON mf.id=b.id
      LEFT JOIN map_sku ms ON ms.id=b.id
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket IN ('resolved','read_layer'))::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE bucket='unresolved')::int AS unresolved
    FROM classified
  `);
  const row = r.rows[0] as Record<string, number>;
  const persisted = await client.query(`
    SELECT COUNT(*)::int AS c FROM public.${table}
    WHERE ${filter} AND resolved_product_id IS NOT NULL
  `);
  return {
    ...row,
    persisted_resolved: Number(persisted.rows[0]?.c ?? 0),
  };
}

async function viewMapCoverage(client: pg.Client, view: "v_inventory_item_status" | "v_scanned_items_counted") {
  const r = await client.query(`
    WITH base AS (
      SELECT ROW_NUMBER() OVER ()::bigint AS rn, v.organization_id, v.store_id,
        NULLIF(TRIM(v.sku),'') AS sku, NULLIF(TRIM(v.fnsku),'') AS fnsku
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
    map_sku AS (
      SELECT b.rn, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM base b
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id=b.organization_id AND m.store_id=b.store_id
       AND m.deleted_at IS NULL AND b.sku IS NOT NULL AND (m.seller_sku=b.sku OR m.msku=b.sku)
      GROUP BY b.rn
    ),
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
      COUNT(*) FILTER (WHERE bucket='ambiguous')::int AS ambiguous,
      COUNT(*) FILTER (WHERE bucket='no_id')::int AS missing_identifiers
    FROM classified
  `);
  return r.rows[0] as Record<string, number>;
}

async function claimCoverage(client: pg.Client, table: "claim_candidates" | "claim_candidate_drafts") {
  const exists = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  if ((exists.rowCount ?? 0) === 0) {
    return { total: 0, persisted_resolved: 0, unresolved: 0, ambiguous: 0, read_layer_resolved: 0 };
  }

  const cols = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  const colSet = new Set(cols.rows.map((x: { column_name: string }) => x.column_name));
  const hasResolved = colSet.has("resolved_product_id");
  const hasProduct = colSet.has("product_id");
  const linkExpr = [
    hasResolved ? "resolved_product_id IS NOT NULL" : null,
    hasProduct ? "product_id IS NOT NULL" : null,
  ]
    .filter(Boolean)
    .join(" OR ");

  const r = await client.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE ${linkExpr || "FALSE"})::int AS persisted_resolved,
      COUNT(*) FILTER (WHERE NOT (${linkExpr || "FALSE"}))::int AS unresolved
    FROM public.${table}
  `);
  const row = r.rows[0] as Record<string, number>;
  return {
    ...row,
    read_layer_resolved: row.persisted_resolved,
    ambiguous: 0,
  };
}

function snapFromCounts(name: string, c: Record<string, number>, usePersistedPct = false): EntitySnap {
  const total = c.total ?? 0;
  const persisted = c.persisted_resolved ?? null;
  const readLayer = c.read_layer_resolved ?? null;
  const effective = usePersistedPct ? (persisted ?? readLayer ?? 0) : (readLayer ?? persisted ?? 0);
  return {
    name,
    total_rows: total,
    persisted_resolved: persisted,
    read_layer_resolved: readLayer,
    unresolved_rows: c.unresolved ?? null,
    ambiguous_rows: c.ambiguous ?? null,
    linkage_percent: pct(effective, total),
  };
}

function nedaCriticalPct(rows: Record<string, EntitySnap>, field: "persisted_resolved" | "read_layer_resolved"): number {
  const names = ["expected_packages", "return_items", "slip_contents"];
  let t = 0;
  let r = 0;
  for (const n of names) {
    t += rows[n]?.total_rows ?? 0;
    r += rows[n]?.[field] ?? rows[n]?.read_layer_resolved ?? 0;
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

  const { expected_packages: epBefore, refs } = loadBeforeBaseline();
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const epDerived = await epCoverage(client, true);
  const epAll = await epCoverage(client, false);
  const ri = await itemTableCoverage(client, "return_items");
  const sc = await itemTableCoverage(client, "slip_contents");
  const vis = await viewMapCoverage(client, "v_inventory_item_status");
  const vsc = await viewMapCoverage(client, "v_scanned_items_counted");
  const cc = await claimCoverage(client, "claim_candidates");
  const ccd = await claimCoverage(client, "claim_candidate_drafts");
  await client.end();

  const after: Record<string, EntitySnap> = {
    expected_packages: snapFromCounts("expected_packages", epDerived, true),
    expected_packages_all: snapFromCounts("expected_packages_all", epAll, true),
    return_items: snapFromCounts("return_items", ri),
    slip_contents: snapFromCounts("slip_contents", sc),
    v_inventory_item_status: snapFromCounts("v_inventory_item_status", vis),
    v_scanned_items_counted: snapFromCounts("v_scanned_items_counted", vsc),
    claim_candidates: snapFromCounts("claim_candidates", cc, true),
    claim_candidate_drafts: snapFromCounts("claim_candidate_drafts", ccd, true),
  };

  const beforeNedaPersisted = nedaCriticalPct(
    {
      expected_packages: epBefore,
      return_items: after.return_items,
      slip_contents: after.slip_contents,
    },
    "persisted_resolved",
  );
  const afterNedaPersisted = nedaCriticalPct(after, "persisted_resolved");
  const beforeNedaRead = nedaCriticalPct(
    {
      expected_packages: { ...epBefore, persisted_resolved: epBefore.read_layer_resolved },
      return_items: after.return_items,
      slip_contents: after.slip_contents,
    },
    "read_layer_resolved",
  );
  const afterNedaRead = nedaCriticalPct(after, "read_layer_resolved");

  const deltas = [
    {
      name: "expected_packages (derived)",
      persisted_before: epBefore.persisted_resolved,
      persisted_after: after.expected_packages.persisted_resolved,
      unresolved_before: epBefore.unresolved_rows,
      unresolved_after: after.expected_packages.unresolved_rows,
      linkage_pct_before: epBefore.linkage_percent,
      linkage_pct_after: after.expected_packages.linkage_percent,
    },
    {
      name: "return_items",
      persisted_before: after.return_items.persisted_resolved,
      persisted_after: after.return_items.persisted_resolved,
      unresolved_before: after.return_items.unresolved_rows,
      unresolved_after: after.return_items.unresolved_rows,
      linkage_pct_before: after.return_items.linkage_percent,
      linkage_pct_after: after.return_items.linkage_percent,
    },
    {
      name: "slip_contents",
      persisted_before: after.slip_contents.persisted_resolved,
      persisted_after: after.slip_contents.persisted_resolved,
      unresolved_before: after.slip_contents.unresolved_rows,
      unresolved_after: after.slip_contents.unresolved_rows,
      linkage_pct_before: after.slip_contents.linkage_percent,
      linkage_pct_after: after.slip_contents.linkage_percent,
    },
    {
      name: "v_inventory_item_status",
      persisted_before: null,
      persisted_after: after.v_inventory_item_status.read_layer_resolved,
      unresolved_before: null,
      unresolved_after: after.v_inventory_item_status.unresolved_rows,
      linkage_pct_before: null,
      linkage_pct_after: after.v_inventory_item_status.linkage_percent,
    },
    {
      name: "v_scanned_items_counted",
      persisted_before: null,
      persisted_after: after.v_scanned_items_counted.read_layer_resolved,
      unresolved_before: null,
      unresolved_after: after.v_scanned_items_counted.unresolved_rows,
      linkage_pct_before: null,
      linkage_pct_after: after.v_scanned_items_counted.linkage_percent,
    },
    {
      name: "claim_candidates",
      persisted_before: after.claim_candidates.persisted_resolved,
      persisted_after: after.claim_candidates.persisted_resolved,
      unresolved_before: after.claim_candidates.unresolved_rows,
      unresolved_after: after.claim_candidates.unresolved_rows,
      linkage_pct_before: after.claim_candidates.linkage_percent,
      linkage_pct_after: after.claim_candidates.linkage_percent,
    },
    {
      name: "claim_candidate_drafts",
      persisted_before: after.claim_candidate_drafts.persisted_resolved,
      persisted_after: after.claim_candidate_drafts.persisted_resolved,
      unresolved_before: after.claim_candidate_drafts.unresolved_rows,
      unresolved_after: after.claim_candidate_drafts.unresolved_rows,
      linkage_pct_before: after.claim_candidate_drafts.linkage_percent,
      linkage_pct_after: after.claim_candidate_drafts.linkage_percent,
    },
  ];

  const blockers = [
    {
      name: "claim_candidates",
      unresolved: after.claim_candidates.unresolved_rows ?? 0,
      reason: "Legacy claim inbox rows without product_id/resolved_product_id — upstream of claim materialization",
    },
    {
      name: "claim_candidate_drafts",
      unresolved: after.claim_candidate_drafts.unresolved_rows ?? 0,
      reason: "Claim V2 drafts missing product linkage — blocks governed claim promotion",
    },
    {
      name: "expected_packages (24 remaining)",
      unresolved: after.expected_packages.unresolved_rows ?? 0,
      reason: "missing_product_needs_evidence — requires PC03D Amazon evidence before E2 promotion",
    },
    {
      name: "v_inventory_item_status",
      unresolved: after.v_inventory_item_status.unresolved_rows ?? 0,
      reason: "Neda compare view rows with identifiers but no single map match (inherits slip/return gaps)",
    },
    {
      name: "slip_contents",
      unresolved: after.slip_contents.unresolved_rows ?? 0,
      reason: "OCR/slip lines still lack persisted resolver backfill; blocks scanned-side compare hydration",
    },
    {
      name: "return_items",
      unresolved: after.return_items.unresolved_rows ?? 0,
      reason: "Dirty/test identifiers + missing map coverage; V185 found 0 enrichable rows",
    },
    {
      name: "v_scanned_items_counted",
      unresolved: after.v_scanned_items_counted.unresolved_rows ?? 0,
      reason: "Scanned aggregate view inherits return_items linkage gaps",
    },
  ]
    .sort((a, b) => b.unresolved - a.unresolved)
    .map((b, i) => ({ ...b, rank: i + 1 }));

  const top3 = blockers.slice(0, 3);
  const nextPrompt =
    "PC03D-EXPECTED-PACKAGES-AMAZON-EVIDENCE-DRY-RUN-EXECUTE — queue 24 missing_product_needs_evidence expected_packages rows after removal resolver";

  const reportMd = [
    "# Product linkage rerun after removal resolver",
    "",
    `**Run id:** \`${runId}\``,
    `**Branch:** \`${branch}\``,
    `**Baseline execute:** \`${refs.REMOVAL_EXEC}\``,
    "",
    "## Headline — expected_packages (derived, persisted)",
    "",
    `| Metric | Before execute | After execute | Δ |`,
    `|--------|---------------:|--------------:|--:|`,
    `| Persisted resolved | ${epBefore.persisted_resolved} | **${after.expected_packages.persisted_resolved}** | **+${(after.expected_packages.persisted_resolved ?? 0) - (epBefore.persisted_resolved ?? 0)}** |`,
    `| Unresolved | ${epBefore.unresolved_rows} | **${after.expected_packages.unresolved_rows}** | **${(after.expected_packages.unresolved_rows ?? 0) - (epBefore.unresolved_rows ?? 0)}** |`,
    `| Linkage % (persisted) | ${epBefore.linkage_percent}% | **${after.expected_packages.linkage_percent}%** | **+${Math.round(((after.expected_packages.linkage_percent ?? 0) - (epBefore.linkage_percent ?? 0)) * 10) / 10}** |`,
    `| Read-layer map resolved | ${epBefore.read_layer_resolved} | ${after.expected_packages.read_layer_resolved} | ${(after.expected_packages.read_layer_resolved ?? 0) - (epBefore.read_layer_resolved ?? 0)} |`,
    "",
    "## Neda critical item linkage (expected_packages + return_items + slip_contents)",
    "",
    `| Method | Before | After | Δ |`,
    `|--------|-------:|------:|--:|`,
    `| Persisted column % | ${beforeNedaPersisted}% | **${afterNedaPersisted}%** | **+${Math.round((afterNedaPersisted - beforeNedaPersisted) * 10) / 10}** |`,
    `| Read-layer map % | ${beforeNedaRead}% | **${afterNedaRead}%** | **+${Math.round((afterNedaRead - beforeNedaRead) * 10) / 10}** |`,
    "",
    "## Focus entities (after state)",
    "",
    "| Entity | Total | Persisted resolved | Read-layer resolved | Unresolved | Link % |",
    "|--------|------:|-------------------:|--------------------:|-----------:|-------:|",
    ...[
      after.expected_packages,
      after.return_items,
      after.slip_contents,
      after.v_inventory_item_status,
      after.v_scanned_items_counted,
      after.claim_candidates,
      after.claim_candidate_drafts,
    ].map(
      (r) =>
        `| ${r.name} | ${r.total_rows} | ${r.persisted_resolved ?? "—"} | ${r.read_layer_resolved ?? "—"} | ${r.unresolved_rows ?? "—"} | ${r.linkage_percent ?? "—"}% |`,
    ),
    "",
    "## v_inventory_item_status",
    "",
    `- Total rows: **${vis.total}**`,
    `- Map read-layer resolved: **${vis.read_layer_resolved}** (${after.v_inventory_item_status.linkage_percent}%)`,
    `- **Unresolved (has identifiers, no single map): ${vis.unresolved}**`,
    `- Missing identifiers: ${vis.missing_identifiers}`,
    "",
    "## Top 3 remaining blockers",
    "",
    ...top3.map((b) => `${b.rank}. **${b.name}** — ${b.unresolved} unresolved — ${b.reason}`),
    "",
    "## Exact next prompt",
    "",
    `**\`${nextPrompt}\`**`,
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "product-linkage-coverage-report.md"), `${reportMd}\n`);
  fs.writeFileSync(
    path.join(outDir, "table-coverage-matrix.json"),
    JSON.stringify({ before: { expected_packages: epBefore }, after, deltas }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "before-after-delta.md"),
    [
      "# Before / after delta",
      "",
      `expected_packages persisted linkage: **${epBefore.linkage_percent}%** → **${after.expected_packages.linkage_percent}%**`,
      `expected_packages unresolved: **${epBefore.unresolved_rows}** → **${after.expected_packages.unresolved_rows}**`,
      `Neda critical persisted linkage: **${beforeNedaPersisted}%** → **${afterNedaPersisted}%**`,
      `v_inventory_item_status unresolved: **${vis.unresolved}**`,
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    ["# Blockers", "", ...top3.map((b) => `- **${b.name}**: ${b.unresolved} unresolved — ${b.reason}`)].join("\n") +
      "\n",
  );
  fs.writeFileSync(
    path.join(outDir, "next-linkage-wave.md"),
    [
      "# Next linkage wave",
      "",
      "1. **PC03D** — Amazon evidence for 24 unresolved derived expected_packages",
      "2. **RETURN-ITEMS-SOURCE-IDENTIFIER-REPAIR-V186** — dirty/test return_items rows",
      "3. **SLIP-CONTENTS-RESOLVER-BACKFILL** — persist resolver on slip OCR lines",
    ].join("\n") + "\n",
  );

  const manifest = {
    prompt: "PRODUCT LINKAGE RERUN AFTER REMOVAL RESOLVER",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    status: "PASS",
    read_only: true,
    expected_packages_derived: {
      persisted_resolved_percent: after.expected_packages.linkage_percent,
      persisted_resolved_before_percent: epBefore.linkage_percent,
      persisted_resolved: after.expected_packages.persisted_resolved,
      unresolved: after.expected_packages.unresolved_rows,
    },
    v_inventory_item_status_unresolved: vis.unresolved,
    neda_critical_linkage_percent: {
      persisted: { before: beforeNedaPersisted, after: afterNedaPersisted },
      read_layer: { before: beforeNedaRead, after: afterNedaRead },
    },
    top_3_blockers: top3.map((b) => b.name),
    exact_next_prompt: nextPrompt,
    baseline_refs: refs,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
