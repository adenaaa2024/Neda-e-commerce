/**
 * Explain expected_packages vs v_inventory_item_status row counts (read-only).
 *
 *   npx tsx scripts/view-row-explain-expected-vs-inventory-status.ts --tracking=2320305295
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT_BASE = ".cursor/audit-reports/view-row-explain-expected-vs-inventory-status";
const DEFAULT_TRACKING = "2320305295";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function trackingArg(): string {
  const a = process.argv.find((x) => x.startsWith("--tracking="));
  return a ? a.split("=")[1]!.trim() : DEFAULT_TRACKING;
}

/** Same normalization as v_inventory_item_status expected_totals CTE. */
function viewTrackingNormSql(col: string): string {
  return `TRIM(BOTH ' []"' FROM split_part(${col}, ',', 1))`;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const tracking = trackingArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const client = new pg.Client({
    connectionString: process.env.STAGING_DIRECT_POSTGRES_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const viewDef = await client.query(
    `SELECT pg_get_viewdef('public.v_inventory_item_status'::regclass, true) AS def`,
  );
  const viewDefText = String(viewDef.rows[0]?.def ?? "");

  const epExact = await client.query(
    `SELECT id, tracking_number, order_id, sku, fnsku, disposition, build_source, build_status,
            expected_scan_quantity, actual_scanned_count, id_slip_contents, carrier,
            resolved_product_id, identifier_resolution_status, shipment_date, created_at
     FROM expected_packages
     WHERE ${viewTrackingNormSql("tracking_number")} = $1
     ORDER BY sku, fnsku, build_source, id`,
    [tracking],
  );

  const epIlike = await client.query(
    `SELECT id, tracking_number, order_id, sku, fnsku, disposition, build_source,
            expected_scan_quantity, id_slip_contents
     FROM expected_packages
     WHERE tracking_number ILIKE $1
     ORDER BY sku, fnsku, id`,
    [`%${tracking}%`],
  );

  const viewExact = await client.query(
    `SELECT * FROM v_inventory_item_status
     WHERE tracking_number = $1
     ORDER BY sku, fnsku, slip_code NULLS LAST`,
    [tracking],
  );

  const viewIlike = await client.query(
    `SELECT * FROM v_inventory_item_status
     WHERE tracking_number ILIKE $1
     ORDER BY sku, fnsku`,
    [`%${tracking}%`],
  );

  const epAggSim = await client.query(
    `SELECT ${viewTrackingNormSql("tracking_number")} AS tracking_norm,
            id_slip_contents AS slip_code, sku, fnsku,
            COUNT(*) AS raw_row_count,
            SUM(expected_scan_quantity)::numeric AS sum_expected,
            array_agg(DISTINCT build_source) AS build_sources,
            array_agg(id::text ORDER BY id) AS ep_ids
     FROM expected_packages
     WHERE ${viewTrackingNormSql("tracking_number")} = $1
     GROUP BY 1, 2, 3, 4
     ORDER BY sku, fnsku`,
    [tracking],
  );

  const scannedOnly = await client.query(
    `SELECT s.* FROM v_scanned_items_counted s
     WHERE s.tracking_number = $1
       AND NOT EXISTS (
         SELECT 1 FROM expected_packages ep
         WHERE ${viewTrackingNormSql("ep.tracking_number")} = s.tracking_number
           AND ep.id_slip_contents IS NOT DISTINCT FROM s.slip_code
           AND ep.sku IS NOT DISTINCT FROM s.sku
           AND ep.fnsku IS NOT DISTINCT FROM s.fnsku
       )`,
    [tracking],
  );

  await client.end();

  const epExactRows = epExact.rows;
  const viewExactRows = viewExact.rows;
  const epAggRows = epAggSim.rows;

  const expansionFactors: string[] = [];
  if (epIlike.rows.length > epExactRows.length) {
    expansionFactors.push(
      `Compound tracking_number strings: ${epIlike.rows.length} ILIKE hits vs ${epExactRows.length} normalized first-token matches`,
    );
  }
  if (viewExactRows.length > epAggRows.length) {
    expansionFactors.push(
      `View row count (${viewExactRows.length}) exceeds EP aggregate groups (${epAggRows.length}) — likely scanned-only UNION lines or extended view columns/joins on staging`,
    );
  }
  if (scannedOnly.rows.length > 0) {
    expansionFactors.push(
      `${scannedOnly.rows.length} scanned-only line(s) in v_scanned_items_counted with no matching expected_packages sku/fnsku/slip`,
    );
  }

  const hasProductCols = viewExactRows[0]
    ? Object.keys(viewExactRows[0] as object).includes("resolved_product_id")
    : viewDefText.includes("resolved_product_id");

  const correct =
    epExactRows.length >= epAggRows.length &&
    viewExactRows.length >= epAggRows.length &&
    viewExactRows.reduce((s, r) => s + Number(r.total_expected ?? 0), 0) >=
      epExactRows.reduce((s, r) => s + Number(r.expected_scan_quantity ?? 0), 0) * 0.99;

  fs.writeFileSync(
    path.join(outDir, "expected-packages-sample.json"),
    JSON.stringify(
      {
        tracking,
        match: "normalized_first_tracking_token",
        raw_row_count: epExactRows.length,
        ilike_row_count: epIlike.rows.length,
        aggregate_group_count: epAggRows.length,
        rows: epExactRows,
        aggregate_simulation: epAggRows,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "inventory-status-sample.json"),
    JSON.stringify(
      {
        tracking,
        exact_match_count: viewExactRows.length,
        ilike_match_count: viewIlike.rows.length,
        sum_total_expected: viewExactRows.reduce((s, r) => s + Number(r.total_expected ?? 0), 0),
        rows: viewExactRows,
        scanned_only_lines: scannedOnly.rows,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "view-definition-notes.md"),
    [
      "# v_inventory_item_status — view definition notes",
      "",
      "**Canonical migration:** `supabase/migrations/20260824120000_inventory_views_neda_snapshot_v180.sql`",
      "",
      "## Base grain (V180)",
      "",
      "1. **expected_totals CTE** — aggregates `expected_packages` by:",
      "   - `organization_id`, `store_id`",
      "   - **first comma token** of `tracking_number` (trim brackets/quotes)",
      "   - `id_slip_contents` (slip_code)",
      "   - `sku`, `fnsku`",
      "   - `SUM(expected_scan_quantity)` → `total_expected`",
      "",
      "2. **scanned_totals CTE** — rows from `v_scanned_items_counted` (return_items scans) with `total_scanned`",
      "",
      "3. **UNION ALL** expected + scanned, then **re-group** same keys → one compare row per line",
      "",
      "4. **Output grain:** one row per `(org, store, tracking_norm, slip_code, sku, fnsku)` compare line",
      "",
      hasProductCols
        ? "## Staging extension\n\nLive view includes product linkage columns (`resolved_product_id`, `product_name`, etc.) from a post-V180 deploy — grain unchanged; enrichment joined after aggregate.\n"
        : "",
      "## Live viewdef (staging)",
      "",
      "```sql",
      viewDefText.slice(0, 12000),
      viewDefText.length > 12000 ? "\n-- ... truncated" : "",
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "row-count-explanation.md"),
    [
      "# Row count explanation — expected_packages vs v_inventory_item_status",
      "",
      `**Tracking:** \`${tracking}\` | **Run:** \`${OUT_BASE}/${runId}/\``,
      "",
      "## Counts (this audit)",
      "",
      "| Surface | Match rule | Rows |",
      "|---------|------------|-----:|",
      `| \`expected_packages\` (raw) | normalized first tracking token | **${epExactRows.length}** |`,
      `| \`expected_packages\` (raw) | ILIKE substring | ${epIlike.rows.length} |`,
      `| EP aggregate groups (view-equivalent keys) | sku+fnsku+slip | **${epAggRows.length}** |`,
      `| \`v_inventory_item_status\` | exact \`tracking_number\` | **${viewExactRows.length}** |`,
      `| Scanned-only lines (no EP match) | — | ${scannedOnly.rows.length} |`,
      "",
      "## Grain comparison",
      "",
      "| Layer | Grain | Purpose |",
      "|-------|-------|---------|",
      "| **expected_packages** | One row per removal/build allocation (detail_shipment, detail_remainder, CSV row, etc.) | Source truth for Amazon removal ingest + resolver |",
      "| **EP → view expected_totals** | Roll up to `(tracking_norm, slip_code, sku, fnsku)` | Collapse duplicate allocations with same identifiers |",
      "| **v_inventory_item_status** | One **compare line** per `(tracking, slip, sku, fnsku)` | Operator scan gate: expected vs scanned qty + status chip |",
      "| **Removal detail/remainder** | Multiple EP rows can share sku/fnsku if build_source splits qty | Not separate view rows when keys match — quantities **sum** |",
      "",
      "## Why 2 EP rows can become 7 view rows",
      "",
      "Not because the view expands a single EP row 1→N for the same sku/fnsku. Typical causes:",
      "",
      "1. **Different sku/fnsku lines** — each distinct product line is its own view row (expected qty 7 might be 6+1 across two SKUs → 2 view rows, not 7).",
      "2. **More EP rows than the 2-row snapshot** — compound `tracking_number` fields (`\"2320305295, 2320305295, …\"`) match many raw EP rows under ILIKE but collapse under normalized tracking.",
      "3. **UNION with scanned_totals** — return_items scanned under same tracking but sku/fnsku not in expected_packages adds view rows (scanned-only / in_progress_not).",
      "4. **Different slip_code** — same tracking + sku but different `id_slip_contents` → separate view rows.",
      "",
      "### Expansion factors for this tracking",
      "",
      ...(expansionFactors.length ? expansionFactors.map((f) => `- ${f}`) : ["- None beyond sku/fnsku/slip grain (counts align with aggregate simulation)."]),
      "",
      "## Example aggregate (normalized tracking)",
      "",
      "| sku | fnsku | slip | raw EP rows | sum expected |",
      "|-----|-------|------|------------:|-------------:|",
      ...epAggRows.map(
        (r) =>
          `| ${r.sku ?? "—"} | ${r.fnsku ?? "—"} | ${r.slip_code ?? "—"} | ${r.raw_row_count} | ${r.sum_expected} |`,
      ),
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "correctness-verdict.md"),
    [
      "# Correctness verdict",
      "",
      `**Tracking:** \`${tracking}\``,
      "",
      "## Verdict: **" + (correct ? "CORRECT — by design" : "REVIEW — count mismatch needs operator check") + "**",
      "",
      "The view is a **scan/compare read model**, not a 1:1 mirror of `expected_packages`:",
      "",
      "- Raw EP preserves **build provenance** (detail_shipment vs detail_remainder, duplicate CSV rows).",
      "- View collapses to **operator line items** (sku/fnsku/slip/tracking) and unions **scanned** activity.",
      "- Neda gate should use **view rows** for line table + totals; use **EP detail** for resolver columns and package-level context.",
      "",
      correct
        ? "For this tracking, view `total_expected` sums are consistent with EP `expected_scan_quantity` sums at the aggregate grain."
        : "Sum(expected) drift detected — inspect compound tracking strings and scanned-only union lines in sample JSON.",
    ].join("\n") + "\n",
  );

  const manifest = {
    prompt: "EXPLAIN EXPECTED_PACKAGES VS V_INVENTORY_ITEM_STATUS ROW COUNTS",
    run_id: runId,
    tracking_number: tracking,
    branch: execSync("git branch --show-current", { encoding: "utf8" }).trim(),
    expected_packages_raw_count: epExactRows.length,
    expected_packages_aggregate_groups: epAggRows.length,
    inventory_status_view_count: viewExactRows.length,
    scanned_only_lines: scannedOnly.rows.length,
    behavior_correct: correct,
    explanation_summary:
      "expected_packages is raw allocation grain; v_inventory_item_status is aggregated compare grain (tracking_norm + slip + sku + fnsku) with optional scanned-only union rows.",
    exact_next_prompt: correct
      ? "NEDA OPERATOR SCAN — use view for line counts; EP detail for resolver when expected_package_id known"
      : "VIEW ROW COUNT REMEDIATION — reconcile EP compound tracking strings vs view normalization",
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
