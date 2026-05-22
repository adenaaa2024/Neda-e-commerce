/**
 * EXPECTED-PACKAGES-IDENTIFIER-MANUAL-REVIEW-BATCH-V202
 *
 * Read-only operator queue for identifier_manual_review cohort (+ API catalog-not-found follow-up).
 * No DB writes, no Amazon API, no AI.
 *
 *   npx tsx scripts/expected-packages-identifier-manual-review-batch-v202.ts --run-id=<id>
 *   npx tsx scripts/expected-packages-identifier-manual-review-batch-v202.ts --v201-run-id=20260522T170000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { classifyProductBarcode } from "../lib/product-barcode-classify";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/expected-packages-identifier-manual-review-batch-v202";
const V201_BASE = ".cursor/audit-reports/expected-packages-remaining-52-review-v201";
const API_EXECUTE_BASE = ".cursor/audit-reports/expected-packages-amazon-api-evidence-execute-v202";

type ReviewRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  upc: string | null;
  build_source: string | null;
  resolved_product_id: string | null;
  read_bucket: string;
  map_distinct_product_ids: string[];
  map_fnsku_product_count: number;
  map_sku_product_count: number;
  trusted_source_product_count: number;
  trusted_sample_product_name: string | null;
  trusted_sample_asin: string | null;
  trusted_single_product_id: string | null;
  classification: string;
  wave: string;
  source_evidence: string;
};

type BatchRow = ReviewRow & {
  resolver_status: string | null;
  resolver_product_id: string | null;
  resolver_confidence: number | null;
  batch_action: string;
  operator_note: string;
  priority: number;
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

function v201RunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--v201-run-id="));
  return a ? a.split("=")[1]!.trim() : "20260522T170000Z";
}

function apiExecuteRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--api-execute-run-id="));
  return a ? a.split("=")[1]!.trim() : "20260522T210000Z";
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function isDirtyIdentifier(row: ReviewRow): boolean {
  const sku = (row.sku ?? "").trim().toUpperCase();
  const fnsku = (row.fnsku ?? "").trim().toUpperCase();
  if (!row.store_id) return true;
  if (!sku && !fnsku && !row.asin && !row.upc) return true;
  if (/^(TEST|DUMMY|PLACEHOLDER|UNKNOWN|UNKNOW)$/i.test(sku)) return true;
  if (/^(TEST|DUMMY)$/i.test(fnsku)) return true;
  if (/^B[0-9A-Z]{9}$/.test(fnsku) && !row.asin) return true;
  return false;
}

function loadV201ManualRows(v201RunId: string): ReviewRow[] {
  const matrixPath = path.join(process.cwd(), V201_BASE, v201RunId, "remaining-52-matrix.json");
  if (!fs.existsSync(matrixPath)) {
    throw new Error(`Missing ${matrixPath}`);
  }
  const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8")) as { rows: ReviewRow[] };
  return (matrix.rows ?? []).filter((r) => r.classification === "identifier_manual_review");
}

async function loadApiCatalogNotFoundRowsAsync(apiRunId: string): Promise<ReviewRow[]> {
  const linesPath = path.join(process.cwd(), API_EXECUTE_BASE, apiRunId, "execute-lines.json");
  if (!fs.existsSync(linesPath)) return [];
  const lines = JSON.parse(fs.readFileSync(linesPath, "utf8")) as Array<{
    expected_package_ids: string[];
    asin: string;
    outcome: string;
  }>;
  const failed = lines.filter((l) => l.outcome === "catalog_lookup_failed");
  if (!failed.length) return [];

  const asinByEp = new Map<string, string>();
  for (const line of failed) {
    for (const id of line.expected_package_ids) {
      asinByEp.set(id, line.asin);
    }
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (!dbUrl) return [];
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const ids = [...new Set(failed.flatMap((l) => l.expected_package_ids))];
  const r = await client.query(
    `
    SELECT e.id::text AS expected_package_id, e.organization_id::text, e.store_id::text,
      NULLIF(TRIM(e.sku), '') AS sku, NULLIF(TRIM(e.fnsku), '') AS fnsku,
      NULLIF(TRIM(e.build_source), '') AS build_source, e.resolved_product_id::text
    FROM public.expected_packages e WHERE e.id = ANY($1::uuid[])
  `,
    [ids],
  );
  await client.end();
  return r.rows.map((row: Record<string, unknown>) => ({
    expected_package_id: String(row.expected_package_id),
    organization_id: String(row.organization_id),
    store_id: row.store_id ? String(row.store_id) : null,
    sku: row.sku ? String(row.sku) : null,
    fnsku: row.fnsku ? String(row.fnsku) : null,
    asin: asinByEp.get(String(row.expected_package_id)) ?? null,
    upc: null,
    build_source: row.build_source ? String(row.build_source) : null,
    resolved_product_id: row.resolved_product_id ? String(row.resolved_product_id) : null,
    read_bucket: "unresolved",
    map_distinct_product_ids: [],
    map_fnsku_product_count: 0,
    map_sku_product_count: 0,
    trusted_source_product_count: 0,
    trusted_sample_product_name: null,
    trusted_sample_asin: null,
    trusted_single_product_id: null,
    classification: "api_catalog_not_found_manual",
    wave: "wave_1_api_catalog_404",
    source_evidence: "amazon_catalog_404_us_mp",
  }));
}

function assignBatchAction(
  row: ReviewRow,
  resolver: {
    identifier_resolution_status: string | null;
    resolved_product_id: string | null;
    identifier_resolution_confidence: number | null;
  },
): { batch_action: string; operator_note: string; priority: number } {
  if (row.classification === "api_catalog_not_found_manual") {
    return {
      batch_action: "operator_verify_asin_or_manual_pim",
      operator_note: "SP-API catalog 404 in US MP — verify listing/marketplace or link in PIM manually",
      priority: 2,
    };
  }
  if (isDirtyIdentifier(row)) {
    return {
      batch_action: "quarantine_or_fix_source_identifiers",
      operator_note: "Dirty/placeholder identifiers (e.g. UNKNOW sku, ASIN-shaped FNSKU) — fix source row or quarantine",
      priority: 5,
    };
  }
  if (resolver.identifier_resolution_status === "resolved" && resolver.resolved_product_id) {
    return {
      batch_action: "verify_read_layer_refresh",
      operator_note: `Resolver finds product ${resolver.resolved_product_id} — re-run read-layer; may be classification drift`,
      priority: 1,
    };
  }
  if (resolver.identifier_resolution_status === "ambiguous") {
    return {
      batch_action: "merge_to_ambiguous_manual_queue",
      operator_note: "Local resolver ambiguous — use ambiguous picker workflow, not bulk map",
      priority: 3,
    };
  }
  if (row.trusted_single_product_id && row.map_distinct_product_ids.length === 0) {
    return {
      batch_action: "map_bridge_candidate_e1b",
      operator_note: `Trusted import product ${row.trusted_single_product_id} — governed map-only (separate E1B approval)`,
      priority: 1,
    };
  }
  if (row.trusted_sample_product_name && row.trusted_source_product_count === 0) {
    return {
      batch_action: "e2_promotion_candidate",
      operator_note: `Import name only: ${row.trusted_sample_product_name.slice(0, 50)} — E2 approval required`,
      priority: 2,
    };
  }
  if (row.map_distinct_product_ids.length === 0 && row.trusted_source_product_count === 0) {
    return {
      batch_action: "operator_pim_manual_link",
      operator_note: "No map and no trusted import spine — operator links identifiers in PIM or fixes EP row",
      priority: 4,
    };
  }
  return {
    batch_action: "operator_review_stale_identifiers",
    operator_note: row.source_evidence || "Review identifiers vs imports",
    priority: 3,
  };
}

async function coverage(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(`
    WITH ep AS (
      SELECT e.id, e.resolved_product_id,
        NULLIF(TRIM(e.fnsku), '') AS fnsku, NULLIF(TRIM(e.sku), '') AS sku
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM ep
      JOIN public.product_identifier_map m
        ON m.organization_id = (SELECT organization_id FROM public.expected_packages WHERE id = ep.id LIMIT 1)
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku = ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM ep
      JOIN public.product_identifier_map m
        ON m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku = ep.sku OR m.msku = ep.sku)
      GROUP BY ep.id
    ),
    classified AS (
      SELECT ep.id,
        CASE
          WHEN ep.resolved_product_id IS NOT NULL THEN 'resolved'
          WHEN COALESCE((SELECT c FROM map_fnsku mf WHERE mf.id = ep.id), 0) = 1 THEN 'resolved'
          WHEN COALESCE((SELECT c FROM map_sku ms WHERE ms.id = ep.id), 0) = 1 THEN 'resolved'
          WHEN COALESCE((SELECT c FROM map_fnsku mf WHERE mf.id = ep.id), 0) > 1
            OR COALESCE((SELECT c FROM map_sku ms WHERE ms.id = ep.id), 0) > 1 THEN 'ambiguous'
          ELSE 'unresolved'
        END AS bucket
      FROM ep
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket = 'resolved')::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE bucket = 'unresolved')::int AS unresolved
    FROM classified
  `);
  return r.rows[0] as Record<string, number>;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const v201RunId = v201RunIdArg();
  const apiRunId = apiExecuteRunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key || !supabaseUrlMatchesStagingRef(url, STAGING_REF)) {
    throw new Error("Staging Supabase guard failed");
  }

  const manualRows = loadV201ManualRows(v201RunId);
  const apiFollowUp = await loadApiCatalogNotFoundRowsAsync(apiRunId);
  const allRows = [...manualRows, ...apiFollowUp];

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const batchRows: BatchRow[] = [];

  for (const row of allRows) {
    if (!row.store_id) {
      batchRows.push({
        ...row,
        resolver_status: "unresolved",
        resolver_product_id: null,
        resolver_confidence: null,
        batch_action: "missing_store_id",
        operator_note: "No store_id — cannot resolve",
        priority: 5,
      });
      continue;
    }

    const codes = [row.fnsku, row.asin, row.sku, row.upc].filter(Boolean) as string[];
    let resolver = {
      identifier_resolution_status: "unresolved" as string | null,
      resolved_product_id: null as string | null,
      identifier_resolution_confidence: null as number | null,
    };

    for (const code of codes) {
      const c = classifyProductBarcode(code);
      const r = await resolveScannerProductIdentifiers(sb, {
        organizationId: row.organization_id,
        storeId: row.store_id,
        sku: c.kind === "sku_msku" ? c.normalized : null,
        asin: c.kind === "asin" ? c.normalized : null,
        fnsku: c.kind === "fnsku" ? c.normalized : null,
        upc: c.kind === "upc_ean" ? c.normalized : null,
        productIdentifier: c.normalized,
      });
      if (r.identifier_resolution_status === "resolved" && r.resolved_product_id) {
        resolver = {
          identifier_resolution_status: r.identifier_resolution_status,
          resolved_product_id: r.resolved_product_id,
          identifier_resolution_confidence: r.identifier_resolution_confidence,
        };
        break;
      }
      if (r.identifier_resolution_status === "ambiguous") {
        resolver = {
          identifier_resolution_status: r.identifier_resolution_status,
          resolved_product_id: r.resolved_product_id,
          identifier_resolution_confidence: r.identifier_resolution_confidence,
        };
        break;
      }
    }

    const action = assignBatchAction(row, resolver);
    batchRows.push({
      ...row,
      resolver_status: resolver.identifier_resolution_status,
      resolver_product_id: resolver.resolved_product_id,
      resolver_confidence: resolver.identifier_resolution_confidence,
      ...action,
    });
  }

  const byAction = new Map<string, BatchRow[]>();
  for (const r of batchRows) {
    const list = byAction.get(r.batch_action) ?? [];
    list.push(r);
    byAction.set(r.batch_action, list);
  }

  const clusterKey = (r: BatchRow) =>
    `${(r.fnsku ?? "").toUpperCase()}|${(r.sku ?? "").toUpperCase()}|${(r.asin ?? "").toUpperCase()}`;
  const clusters = new Map<string, BatchRow[]>();
  for (const r of batchRows) {
    const k = clusterKey(r);
    const list = clusters.get(k) ?? [];
    list.push(r);
    clusters.set(k, list);
  }
  const duplicateClusters = [...clusters.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, count: list.length, expected_package_ids: list.map((x) => x.expected_package_id) }));

  const mapBridgeCandidates = batchRows.filter((r) => r.batch_action === "map_bridge_candidate_e1b");

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const cov = await coverage(client);
  await client.end();

  const csvHeader = [
    "expected_package_id",
    "organization_id",
    "store_id",
    "fnsku",
    "sku",
    "asin",
    "classification",
    "wave",
    "resolver_status",
    "resolver_product_id",
    "batch_action",
    "priority",
    "operator_note",
    "trusted_single_product_id",
    "map_candidate_ids",
  ];
  fs.writeFileSync(
    path.join(outDir, "manual-review-batch-queue.csv"),
    [
      csvHeader.join(","),
      ...batchRows
        .sort((a, b) => a.priority - b.priority || a.expected_package_id.localeCompare(b.expected_package_id))
        .map((r) =>
          [
            r.expected_package_id,
            r.organization_id,
            r.store_id,
            r.fnsku,
            r.sku,
            r.asin,
            r.classification,
            r.wave,
            r.resolver_status,
            r.resolver_product_id,
            r.batch_action,
            r.priority,
            r.operator_note,
            r.trusted_single_product_id,
            r.map_distinct_product_ids.join(";"),
          ]
            .map(csvEscape)
            .join(","),
        ),
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "map-bridge-candidates.json"),
    JSON.stringify(
      {
        count: mapBridgeCandidates.length,
        rows: mapBridgeCandidates.map((r) => ({
          expected_package_id: r.expected_package_id,
          trusted_single_product_id: r.trusted_single_product_id,
          fnsku: r.fnsku,
          sku: r.sku,
          asin: r.asin,
        })),
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "duplicate-identifier-clusters.json"),
    JSON.stringify({ cluster_count: duplicateClusters.length, clusters: duplicateClusters }, null, 2),
  );

  const top10 = [...batchRows].sort((a, b) => a.priority - b.priority).slice(0, 10);
  fs.writeFileSync(
    path.join(outDir, "top-priority-rows.md"),
    [
      "# Top priority manual review rows",
      "",
      ...top10.map(
        (r, i) =>
          `## ${i + 1}. \`${r.expected_package_id}\`\n\n- **Action:** ${r.batch_action}\n- **Note:** ${r.operator_note}\n- **FNSKU/SKU/ASIN:** ${r.fnsku ?? "—"} / ${r.sku ?? "—"} / ${r.asin ?? "—"}\n`,
      ),
    ].join("\n") + "\n",
  );

  const actionCounts = Object.fromEntries([...byAction].map(([k, v]) => [k, v.length]));

  fs.writeFileSync(
    path.join(outDir, "batch-summary.md"),
    [
      "# Identifier manual review batch (V202)",
      "",
      `**Run id:** \`${runId}\``,
      `**V201 source:** \`${v201RunId}\``,
      `**API execute follow-up:** \`${apiRunId}\``,
      `**Mode:** read-only (resolver probe only; no DB writes)`,
      "",
      "## Cohort size",
      "",
      `| Source | Rows |`,
      `|--------|-----:|`,
      `| V201 identifier_manual_review | ${manualRows.length} |`,
      `| API catalog 404 follow-up | ${apiFollowUp.length} |`,
      `| **Total queued** | **${batchRows.length}** |`,
      "",
      "## Live coverage",
      "",
      `| Metric | Count |`,
      `|--------|------:|`,
      `| Read-layer resolved | ${cov.read_layer_resolved} / ${cov.total} |`,
      `| Unresolved | ${cov.unresolved} |`,
      "",
      "## Batch actions",
      "",
      ...Object.entries(actionCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `- **${k}:** ${n}`),
      "",
      `**Duplicate identifier clusters:** ${duplicateClusters.length} (same fnsku/sku/asin on multiple EP rows)`,
      "",
      "## Operator guidance",
      "",
      "1. Start with \`priority=1\` rows in \`manual-review-batch-queue.csv\`.",
      "2. \`map_bridge_candidate_e1b\` → separate governed E1B map-only execute (not this batch).",
      "3. \`quarantine_or_fix_source_identifiers\` → fix UNKNOW/placeholder source data first.",
      "4. Do **not** blind bulk product create or Amazon API from this queue.",
      "",
      "## Next execute prompts",
      "",
      "- \`EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-RECONCILE-PLAN-V202\` — 6 rows",
      "- \`EXPECTED-PACKAGES-E1B-MAP-BRIDGE-MANUAL-EXECUTE-V202\` — if map-bridge-candidates.json non-empty + approval",
      "- \`EXPECTED-PACKAGES-DIRTY-TEST-QUARANTINE-V202\` — optional cleanup wave",
    ].join("\n") + "\n",
  );

  const blockers: string[] = [];
  if (manualRows.length !== 38) {
    blockers.push(`V201 manual cohort was ${manualRows.length} rows (expected 38) — re-run V201 if drift.`);
  }

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length
      ? ["# Notes", "", ...blockers.map((b) => `- ${b}`)].join("\n") + "\n"
      : "# Blockers\n\nNone — batch queue ready for operator review (no auto-execute in this prompt).\n",
  );

  const status = batchRows.length > 0 ? "PASS" : "FAIL_EMPTY";
  const manifest = {
    prompt: "EXPECTED-PACKAGES-IDENTIFIER-MANUAL-REVIEW-BATCH-V202",
    run_id: runId,
    v201_run_id: v201RunId,
    api_execute_run_id: apiRunId,
    staging_ref: STAGING_REF,
    status,
    cohort: {
      identifier_manual_from_v201: manualRows.length,
      api_catalog_404_follow_up: apiFollowUp.length,
      total_queued: batchRows.length,
    },
    batch_action_counts: actionCounts,
    duplicate_cluster_count: duplicateClusters.length,
    map_bridge_candidate_count: mapBridgeCandidates.length,
    live_coverage: cov,
    next_prompt:
      mapBridgeCandidates.length > 0
        ? "EXPECTED-PACKAGES-E1B-MAP-BRIDGE-MANUAL-EXECUTE-V202"
        : "EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-RECONCILE-PLAN-V202",
    forbidden: {
      db_writes: false,
      amazon_api: false,
      production: false,
      blind_bulk: false,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
