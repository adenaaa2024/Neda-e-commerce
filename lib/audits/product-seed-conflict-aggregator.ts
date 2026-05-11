/**
 * NEXT-18F — Pure aggregation helpers for the cross-product conflict cluster review.
 *
 * Strictly offline. No Supabase imports. No DB calls. No network. The only Node
 * built-ins used are `node:fs` (streaming NDJSON / sync CSV read) and `node:path`.
 *
 * Public surface:
 *   - selectInputRuns                  — deterministic three-run picker
 *   - parseNdjsonBucket5               — stream `01-rows.ndjson`, project bucket-5 rows
 *   - parseConflictCsv                 — read `03-cross-product-conflict.csv`
 *   - buildClusters                    — group evidence rows by identifier triad
 *   - scoreCluster                     — assign severity + reasons + review action
 *   - extractVendorHint                — best-effort title -> vendor brand mapping
 *
 * Imports from sibling modules but never edits them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sha256Hex } from "./product-seed-output";
import { isUuidString } from "../uuid";

export const TARGET_SOURCE_TABLES = [
  "amazon_amazon_fulfilled_inventory",
  "amazon_manage_fba_inventory",
  "amazon_fba_inventory",
] as const;
export type TargetSourceTable = (typeof TARGET_SOURCE_TABLES)[number];

export const SEVERITY_LEVELS = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITY_LEVELS)[number];

export const SEVERITY_TO_ACTION: Record<Severity, string> = {
  critical: "escalate_immediate_dedupe",
  high: "manual_dedupe_required",
  medium: "confirm_then_dedupe",
  low: "monitor_recurrence",
};

export type ResolvedInputRun = {
  sourceTable: TargetSourceTable;
  runId: string;
  runDir: string;
  startedAt: string;
  finishedAt: string;
  rowsScanned: number;
  bucket5Rows: number;
  generatorGitSha: string | null;
  selectionReason: "auto_latest" | "cli_override";
};

export type SelectionFailure = {
  sourceTable: TargetSourceTable;
  reason: string;
};

export type SelectInputRunsArgs = {
  baseDir: string;
  overrides: Partial<Record<TargetSourceTable, string>>;
};

export type SelectInputRunsResult =
  | { ok: true; runs: Record<TargetSourceTable, ResolvedInputRun>; trace: string[] }
  | { ok: false; failures: SelectionFailure[]; trace: string[] };

type ManifestShape = {
  runId?: string;
  startedAt?: string;
  finishedAt?: string | null;
  cliArgs?: { sourceTables?: unknown };
  generatorGitSha?: string | null;
};

type RunSummaryShape = {
  rows_scanned?: number;
  bucket_counts?: Record<string, number>;
};

/** Scan `baseDir`, read each `<runId>/manifest.json`, and pick the latest finished run per target table. */
export function selectInputRuns(args: SelectInputRunsArgs): SelectInputRunsResult {
  const { baseDir, overrides } = args;
  const trace: string[] = [];

  if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
    trace.push(`[selector] baseDir not found: ${baseDir}`);
    return {
      ok: false,
      failures: TARGET_SOURCE_TABLES.map((t) => ({
        sourceTable: t,
        reason: `baseDir does not exist: ${baseDir}`,
      })),
      trace,
    };
  }

  const subdirs = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  trace.push(`[selector] scanned ${subdirs.length} subdirectories under ${baseDir}`);

  type Candidate = {
    sourceTable: TargetSourceTable;
    runId: string;
    runDir: string;
    startedAt: string;
    finishedAt: string;
    generatorGitSha: string | null;
  };
  const candidates: Candidate[] = [];

  for (const subdir of subdirs) {
    const runDir = path.join(baseDir, subdir);
    const manifestPath = path.join(runDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      trace.push(`[selector] skip ${subdir}: manifest.json missing`);
      continue;
    }
    let manifest: ManifestShape;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ManifestShape;
    } catch (e) {
      trace.push(`[selector] skip ${subdir}: manifest.json parse error: ${String(e)}`);
      continue;
    }

    const rawSourceTables = manifest.cliArgs?.sourceTables;
    if (typeof rawSourceTables !== "string" || rawSourceTables.length === 0) {
      trace.push(`[selector] skip ${subdir}: cliArgs.sourceTables not a single-table string`);
      continue;
    }
    if (rawSourceTables.includes(",")) {
      trace.push(`[selector] skip ${subdir}: multi-table run (${rawSourceTables})`);
      continue;
    }
    if (!isTargetSourceTable(rawSourceTables)) {
      trace.push(`[selector] skip ${subdir}: source table not in target set (${rawSourceTables})`);
      continue;
    }

    if (manifest.finishedAt == null) {
      trace.push(`[selector] skip ${subdir}: finishedAt is null (aborted run, source=${rawSourceTables})`);
      continue;
    }

    if (!fs.existsSync(path.join(runDir, "run-summary.json"))) {
      trace.push(`[selector] skip ${subdir}: run-summary.json missing`);
      continue;
    }

    if (typeof manifest.runId !== "string" || typeof manifest.startedAt !== "string") {
      trace.push(`[selector] skip ${subdir}: manifest missing runId or startedAt`);
      continue;
    }

    candidates.push({
      sourceTable: rawSourceTables,
      runId: manifest.runId,
      runDir,
      startedAt: manifest.startedAt,
      finishedAt: manifest.finishedAt,
      generatorGitSha: manifest.generatorGitSha ?? null,
    });
  }

  trace.push(`[selector] accepted ${candidates.length} candidate run(s) total`);

  const resolved: Partial<Record<TargetSourceTable, ResolvedInputRun>> = {};
  const failures: SelectionFailure[] = [];

  for (const target of TARGET_SOURCE_TABLES) {
    const override = overrides[target];
    let chosen: Candidate | undefined;
    let reason: "auto_latest" | "cli_override" = "auto_latest";

    if (override != null && override.length > 0) {
      chosen = candidates.find((c) => c.sourceTable === target && c.runId === override);
      reason = "cli_override";
      if (!chosen) {
        failures.push({
          sourceTable: target,
          reason: `--${cliFlagFor(target)}=${override} did not match any accepted run`,
        });
        trace.push(`[selector] FAIL ${target}: override ${override} not accepted`);
        continue;
      }
      trace.push(`[selector] ${target}: override matched runId=${chosen.runId}`);
    } else {
      const group = candidates
        .filter((c) => c.sourceTable === target)
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
      chosen = group[0];
      if (!chosen) {
        failures.push({
          sourceTable: target,
          reason: "no accepted run found for this source table",
        });
        trace.push(`[selector] FAIL ${target}: no accepted runs`);
        continue;
      }
      trace.push(
        `[selector] ${target}: auto-selected runId=${chosen.runId} (latest startedAt=${chosen.startedAt}, ${group.length} candidate(s))`,
      );
    }

    const summaryPath = path.join(chosen.runDir, "run-summary.json");
    let summary: RunSummaryShape;
    try {
      summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as RunSummaryShape;
    } catch (e) {
      failures.push({
        sourceTable: target,
        reason: `run-summary.json parse error: ${String(e)}`,
      });
      trace.push(`[selector] FAIL ${target}: run-summary.json parse error: ${String(e)}`);
      continue;
    }

    const bucket5 = Number(summary.bucket_counts?.["5"] ?? 0);
    const rowsScanned = Number(summary.rows_scanned ?? 0);

    resolved[target] = {
      sourceTable: target,
      runId: chosen.runId,
      runDir: chosen.runDir,
      startedAt: chosen.startedAt,
      finishedAt: chosen.finishedAt,
      rowsScanned,
      bucket5Rows: bucket5,
      generatorGitSha: chosen.generatorGitSha,
      selectionReason: reason,
    };
    trace.push(
      `[selector] ${target}: rows_scanned=${rowsScanned} bucket5=${bucket5} generatorGitSha=${chosen.generatorGitSha ?? "null"}`,
    );
  }

  if (failures.length > 0) {
    return { ok: false, failures, trace };
  }
  return { ok: true, runs: resolved as Record<TargetSourceTable, ResolvedInputRun>, trace };
}

