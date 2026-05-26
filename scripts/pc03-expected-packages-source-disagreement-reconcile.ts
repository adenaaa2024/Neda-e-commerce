/**
 * PC03 — EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-RECONCILE
 *
 * Read-only reconcile plan for wave_b source disagreement rows (PC02).
 * Produces operator decision queue + map-bridge preview (no DB writes).
 *
 *   npx tsx scripts/pc03-expected-packages-source-disagreement-reconcile.ts --run-id=<UTC_Z>
 *   npx tsx scripts/pc03-expected-packages-source-disagreement-reconcile.ts --pc02-run-id=20260523T000000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { classifyProductBarcode } from "../lib/product-barcode-classify";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/pc03-expected-packages-source-disagreement-reconcile";
const PC02_DEFAULT = "20260523T000000Z";

type EpRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string | null;
  fnsku: string | null;
  sku: string | null;
  asin: string | null;
  build_source: string | null;
  trusted_source_product_count: number;
  resolver_product_id: string | null;
};

type SourceHit = {
  source_table: string;
  source_row_id: string;
  product_id: string;
  asin: string | null;
  product_name: string | null;
  seller_sku: string | null;
  fnsku: string | null;
  last_seen_at: string | null;
};

type MapHit = {
  map_id: string;
  product_id: string;
  seller_sku: string | null;
  msku: string | null;
  fnsku: string | null;
  asin: string | null;
  match_source: string | null;
  confidence_score: number | null;
};

type Cluster = {
  cluster_key: string;
  fnsku: string | null;
  sku: string | null;
  expected_package_ids: string[];
  source_hits: SourceHit[];
  distinct_source_product_ids: string[];
  map_hits: MapHit[];
  distinct_map_product_ids: string[];
  resolver_product_id: string | null;
  recommended_product_id: string | null;
  recommendation_rationale: string;
  operator_action: string;
  map_bridge_preview: Array<{
    organization_id: string;
    store_id: string;
    product_id: string;
    fnsku: string | null;
    seller_sku: string | null;
    asin: string | null;
    note: string;
  }>;
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

function pc02RunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--pc02-run-id="));
  return a ? a.split("=")[1]!.trim() : PC02_DEFAULT;
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function loadPc02DisagreementRows(pc02RunId: string): EpRow[] {
  const matrixPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/pc02-expected-packages-canonicalization-wave",
    pc02RunId,
    "unresolved-cohort-matrix.json",
  );
  if (!fs.existsSync(matrixPath)) {
    throw new Error(`Missing ${matrixPath}`);
  }
  const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8")) as {
    rows: Array<EpRow & { classification: string; pc02_wave: string; resolver_product_id: string | null }>;
  };
  return (matrix.rows ?? [])
    .filter((r) => r.pc02_wave === "wave_b_source_disagreement" || r.classification === "source_data_inconsistency")
    .map((r) => ({
      expected_package_id: r.expected_package_id,
      organization_id: r.organization_id,
      store_id: r.store_id,
      fnsku: r.fnsku,
      sku: r.sku,
      asin: r.asin,
      build_source: r.build_source ?? null,
      trusted_source_product_count: r.trusted_source_product_count ?? 0,
      resolver_product_id: r.resolver_product_id,
    }));
}

function clusterKey(r: EpRow): string {
  return `${(r.fnsku ?? "").toUpperCase()}|${(r.sku ?? "").toUpperCase()}`;
}

function scoreProductId(
  productId: string,
  hits: SourceHit[],
  mapHits: MapHit[],
  resolverId: string | null,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const productHits = hits.filter((h) => h.product_id === productId);
  if (productHits.some((h) => h.source_table === "amazon_amazon_fulfilled_inventory")) {
    score += 30;
    reasons.push("AFI source");
  }
  if (productHits.some((h) => h.source_table === "amazon_manage_fba_inventory")) {
    score += 20;
    reasons.push("manage_fba source");
  }
  if (productHits.some((h) => h.source_table === "amazon_fba_inventory")) {
    score += 15;
    reasons.push("fba_inventory source");
  }
  const mapForProduct = mapHits.filter((m) => m.product_id === productId);
  if (mapForProduct.length) {
    score += 25;
    reasons.push(`${mapForProduct.length} existing map row(s)`);
  }
  if (resolverId === productId) {
    score += 40;
    reasons.push("matches local resolver");
  }
  const names = productHits.map((h) => h.product_name).filter(Boolean);
  if (names.length) score += 5;
  return { score, reasons };
}

function pickRecommendation(
  hits: SourceHit[],
  mapHits: MapHit[],
  resolverId: string | null,
): { product_id: string | null; rationale: string; action: string } {
  const ids = [...new Set(hits.map((h) => h.product_id))];
  if (ids.length === 0) {
    return {
      product_id: resolverId,
      rationale: resolverId ? "No import disagreement rows expanded; resolver pick only" : "No source evidence",
      action: resolverId ? "map_bridge_after_operator_confirm" : "manual_pim_link",
    };
  }
  if (ids.length === 1) {
    return {
      product_id: ids[0]!,
      rationale: "Single distinct import product_id after expansion — disagreement may be duplicate rows",
      action: "map_bridge_after_operator_confirm",
    };
  }

  const ranked = ids
    .map((id) => {
      const { score, reasons } = scoreProductId(id, hits, mapHits, resolverId);
      return { id, score, reasons };
    })
    .sort((a, b) => b.score - a.score);

  const top = ranked[0]!;
  const second = ranked[1]!;
  if (top.score === second.score) {
    return {
      product_id: null,
      rationale: `Tie between ${top.id} and ${second.id} — operator must pick`,
      action: "operator_manual_pick",
    };
  }
  return {
    product_id: top.id,
    rationale: `Recommended ${top.id} (score ${top.score} vs ${second.score}): ${top.reasons.join("; ")}`,
    action: "map_bridge_after_operator_confirm",
  };
}

async function expandSourceHits(client: pg.Client, row: EpRow): Promise<SourceHit[]> {
  const r = await client.query(
    `
    SELECT source_table, source_row_id::text, product_id::text, asin, product_name,
      seller_sku, fnsku, last_seen_at::text
    FROM (
      SELECT 'amazon_amazon_fulfilled_inventory'::text AS source_table, a.id AS source_row_id,
        COALESCE(a.resolved_product_id, a.product_id) AS product_id,
        NULLIF(TRIM(a.asin), '') AS asin, NULL::text AS product_name,
        NULLIF(TRIM(a.seller_sku), '') AS seller_sku,
        NULLIF(TRIM(a.fulfillment_channel_sku), '') AS fnsku,
        NULL::timestamptz AS last_seen_at
      FROM public.amazon_amazon_fulfilled_inventory a
      WHERE a.organization_id = $1::uuid AND a.store_id = $2::uuid
        AND COALESCE(a.resolved_product_id, a.product_id) IS NOT NULL
        AND (($3::text IS NOT NULL AND a.fulfillment_channel_sku = $3)
          OR ($4::text IS NOT NULL AND a.seller_sku = $4))
      UNION ALL
      SELECT 'amazon_fba_inventory', f.id,
        COALESCE(f.resolved_product_id, f.product_id),
        NULLIF(TRIM(f.asin), ''), NULLIF(TRIM(f.product_name), ''),
        NULLIF(TRIM(f.sku), ''), NULLIF(TRIM(f.fnsku), ''),
        f.updated_at
      FROM public.amazon_fba_inventory f
      WHERE f.organization_id = $1::uuid AND f.store_id = $2::uuid
        AND COALESCE(f.resolved_product_id, f.product_id) IS NOT NULL
        AND (($3::text IS NOT NULL AND f.fnsku = $3) OR ($4::text IS NOT NULL AND f.sku = $4))
      UNION ALL
      SELECT 'amazon_manage_fba_inventory', mf.id,
        COALESCE(mf.resolved_product_id, mf.product_id),
        NULLIF(TRIM(mf.asin), ''), NULLIF(TRIM(mf.product_name), ''),
        NULLIF(TRIM(mf.sku), ''), NULLIF(TRIM(mf.fnsku), ''),
        mf.updated_at
      FROM public.amazon_manage_fba_inventory mf
      WHERE mf.organization_id = $1::uuid AND mf.store_id = $2::uuid
        AND COALESCE(mf.resolved_product_id, mf.product_id) IS NOT NULL
        AND (($3::text IS NOT NULL AND mf.fnsku = $3) OR ($4::text IS NOT NULL AND mf.sku = $4))
    ) s
    WHERE product_id IS NOT NULL
    ORDER BY source_table, product_id
    `,
    [row.organization_id, row.store_id, row.fnsku, row.sku],
  );
  return r.rows as SourceHit[];
}

async function expandMapHits(client: pg.Client, row: EpRow): Promise<MapHit[]> {
  const r = await client.query(
    `
    SELECT m.id::text AS map_id, m.product_id::text,
      NULLIF(TRIM(m.seller_sku), '') AS seller_sku,
      NULLIF(TRIM(m.msku), '') AS msku,
      NULLIF(TRIM(m.fnsku), '') AS fnsku,
      NULLIF(TRIM(m.asin), '') AS asin,
      m.match_source, m.confidence_score
    FROM public.product_identifier_map m
    WHERE m.organization_id = $1::uuid AND m.store_id = $2::uuid
      AND m.deleted_at IS NULL AND m.product_id IS NOT NULL
      AND (($3::text IS NOT NULL AND m.fnsku = $3)
        OR ($4::text IS NOT NULL AND (m.seller_sku = $4 OR m.msku = $4))
        OR ($5::text IS NOT NULL AND m.asin = $5))
    ORDER BY m.created_at DESC
    `,
    [row.organization_id, row.store_id, row.fnsku, row.sku, row.asin],
  );
  return r.rows as MapHit[];
}

async function productNames(client: pg.Client, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const r = await client.query(
    `SELECT id::text, product_name FROM public.products WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [ids],
  );
  return new Map(r.rows.map((x: { id: string; product_name: string }) => [x.id, x.product_name]));
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const pc02RunId = pc02RunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const epRows = loadPc02DisagreementRows(pc02RunId);
  if (!epRows.length) throw new Error("No wave_b source disagreement rows in PC02 matrix");

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error("Staging postgres guard failed");
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key || refFromSupabaseUrl(url) !== STAGING_REF) {
    throw new Error("Staging Supabase guard failed");
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const byCluster = new Map<string, EpRow[]>();
  for (const row of epRows) {
    const k = clusterKey(row);
    const list = byCluster.get(k) ?? [];
    list.push(row);
    byCluster.set(k, list);
  }

  const clusters: Cluster[] = [];

  for (const [key, rows] of byCluster) {
    const sample = rows[0]!;
    let resolverId = sample.resolver_product_id;
    if (!resolverId && sample.store_id) {
      for (const code of [sample.fnsku, sample.asin, sample.sku].filter(Boolean) as string[]) {
        const c = classifyProductBarcode(code);
        const res = await resolveScannerProductIdentifiers(sb, {
          organizationId: sample.organization_id,
          storeId: sample.store_id,
          sku: c.kind === "sku_msku" ? c.normalized : null,
          asin: c.kind === "asin" ? c.normalized : null,
          fnsku: c.kind === "fnsku" ? c.normalized : null,
          productIdentifier: c.normalized,
        });
        if (res.resolved_product_id) {
          resolverId = res.resolved_product_id;
          break;
        }
      }
    }

    const sourceHits = await expandSourceHits(client, sample);
    const mapHits = await expandMapHits(client, sample);
    const distinctSource = [...new Set(sourceHits.map((h) => h.product_id))];
    const distinctMap = [...new Set(mapHits.map((m) => m.product_id))];
    const rec = pickRecommendation(sourceHits, mapHits, resolverId);

    const mapBridgePreview: Cluster["map_bridge_preview"] = [];
    if (rec.product_id && sample.store_id) {
      if (sample.fnsku && !mapHits.some((m) => m.fnsku === sample.fnsku && m.product_id === rec.product_id)) {
        mapBridgePreview.push({
          organization_id: sample.organization_id,
          store_id: sample.store_id,
          product_id: rec.product_id,
          fnsku: sample.fnsku,
          seller_sku: null,
          asin: null,
          note: "Would insert governed FNSKU map if operator confirms",
        });
      }
      if (sample.sku && !mapHits.some((m) => (m.seller_sku === sample.sku || m.msku === sample.sku) && m.product_id === rec.product_id)) {
        mapBridgePreview.push({
          organization_id: sample.organization_id,
          store_id: sample.store_id,
          product_id: rec.product_id,
          fnsku: null,
          seller_sku: sample.sku,
          asin: null,
          note: "Would insert governed SKU map if operator confirms",
        });
      }
    }

    clusters.push({
      cluster_key: key,
      fnsku: sample.fnsku,
      sku: sample.sku,
      expected_package_ids: rows.map((r) => r.expected_package_id),
      source_hits: sourceHits,
      distinct_source_product_ids: distinctSource,
      map_hits: mapHits,
      distinct_map_product_ids: distinctMap,
      resolver_product_id: resolverId,
      recommended_product_id: rec.product_id,
      recommendation_rationale: rec.rationale,
      operator_action: rec.action,
      map_bridge_preview: mapBridgePreview,
    });
  }

  const allProductIds = [...new Set(clusters.flatMap((c) => c.distinct_source_product_ids))];
  const names = await productNames(client, allProductIds);
  await client.end();

  fs.writeFileSync(path.join(outDir, "disagreement-clusters.json"), JSON.stringify({ clusters, product_names: Object.fromEntries(names) }, null, 2));

  const operatorRows = clusters.flatMap((c) =>
    c.expected_package_ids.map((id) => ({
      expected_package_id: id,
      cluster_key: c.cluster_key,
      fnsku: c.fnsku,
      sku: c.sku,
      distinct_source_product_ids: c.distinct_source_product_ids.join(";"),
      distinct_map_product_ids: c.distinct_map_product_ids.join(";"),
      recommended_product_id: c.recommended_product_id,
      operator_action: c.operator_action,
    })),
  );

  fs.writeFileSync(
    path.join(outDir, "operator-decision-queue.csv"),
    [
      "expected_package_id,cluster_key,fnsku,sku,distinct_source_product_ids,distinct_map_product_ids,recommended_product_id,operator_action",
      ...operatorRows.map((r) =>
        [
          r.expected_package_id,
          r.cluster_key,
          r.fnsku,
          r.sku,
          r.distinct_source_product_ids,
          r.distinct_map_product_ids,
          r.recommended_product_id,
          r.operator_action,
        ]
          .map(csvEscape)
          .join(","),
      ),
    ].join("\n") + "\n",
  );

  const mapPreview = clusters.flatMap((c) =>
    c.map_bridge_preview.map((m) => ({ cluster_key: c.cluster_key, ...m, recommended_product_id: c.recommended_product_id })),
  );
  fs.writeFileSync(path.join(outDir, "map-bridge-preview.json"), JSON.stringify({ count: mapPreview.length, rows: mapPreview }, null, 2));

  const reconcileMd = [
    "# PC03 — Source disagreement reconcile plan",
    "",
    `**Run id:** \`${runId}\``,
    `**PC02 input:** \`${pc02RunId}\``,
    `**Branch:** \`${branch}\``,
    `**Staging ref:** \`${STAGING_REF}\``,
    `**Mode:** read-only (no DB writes)`,
    "",
    `**Cohort:** ${epRows.length} expected_packages rows in **${clusters.length}** identifier clusters`,
    "",
    "## Clusters",
    "",
    ...clusters.map((c, i) => {
      const nameLines = c.distinct_source_product_ids.map(
        (id) => `  - \`${id}\` — ${names.get(id) ?? "(no product_name)"}`,
      );
      return [
        `### ${i + 1}. ${c.fnsku ?? "—"} / ${c.sku ?? "—"}`,
        "",
        `- **EP rows:** ${c.expected_package_ids.length} (\`${c.expected_package_ids.join("`, `")}\`)`,
        `- **Distinct import product_ids:** ${c.distinct_source_product_ids.length}`,
        ...nameLines,
        `- **Existing map product_ids:** ${c.distinct_map_product_ids.join(", ") || "—"}`,
        `- **Resolver:** ${c.resolver_product_id ?? "—"}`,
        `- **Recommended:** ${c.recommended_product_id ?? "**OPERATOR PICK REQUIRED**"}`,
        `- **Rationale:** ${c.recommendation_rationale}`,
        `- **Action:** ${c.operator_action}`,
        `- **Map-bridge preview rows:** ${c.map_bridge_preview.length}`,
        "",
      ].join("\n");
    }),
    "## After operator confirm",
    "",
    "1. Run **PC03B — EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-MAP-EXECUTE** with approval + `map-bridge-preview.json`",
    "2. Re-run read-layer coverage — clusters should move to resolved without updating `expected_packages` columns",
    "3. Do **not** update import FKs in same prompt unless separate spine repair approval",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "reconcile-plan.md"), `${reconcileMd}\n`);

  const ties = clusters.filter((c) => c.operator_action === "operator_manual_pick");
  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "# PC03 blockers",
      "",
      "- No DB writes in this prompt.",
      ties.length ? `- **${ties.length} cluster(s)** require operator manual pick (score tie).` : "- All clusters have a scored recommendation (operator confirm still required).",
      "- Governed map insert requires separate **PC03B** approval file.",
      "- Do not bulk-update `expected_packages.resolved_product_id` — read-layer only.",
    ].join("\n") + "\n",
  );

  const readyForMap = clusters.filter((c) => c.recommended_product_id && c.map_bridge_preview.length > 0);
  const manifest = {
    prompt: "PC03 — EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-RECONCILE",
    run_id: runId,
    pc02_run_id: pc02RunId,
    branch,
    staging_ref: STAGING_REF,
    status: ties.length ? "PASS_OPERATOR_PICK_REQUIRED" : "PASS_READY_FOR_CONFIRM",
    expected_package_rows: epRows.length,
    cluster_count: clusters.length,
    operator_manual_pick_clusters: ties.length,
    map_bridge_preview_count: mapPreview.length,
    ready_for_map_execute_clusters: readyForMap.length,
    next_prompt: ties.length
      ? "PC03 — OPERATOR-PICK-SOURCE-DISAGREEMENT (manual)"
      : "PC03B — EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-MAP-EXECUTE",
    forbidden: { db_writes: false, amazon_api: false, production: false },
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
