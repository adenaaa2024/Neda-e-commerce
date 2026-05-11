/**
 * NEXT-18F — Cross-product conflict cluster review.
 *
 * Strictly OFFLINE. No Supabase client, no SELECTs, no RPCs, no writes to any
 * source table. Reads only the existing dry-run reports under
 *   .cursor/audit-reports/next-18a/<runId>/
 * and emits a consolidated, severity-scored, human-review-ready set of files at
 *   .cursor/audit-reports/next-18f/<runId>/
 *
 * Inputs (auto-selected by manifest.cliArgs.sourceTables + finishedAt):
 *   - amazon_amazon_fulfilled_inventory
 *   - amazon_manage_fba_inventory
 *   - amazon_fba_inventory
 *
 * Outputs:
 *   manifest.json
 *   run-summary.json
 *   00-conflict-clusters.csv
 *   01-conflict-clusters.json
 *   02-conflict-products.csv
 *   logs/selection-trace.txt
 *   logs/parse-warnings.ndjson
 *
 * Run:
 *   npx tsx scripts/product-seed-conflict-cluster-review.ts
 *
 * Optional flags (defaults: auto-select latest finished run per table):
 *   --afi-run=<runId>
 *   --manage-fba-run=<runId>
 *   --fba-inv-run=<runId>
 *   --output-dir=<path>
 *
 * Plan: .cursor/plans/conflict_cluster_review_139b82b6.plan.md
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  mkRunDir,
  mkRunId,
  sha256Hex,
  writeCsv,
  writeJson,
  writeManifest,
  writeRunSummary,
  type RunMetadata,
} from "../lib/audits/product-seed-output";
import {
  buildClusters,
  extractVendorHint,
  mergeEvidence,
  parseConflictCsv,
  parseNdjsonBucket5,
  selectInputRuns,
  SEVERITY_LEVELS,
  TARGET_SOURCE_TABLES,
  type Cluster,
  type EvidenceRow,
  type ParseWarning,
  type ResolvedInputRun,
  type Severity,
  type TargetSourceTable,
} from "../lib/audits/product-seed-conflict-aggregator";
import { isUuidString } from "../lib/uuid";

const INPUT_BASE_DIR = path.join(".cursor", "audit-reports", "next-18a");
const OUTPUT_BASE_DIR = path.join(".cursor", "audit-reports", "next-18f");

const SEVERITY_THRESHOLDS = {
  critical: "n_pids >= 4 OR (n_pids >= 3 AND n_tables >= 2)",
  high: "n_pids >= 3 OR (n_pids === 2 AND n_tables >= 2)",
  medium: "n_pids === 2 AND n_tables === 1 AND n_rows >= 2",
  low: "n_pids === 2 AND n_tables === 1 AND n_rows === 1",
} as const;

const PARTIAL_TRIAD_WARN_THRESHOLD = 0.1;

type Cli = {
  overrides: Partial<Record<TargetSourceTable, string>>;
  outputDir: string | null;
};

function parseCli(argv: string[]): Cli {
  const overrides: Partial<Record<TargetSourceTable, string>> = {};
  let outputDir: string | null = null;
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--afi-run=")) {
      overrides.amazon_amazon_fulfilled_inventory = arg.slice("--afi-run=".length);
    } else if (arg.startsWith("--manage-fba-run=")) {
      overrides.amazon_manage_fba_inventory = arg.slice("--manage-fba-run=".length);
    } else if (arg.startsWith("--fba-inv-run=")) {
      overrides.amazon_fba_inventory = arg.slice("--fba-inv-run=".length);
    } else if (arg.startsWith("--output-dir=")) {
      outputDir = arg.slice("--output-dir=".length);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`[review] unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }
  return { overrides, outputDir };
}

function printHelp(): void {
  console.error(
    [
      "Usage: npx tsx scripts/product-seed-conflict-cluster-review.ts [flags]",
      "",
      "Flags:",
      "  --afi-run=<runId>           Override AFI source run",
      "  --manage-fba-run=<runId>    Override manage_fba_inventory source run",
      "  --fba-inv-run=<runId>       Override amazon_fba_inventory source run",
      "  --output-dir=<path>         Override the default output run directory",
    ].join("\n"),
  );
}

type JCheckResult =
  | { name: string; pass: true; strict: boolean; note?: string }
  | { name: string; pass: false; strict: boolean; note: string; offenders?: unknown[] };

function runJChecks(args: {
  clusters: Cluster[];
  excludedClusters: Cluster[];
  excludedEvidenceRows: number;
  inputs: Record<TargetSourceTable, ResolvedInputRun>;
}): JCheckResult[] {
  const { clusters, excludedClusters, excludedEvidenceRows, inputs } = args;
  const results: JCheckResult[] = [];

  const j1Bad = clusters.filter((c) => c.distinct_conflicting_product_ids < 2);
  results.push(
    j1Bad.length === 0
      ? {
          name: "J1_every_cluster_has_two_plus_pids",
          pass: true,
          strict: true,
          note: `${excludedClusters.length} non-cross-product cluster(s) excluded from main output (${excludedEvidenceRows} row(s)); see run-summary.excluded_non_cross_product`,
        }
      : {
          name: "J1_every_cluster_has_two_plus_pids",
          pass: false,
          strict: true,
          note: `${j1Bad.length} cluster(s) have <2 distinct conflicting product_ids`,
          offenders: j1Bad.slice(0, 5).map((c) => c.cluster_id),
        },
  );

  const j2Bad: string[] = [];
  for (const c of clusters) {
    const expected = sha256Hex(`${c.clusterKey}|${c.conflicting_product_ids.join(",")}`).slice(0, 12);
    if (expected !== c.cluster_id) j2Bad.push(c.cluster_id);
  }
  results.push(
    j2Bad.length === 0
      ? { name: "J2_cluster_id_deterministic", pass: true, strict: true }
      : {
          name: "J2_cluster_id_deterministic",
          pass: false,
          strict: true,
          note: `${j2Bad.length} cluster(s) failed re-hash check`,
          offenders: j2Bad.slice(0, 5),
        },
  );

  const sumClusterRows = clusters.reduce((acc, c) => acc + c.rows_seen_total, 0);
  const sumInputBucket5 = TARGET_SOURCE_TABLES.reduce((acc, t) => acc + inputs[t].bucket5Rows, 0);
  const sumWithExcluded = sumClusterRows + excludedEvidenceRows;
  results.push(
    sumWithExcluded === sumInputBucket5
      ? {
          name: "J3_input_b5_rows_accounted_for",
          pass: true,
          strict: true,
          note: `clustered=${sumClusterRows} excluded_non_cross_product=${excludedEvidenceRows} total=${sumWithExcluded} matches sum_input_b5=${sumInputBucket5}`,
        }
      : {
          name: "J3_input_b5_rows_accounted_for",
          pass: false,
          strict: true,
          note: `clustered=${sumClusterRows} + excluded=${excludedEvidenceRows} = ${sumWithExcluded} != sum_input_b5=${sumInputBucket5}`,
        },
  );

  const j4Bad = clusters.filter((c) => !(SEVERITY_LEVELS as readonly string[]).includes(c.severity));
  results.push(
    j4Bad.length === 0
      ? { name: "J4_severity_is_well_typed", pass: true, strict: true }
      : {
          name: "J4_severity_is_well_typed",
          pass: false,
          strict: true,
          note: `${j4Bad.length} cluster(s) have invalid severity`,
          offenders: j4Bad.slice(0, 5).map((c) => `${c.cluster_id}:${c.severity}`),
        },
  );

  const j5Bad = clusters.filter(
    (c) =>
      c.identifiers.asin === "" && c.identifiers.fnsku === "" && c.identifiers.seller_sku === "",
  );
  results.push(
    j5Bad.length === 0
      ? { name: "J5_no_empty_triad", pass: true, strict: true }
      : {
          name: "J5_no_empty_triad",
          pass: false,
          strict: true,
          note: `${j5Bad.length} cluster(s) have an empty triad`,
          offenders: j5Bad.slice(0, 5).map((c) => c.cluster_id),
        },
  );

  const j6Bad: string[] = [];
  for (const c of clusters) {
    for (const er of c.evidence_rows) {
      if (!isUuidString(er.source_row_id)) {
        j6Bad.push(`${c.cluster_id}:${er.source_table}:${er.source_row_id || "<empty>"}`);
      }
    }
  }
  results.push(
    j6Bad.length === 0
      ? { name: "J6_evidence_rows_have_source_row_id", pass: true, strict: true }
      : {
          name: "J6_evidence_rows_have_source_row_id",
          pass: false,
          strict: true,
          note: `${j6Bad.length} evidence row(s) have malformed source_row_id`,
          offenders: j6Bad.slice(0, 5),
        },
  );

  const partial = clusters.filter((c) => c.partial_triad).length;
  const rate = clusters.length === 0 ? 0 : partial / clusters.length;
  results.push(
    rate <= PARTIAL_TRIAD_WARN_THRESHOLD
      ? {
          name: "J7_partial_triad_rate_under_threshold",
          pass: true,
          strict: false,
          note: `rate=${rate.toFixed(3)} threshold=${PARTIAL_TRIAD_WARN_THRESHOLD}`,
        }
      : {
          name: "J7_partial_triad_rate_under_threshold",
          pass: false,
          strict: false,
          note: `rate=${rate.toFixed(3)} exceeds threshold=${PARTIAL_TRIAD_WARN_THRESHOLD}`,
        },
  );

  return results;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv);

  console.log("[review] starting NEXT-18F cross-product conflict cluster review");
  console.log(`[review] input_base_dir=${INPUT_BASE_DIR}`);

  const selection = selectInputRuns({
    baseDir: INPUT_BASE_DIR,
    overrides: cli.overrides,
  });

  if (!selection.ok) {
    console.error("[review] FAIL: cannot resolve one or more input runs");
    for (const f of selection.failures) {
      console.error(`[review]   - ${f.sourceTable}: ${f.reason}`);
    }
    for (const t of selection.trace) console.error(`[review]   ${t}`);
    process.exit(2);
  }

  for (const t of TARGET_SOURCE_TABLES) {
    const r = selection.runs[t];
    console.log(
      `[review] input ${t}: runId=${r.runId} startedAt=${r.startedAt} rows_scanned=${r.rowsScanned} bucket5=${r.bucket5Rows} generatorGitSha=${r.generatorGitSha ?? "null"} (${r.selectionReason})`,
    );
  }

  const runId = mkRunId();
  const outputDir = cli.outputDir ?? mkRunDir(OUTPUT_BASE_DIR, runId);
  if (cli.outputDir) {
    fs.mkdirSync(path.join(outputDir, "logs"), { recursive: true });
  }
  console.log(`[review] runId=${runId}`);
  console.log(`[review] output_dir=${outputDir}`);

  const selectionTracePath = path.join(outputDir, "logs", "selection-trace.txt");
  fs.writeFileSync(selectionTracePath, selection.trace.join("\n") + "\n", "utf8");

  const startedAt = new Date().toISOString();
  const manifest: RunMetadata & {
    inputRuns: Record<TargetSourceTable, { runId: string; startedAt: string; generatorGitSha: string | null }>;
    entryPoint: string;
  } = {
    runId,
    startedAt,
    finishedAt: null,
    cliArgs: {
      afiRun: cli.overrides.amazon_amazon_fulfilled_inventory ?? null,
      manageFbaRun: cli.overrides.amazon_manage_fba_inventory ?? null,
      fbaInvRun: cli.overrides.amazon_fba_inventory ?? null,
      outputDir: cli.outputDir ?? null,
    },
    envHash: sha256Hex(
      `${selection.runs.amazon_amazon_fulfilled_inventory.runId}|${selection.runs.amazon_manage_fba_inventory.runId}|${selection.runs.amazon_fba_inventory.runId}`,
    ),
    nodeVersion: process.version,
    supabaseJsVersion: null,
    generatorGitSha: null,
    inputRuns: {
      amazon_amazon_fulfilled_inventory: pickInputInfo(selection.runs.amazon_amazon_fulfilled_inventory),
      amazon_manage_fba_inventory: pickInputInfo(selection.runs.amazon_manage_fba_inventory),
      amazon_fba_inventory: pickInputInfo(selection.runs.amazon_fba_inventory),
    },
    entryPoint: "scripts/product-seed-conflict-cluster-review.ts",
  };
  writeManifest(outputDir, manifest);

  const warnings: ParseWarning[] = [];
  const allRows: EvidenceRow[] = [];
  const nonF2RowIdsAll = new Set<string>();

  for (const t of TARGET_SOURCE_TABLES) {
    const run = selection.runs[t];
    const ndjsonPath = path.join(run.runDir, "01-rows.ndjson");
    const csvPath = path.join(run.runDir, "03-cross-product-conflict.csv");
    const ndjsonRows = parseNdjsonBucket5(ndjsonPath, run.runId, t, warnings);
    const csvRows = parseConflictCsv(csvPath, run.runId, t, warnings);
    const merged = mergeEvidence(ndjsonRows, csvRows);
    console.log(
      `[review] parsed ${t}: ndjson_b5=${ndjsonRows.length} csv_f2=${csvRows.length} merged=${merged.rows.length} non_f2_only=${merged.nonF2RowIds.size}`,
    );
    if (ndjsonRows.length !== run.bucket5Rows) {
      warnings.push({
        source: ndjsonPath,
        reason: `ndjson bucket-5 count (${ndjsonRows.length}) != run-summary.bucket_counts[5] (${run.bucket5Rows})`,
      });
    }
    allRows.push(...merged.rows);
    for (const id of merged.nonF2RowIds) nonF2RowIdsAll.add(id);
  }

  const parseWarningsPath = path.join(outputDir, "logs", "parse-warnings.ndjson");
  const warningsContent = warnings.map((w) => JSON.stringify(w)).join("\n");
  fs.writeFileSync(parseWarningsPath, warningsContent.length > 0 ? warningsContent + "\n" : "", "utf8");

  const allClusters = buildClusters(allRows, nonF2RowIdsAll);
  const clusters = allClusters.filter((c) => c.distinct_conflicting_product_ids >= 2);
  const excludedClusters = allClusters.filter((c) => c.distinct_conflicting_product_ids < 2);
  const excludedEvidenceRows = excludedClusters.reduce((acc, c) => acc + c.rows_seen_total, 0);
  console.log(
    `[review] built ${allClusters.length} raw cluster(s) from ${allRows.length} merged evidence row(s); kept ${clusters.length} cross-product cluster(s), excluded ${excludedClusters.length} non-cross-product cluster(s) (${excludedEvidenceRows} row(s)) as not-multi-pid`,
  );

  appendVendorHintAuditToTrace(selectionTracePath, clusters);

  writeCsv(
    path.join(outputDir, "00-conflict-clusters.csv"),
    [
      "cluster_id",
      "clusterKey",
      "asin",
      "fnsku",
      "seller_sku",
      "partial_triad",
      "rows_seen_total",
      "rows_seen_afi",
      "rows_seen_manage_fba",
      "rows_seen_fba_inv",
      "source_tables_seen",
      "distinct_conflicting_product_ids",
      "product_ids",
      "non_f2_conflict_present",
      "titles_seen_count",
      "titles_top1",
      "titles_top2",
      "vendor_hint",
      "severity",
      "severity_reasons",
      "recommended_review_action",
    ],
    clusters.map((c) => ({
      cluster_id: c.cluster_id,
      clusterKey: c.clusterKey,
      asin: c.identifiers.asin,
      fnsku: c.identifiers.fnsku,
      seller_sku: c.identifiers.seller_sku,
      partial_triad: c.partial_triad,
      rows_seen_total: c.rows_seen_total,
      rows_seen_afi: c.rows_seen_by_source_table.amazon_amazon_fulfilled_inventory,
      rows_seen_manage_fba: c.rows_seen_by_source_table.amazon_manage_fba_inventory,
      rows_seen_fba_inv: c.rows_seen_by_source_table.amazon_fba_inventory,
      source_tables_seen: c.source_tables_seen.join(","),
      distinct_conflicting_product_ids: c.distinct_conflicting_product_ids,
      product_ids: c.conflicting_product_ids.join(","),
      non_f2_conflict_present: c.non_f2_conflict_present,
      titles_seen_count: c.titles_seen_count,
      titles_top1: c.titles_top1,
      titles_top2: c.titles_top2,
      vendor_hint: c.vendor_hint,
      severity: c.severity,
      severity_reasons: c.severity_reasons.join(","),
      recommended_review_action: c.recommended_review_action,
    })),
  );

  writeJson(path.join(outputDir, "01-conflict-clusters.json"), clusters);

  const PRODUCTS_NOTE =
    "product canonical fields not available in offline mode; rerun with --enrich-products to fetch products.title/sku/upc";
  const productRows: Record<string, unknown>[] = [];
  for (const c of clusters) {
    const titlesJoined = truncate(c.titles_seen.map((t) => t.title).join("; "), 400);
    const tablesJoined = c.source_tables_seen.join(",");
    for (const pid of c.conflicting_product_ids) {
      productRows.push({
        cluster_id: c.cluster_id,
        product_id: pid,
        evidence_row_count: c.rows_seen_total,
        titles_seen: titlesJoined,
        source_tables_seen: tablesJoined,
        asin_seen: c.identifiers.asin,
        fnsku_seen: c.identifiers.fnsku,
        seller_sku_seen: c.identifiers.seller_sku,
        note: PRODUCTS_NOTE,
      });
    }
  }
  writeCsv(
    path.join(outputDir, "02-conflict-products.csv"),
    [
      "cluster_id",
      "product_id",
      "evidence_row_count",
      "titles_seen",
      "source_tables_seen",
      "asin_seen",
      "fnsku_seen",
      "seller_sku_seen",
      "note",
    ],
    productRows,
  );

  const jChecks = runJChecks({
    clusters,
    excludedClusters,
    excludedEvidenceRows,
    inputs: selection.runs,
  });

  const clustersBySeverity: Record<Severity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  let clustersMultiTable = 0;
  let clustersPartialTriad = 0;
  for (const c of clusters) {
    clustersBySeverity[c.severity]++;
    if (c.source_tables_seen.length >= 2) clustersMultiTable++;
    if (c.partial_triad) clustersPartialTriad++;
  }

  const sumInputB5 = TARGET_SOURCE_TABLES.reduce((acc, t) => acc + selection.runs[t].bucket5Rows, 0);
  const dedupedEvidenceRows = clusters.reduce((acc, c) => acc + c.rows_seen_total, 0);

  const finishedAt = new Date().toISOString();
  const summary = {
    runId,
    startedAt,
    finishedAt,
    inputs: {
      amazon_amazon_fulfilled_inventory: inputSummary(selection.runs.amazon_amazon_fulfilled_inventory),
      amazon_manage_fba_inventory: inputSummary(selection.runs.amazon_manage_fba_inventory),
      amazon_fba_inventory: inputSummary(selection.runs.amazon_fba_inventory),
    },
    totals: {
      bucket5_rows_input: sumInputB5,
      deduped_evidence_rows: dedupedEvidenceRows,
      clusters: clusters.length,
      clusters_by_severity: clustersBySeverity,
      clusters_multi_table: clustersMultiTable,
      clusters_partial_triad: clustersPartialTriad,
    },
    excluded_non_cross_product: {
      note: "Bucket-5 evidence rows that did not yield a multi-pid cross-product conflict (e.g. classifier reason f3_shape_invalid_alongside_valid where fnsku==asin). Excluded from clusters/CSV/JSON outputs because the cross-product review narrative does not apply; surfaced here so J3 reconciles against the input bucket-5 totals.",
      clusters: excludedClusters.length,
      evidence_rows: excludedEvidenceRows,
      reasons_breakdown: summariseExcludedReasons(excludedClusters),
    },
    thresholds: {
      severity: SEVERITY_THRESHOLDS,
      partial_triad_warn_rate: PARTIAL_TRIAD_WARN_THRESHOLD,
    },
    files: {
      manifest: "manifest.json",
      run_summary: "run-summary.json",
      conflict_clusters_csv: "00-conflict-clusters.csv",
      conflict_clusters_json: "01-conflict-clusters.json",
      conflict_products_csv: "02-conflict-products.csv",
      selection_trace: "logs/selection-trace.txt",
      parse_warnings: "logs/parse-warnings.ndjson",
    },
    j_checks: jChecks,
    parse_warnings_count: warnings.length,
  };
  writeRunSummary(outputDir, summary);

  manifest.finishedAt = finishedAt;
  writeManifest(outputDir, manifest);

  const failedStrict = jChecks.filter((j) => !j.pass && j.strict);
  console.log(
    `[review] clusters=${clusters.length} severity_dist=${JSON.stringify(clustersBySeverity)} multi_table=${clustersMultiTable} partial_triad=${clustersPartialTriad}`,
  );
  for (const j of jChecks) {
    const tag = j.pass ? "PASS" : j.strict ? "FAIL" : "WARN";
    console.log(`[review] ${tag} ${j.name}${"note" in j && j.note ? " — " + j.note : ""}`);
  }
  if (failedStrict.length > 0) {
    console.error(`[review] EXIT 2 — ${failedStrict.length} strict J-check(s) failed: ${failedStrict.map((j) => j.name).join(",")}`);
    process.exit(2);
  }
  console.log(`[review] complete. reports written to ${outputDir}`);
}

function pickInputInfo(r: ResolvedInputRun): {
  runId: string;
  startedAt: string;
  generatorGitSha: string | null;
} {
  return { runId: r.runId, startedAt: r.startedAt, generatorGitSha: r.generatorGitSha };
}

function inputSummary(r: ResolvedInputRun): {
  runId: string;
  rows_scanned: number;
  bucket5_rows: number;
  generatorGitSha: string | null;
} {
  return {
    runId: r.runId,
    rows_scanned: r.rowsScanned,
    bucket5_rows: r.bucket5Rows,
    generatorGitSha: r.generatorGitSha,
  };
}

function appendVendorHintAuditToTrace(tracePath: string, clusters: Cluster[]): void {
  const lines: string[] = ["", "[vendor-hint] one entry per cluster:"];
  for (const c of clusters) {
    const expected = extractVendorHint(c.titles_top1);
    const ok = expected === c.vendor_hint ? "ok" : "MISMATCH";
    lines.push(
      `[vendor-hint] ${c.cluster_id} hint="${c.vendor_hint}" titles_top1="${truncate(c.titles_top1, 120)}" check=${ok}`,
    );
  }
  fs.appendFileSync(tracePath, lines.join("\n") + "\n", "utf8");
}

function summariseExcludedReasons(excluded: Cluster[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of excluded) {
    for (const er of c.evidence_rows) {
      const key = er.primary_reason ?? "<unknown>";
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

main().catch((err) => {
  console.error("[review] FATAL:", err);
  process.exit(1);
});