function cliFlagFor(t: TargetSourceTable): string {
  switch (t) {
    case "amazon_amazon_fulfilled_inventory":
      return "afi-run";
    case "amazon_manage_fba_inventory":
      return "manage-fba-run";
    case "amazon_fba_inventory":
      return "fba-inv-run";
  }
}

function isTargetSourceTable(s: string): s is TargetSourceTable {
  return (TARGET_SOURCE_TABLES as readonly string[]).includes(s);
}

/** Common evidence-row shape produced by both parseNdjsonBucket5 and parseConflictCsv. */
export type EvidenceRow = {
  source_table: TargetSourceTable;
  source_row_id: string;
  run_id: string;
  organization_id: string | null;
  store_id: string | null;
  identifiers: {
    asin: string | null;
    fnsku: string | null;
    seller_sku: string | null;
    title: string | null;
  };
  conflict_product_ids: string[];
  primary_reason: string | null;
  match_rank: number | null;
  shape: Record<string, string> | null;
  upload_id_value: string | null;
  origin: "ndjson_bucket5" | "csv_f2_only";
};

export type ParseWarning = {
  source: string;
  line?: number;
  reason: string;
  excerpt?: string;
};

/** Stream `01-rows.ndjson`, yield rows whose bucket_id === 5. */
export function parseNdjsonBucket5(
  filePath: string,
  runId: string,
  sourceTable: TargetSourceTable,
  warnings: ParseWarning[],
): EvidenceRow[] {
  const out: EvidenceRow[] = [];
  if (!fs.existsSync(filePath)) {
    warnings.push({ source: filePath, reason: "file does not exist" });
    return out;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length === 0) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch (e) {
      warnings.push({
        source: filePath,
        line: i + 1,
        reason: `JSON parse error: ${String(e)}`,
        excerpt: line.slice(0, 200),
      });
      continue;
    }
    if (Number(row.bucket_id) !== 5) continue;

    const identifiers = (row.identifiers as Record<string, unknown> | undefined) ?? {};
    const matchEvidence = (row.match_evidence as Record<string, unknown> | undefined) ?? {};
    const shapeRaw = (matchEvidence.shape as Record<string, unknown> | undefined) ?? null;

    out.push({
      source_table: sourceTable,
      source_row_id: String(row.source_row_id ?? ""),
      run_id: runId,
      organization_id: stringOrNull(row.organization_id),
      store_id: stringOrNull(row.store_id),
      identifiers: {
        asin: stringOrNull(identifiers.asin),
        fnsku: stringOrNull(identifiers.fnsku),
        seller_sku: stringOrNull(identifiers.seller_sku),
        title: stringOrNull(identifiers.title),
      },
      conflict_product_ids: Array.isArray(row.conflict_product_ids)
        ? (row.conflict_product_ids as unknown[]).map((x) => String(x)).filter((x) => x.length > 0)
        : [],
      primary_reason: stringOrNull(row.primary_reason),
      match_rank: typeof row.match_rank === "number" ? row.match_rank : null,
      shape: shapeRaw
        ? Object.fromEntries(Object.entries(shapeRaw).map(([k, v]) => [k, String(v)]))
        : null,
      upload_id_value: stringOrNull(row.upload_id_value),
      origin: "ndjson_bucket5",
    });
  }
  return out;
}

/** Read `03-cross-product-conflict.csv`. Returns rows in the same evidence shape. */
export function parseConflictCsv(
  filePath: string,
  runId: string,
  sourceTable: TargetSourceTable,
  warnings: ParseWarning[],
): EvidenceRow[] {
  const out: EvidenceRow[] = [];
  if (!fs.existsSync(filePath)) {
    warnings.push({ source: filePath, reason: "file does not exist" });
    return out;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const records = parseCsv(raw);
  if (records.length === 0) return out;
  const header = records[0];
  const requiredCols = [
    "source_table",
    "source_row_id",
    "organization_id",
    "store_id",
    "identifiers_json",
    "conflict_product_ids_json",
  ];
  for (const col of requiredCols) {
    if (!header.includes(col)) {
      warnings.push({
        source: filePath,
        reason: `header missing required column: ${col}`,
        excerpt: header.join(","),
      });
      return out;
    }
  }
  const idx = Object.fromEntries(header.map((h, i) => [h, i])) as Record<string, number>;
  for (let r = 1; r < records.length; r++) {
    const fields = records[r];
    if (fields.length === 1 && fields[0] === "") continue;
    let identifiersObj: Record<string, unknown> = {};
    let conflictIds: string[] = [];
    try {
      identifiersObj = JSON.parse(fields[idx.identifiers_json] ?? "{}") as Record<string, unknown>;
    } catch (e) {
      warnings.push({
        source: filePath,
        line: r + 1,
        reason: `identifiers_json parse error: ${String(e)}`,
        excerpt: fields[idx.identifiers_json] ?? "",
      });
    }
    try {
      const arr = JSON.parse(fields[idx.conflict_product_ids_json] ?? "[]") as unknown[];
      if (Array.isArray(arr)) {
        conflictIds = arr.map((x) => String(x)).filter((x) => x.length > 0);
      }
    } catch (e) {
      warnings.push({
        source: filePath,
        line: r + 1,
        reason: `conflict_product_ids_json parse error: ${String(e)}`,
        excerpt: fields[idx.conflict_product_ids_json] ?? "",
      });
    }
    out.push({
      source_table: sourceTable,
      source_row_id: fields[idx.source_row_id] ?? "",
      run_id: runId,
      organization_id: nonEmpty(fields[idx.organization_id]),
      store_id: nonEmpty(fields[idx.store_id]),
      identifiers: {
        asin: stringOrNull(identifiersObj.asin),
        fnsku: stringOrNull(identifiersObj.fnsku),
        seller_sku: stringOrNull(identifiersObj.seller_sku),
        title: stringOrNull(identifiersObj.title),
      },
      conflict_product_ids: conflictIds,
      primary_reason: null,
      match_rank: null,
      shape: null,
      upload_id_value: null,
      origin: "csv_f2_only",
    });
  }
  return out;
}

/**
 * Merge bucket-5 NDJSON evidence with F2-CSV evidence by source_row_id.
 * NDJSON is the richer source (preserves primary_reason, shape, upload_id_value, etc.).
 * If a source_row_id appears only in NDJSON, it means it is a non-F2 bucket-5 row
 * (e.g. identifier-map-conflict or products-collision); flag `non_f2_conflict_present`.
 */
export function mergeEvidence(
  ndjsonRows: EvidenceRow[],
  csvRows: EvidenceRow[],
): { rows: EvidenceRow[]; nonF2RowIds: Set<string> } {
  const byKey = new Map<string, EvidenceRow>();
  for (const r of ndjsonRows) {
    byKey.set(evidenceKey(r), r);
  }
  const csvKeys = new Set<string>();
  for (const r of csvRows) {
    const k = evidenceKey(r);
    csvKeys.add(k);
    if (!byKey.has(k)) {
      byKey.set(k, r);
    }
  }
  const nonF2RowIds = new Set<string>();
  for (const [k, r] of byKey) {
    if (!csvKeys.has(k)) {
      nonF2RowIds.add(k);
    }
  }
  return { rows: [...byKey.values()], nonF2RowIds };
}

function evidenceKey(r: EvidenceRow): string {
  return `${r.source_table}::${r.source_row_id}`;
}

export type ClusterEvidenceRow = {
  source_table: TargetSourceTable;
  source_row_id: string;
  run_id: string;
  organization_id: string | null;
  store_id: string | null;
  title: string | null;
  primary_reason: string | null;
  match_rank: number | null;
  shape: Record<string, string> | null;
  upload_id_value: string | null;
  origin: EvidenceRow["origin"];
};

export type ClusterTitle = { title: string; count: number };

export type Cluster = {
  cluster_id: string;
  clusterKey: string;
  identifiers: { asin: string; fnsku: string; seller_sku: string };
  partial_triad: boolean;
  rows_seen_total: number;
  rows_seen_by_source_table: Record<TargetSourceTable, number>;
  source_tables_seen: TargetSourceTable[];
  distinct_conflicting_product_ids: number;
  conflicting_product_ids: string[];
  non_f2_conflict_present: boolean;
  evidence_rows: ClusterEvidenceRow[];
  titles_seen_count: number;
  titles_seen: ClusterTitle[];
  titles_top1: string;
  titles_top2: string;
  vendor_hint: string;
  severity: Severity;
  severity_reasons: string[];
  recommended_review_action: string;
};

/** Group evidence rows by identifier triad and assemble cluster records. */
export function buildClusters(
  rows: EvidenceRow[],
  nonF2RowIds: Set<string>,
): Cluster[] {
  type Bucket = {
    asin: string;
    fnsku: string;
    seller_sku: string;
    rows: EvidenceRow[];
    pids: Set<string>;
    perTable: Record<TargetSourceTable, number>;
    nonF2: boolean;
  };
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    const asin = upper(row.identifiers.asin);
    const fnsku = upper(row.identifiers.fnsku);
    const seller_sku = upper(row.identifiers.seller_sku);
    const key = `${asin}::${fnsku}::${seller_sku}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        asin,
        fnsku,
        seller_sku,
        rows: [],
        pids: new Set<string>(),
        perTable: {
          amazon_amazon_fulfilled_inventory: 0,
          amazon_manage_fba_inventory: 0,
          amazon_fba_inventory: 0,
        },
        nonF2: false,
      };
      buckets.set(key, b);
    }
    b.rows.push(row);
    b.perTable[row.source_table]++;
    for (const pid of row.conflict_product_ids) {
      if (pid.length > 0) b.pids.add(pid);
    }
    if (nonF2RowIds.has(evidenceKey(row))) {
      b.nonF2 = true;
    }
  }

  const clusters: Cluster[] = [];
  for (const [key, b] of buckets) {
    const sortedPids = [...b.pids].sort();
    const cluster_id = sha256Hex(`${key}|${sortedPids.join(",")}`).slice(0, 12);
    const partial_triad = b.asin === "" || b.fnsku === "" || b.seller_sku === "";

    const titlesRanked = rankTitles(b.rows);
    const titlesSeenCount = titlesRanked.reduce((acc, t) => acc + t.count, 0);

    const sourceTablesSeen: TargetSourceTable[] = [];
    for (const t of TARGET_SOURCE_TABLES) {
      if (b.perTable[t] > 0) sourceTablesSeen.push(t);
    }

    const evidenceRows: ClusterEvidenceRow[] = b.rows
      .slice()
      .sort((a, c) => {
        if (a.source_table !== c.source_table) return a.source_table < c.source_table ? -1 : 1;
        return a.source_row_id < c.source_row_id ? -1 : 1;
      })
      .map((r) => ({
        source_table: r.source_table,
        source_row_id: r.source_row_id,
        run_id: r.run_id,
        organization_id: r.organization_id,
        store_id: r.store_id,
        title: r.identifiers.title,
        primary_reason: r.primary_reason,
        match_rank: r.match_rank,
        shape: r.shape,
        upload_id_value: r.upload_id_value,
        origin: r.origin,
      }));

    const scored = scoreCluster({
      n_pids: sortedPids.length,
      n_tables: sourceTablesSeen.length,
      n_rows: b.rows.length,
      partial_triad,
      non_f2_conflict_present: b.nonF2,
      has_titles: titlesRanked.length > 0,
    });

    clusters.push({
      cluster_id,
      clusterKey: key,
      identifiers: { asin: b.asin, fnsku: b.fnsku, seller_sku: b.seller_sku },
      partial_triad,
      rows_seen_total: b.rows.length,
      rows_seen_by_source_table: b.perTable,
      source_tables_seen: sourceTablesSeen,
      distinct_conflicting_product_ids: sortedPids.length,
      conflicting_product_ids: sortedPids,
      non_f2_conflict_present: b.nonF2,
      evidence_rows: evidenceRows,
      titles_seen_count: titlesSeenCount,
      titles_seen: titlesRanked,
      titles_top1: titlesRanked[0]?.title ?? "",
      titles_top2: titlesRanked[1]?.title ?? "",
      vendor_hint: extractVendorHint(titlesRanked[0]?.title ?? ""),
      severity: scored.severity,
      severity_reasons: scored.reasons,
      recommended_review_action: SEVERITY_TO_ACTION[scored.severity],
    });
  }

  clusters.sort((a, b) => {
    const sevRank: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    if (sevRank[a.severity] !== sevRank[b.severity]) return sevRank[a.severity] - sevRank[b.severity];
    if (a.distinct_conflicting_product_ids !== b.distinct_conflicting_product_ids) {
      return b.distinct_conflicting_product_ids - a.distinct_conflicting_product_ids;
    }
    if (a.rows_seen_total !== b.rows_seen_total) return b.rows_seen_total - a.rows_seen_total;
    return a.cluster_id < b.cluster_id ? -1 : 1;
  });

  return clusters;
}

function rankTitles(rows: EvidenceRow[]): ClusterTitle[] {
  const byLowercase = new Map<string, { display: string; count: number }>();
  for (const r of rows) {
    const t = (r.identifiers.title ?? "").trim().replace(/\s+/g, " ");
    if (t.length === 0) continue;
    const k = t.toLowerCase();
    const existing = byLowercase.get(k);
    if (existing) {
      existing.count++;
    } else {
      byLowercase.set(k, { display: t, count: 1 });
    }
  }
  return [...byLowercase.values()]
    .sort((a, b) => (a.count !== b.count ? b.count - a.count : a.display < b.display ? -1 : 1))
    .map((x) => ({ title: x.display, count: x.count }));
}

export type ScoreClusterArgs = {
  n_pids: number;
  n_tables: number;
  n_rows: number;
  partial_triad: boolean;
  non_f2_conflict_present: boolean;
  has_titles: boolean;
};

export function scoreCluster(args: ScoreClusterArgs): { severity: Severity; reasons: string[] } {
  const { n_pids, n_tables, n_rows, partial_triad, non_f2_conflict_present, has_titles } = args;
  const reasons: string[] = [];
  let severity: Severity;

  if (n_pids >= 4) {
    severity = "critical";
    reasons.push("four_plus_pids");
  } else if (n_pids >= 3 && n_tables >= 2) {
    severity = "critical";
    reasons.push("three_pids_multi_table");
  } else if (n_pids >= 3) {
    severity = "high";
    reasons.push("three_pids");
  } else if (n_pids === 2 && n_tables >= 2) {
    severity = "high";
    reasons.push("two_pids_multi_table");
  } else if (n_pids === 2 && n_tables === 1 && n_rows >= 2) {
    severity = "medium";
    reasons.push("two_pids_single_table_repeated");
  } else {
    severity = "low";
    reasons.push("two_pids_single_observation");
  }

  if (partial_triad) reasons.push("partial_triad");
  if (non_f2_conflict_present) reasons.push("non_f2_evidence");
  if (!has_titles) reasons.push("no_title_evidence");

  return { severity, reasons };
}

const KNOWN_VENDOR_PREFIXES: { match: string; vendor: string }[] = [
  { match: "bob's red mill", vendor: "Bob's Red Mill" },
  { match: "boston america", vendor: "Boston America" },
  { match: "torani", vendor: "Torani" },
  { match: "gustaf's", vendor: "Gustaf's" },
  { match: "gillette", vendor: "Gillette" },
  { match: "diamond crystal", vendor: "Diamond Crystal" },
  { match: "penn ", vendor: "Penn" },
  { match: "penn championship", vendor: "Penn" },
  { match: "macadamia nuts | macfarms", vendor: "MacFarms" },
  { match: "macfarms", vendor: "MacFarms" },
  { match: "almased", vendor: "Almased" },
  { match: "gringo bandito", vendor: "GRINGO BANDITO" },
  { match: "the golden girls", vendor: "The Golden Girls" },
];

export function extractVendorHint(title: string | null | undefined): string {
  if (title == null) return "";
  const trimmed = title.trim();
  if (trimmed.length === 0) return "";
  const lc = trimmed.toLowerCase();
  for (const { match, vendor } of KNOWN_VENDOR_PREFIXES) {
    if (lc.startsWith(match)) return vendor;
  }
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) return "";
  const firstTwo = tokens.slice(0, 2).join(" ");
  if (tokens[0].length < 3 || (tokens[1] && tokens[1].length < 3)) {
    return tokens.slice(0, 3).join(" ");
  }
  return firstTwo;
}

function stringOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function nonEmpty(v: string | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function upper(v: string | null | undefined): string {
  if (v == null) return "";
  return v.trim().toUpperCase();
}

/** Minimal RFC-4180-ish CSV parser. Handles quoted fields, escaped quotes, CRLF/LF. */
function parseCsv(raw: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let i = 0;
  let inQuotes = false;
  while (i < raw.length) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      if (raw[i + 1] === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        i += 2;
        continue;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export const __testables = { parseCsv, rankTitles, evidenceKey, upper, isUuidString };
