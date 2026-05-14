/**
 * NEXT-18M — Identifier dispute classifier (dry-run, offline only).
 *
 * Consumes a NEXT-18K output run directory from disk and produces proposed
 * `pim_identifier_dispute` row shapes under .cursor/audit-reports/next-18m/<runId>/.
 *
 * Read-only. No Supabase client, no DB calls, no HTTP, no AI calls. The script
 * loads CSV/NDJSON files, applies the NEXT-18L policy via
 * [lib/audits/product-seed-dispute-classifier.ts], runs N1–N17 validation
 * checks, and writes deterministic output files.
 *
 * Plan: .cursor/plans/dispute_classifier_dryrun_dda6cb2b.plan.md
 * Policy reference: .cursor/plans/conflict_resolution_architecture_b551fe3b.plan.md
 *
 * Inputs read from the selected NEXT-18K run:
 *   - manifest.json
 *   - run-summary.json
 *   - 10-validation-checks.json   (strict checks must all pass; N15 gate)
 *   - 00-shardA-groups-summary.csv
 *   - 01-shardA-members-scored.csv
 *   - 02-shardA-winners.csv
 *   - 03-shardA-merge-edges.csv
 *   - 04-shardA-cascade-risks.csv
 *   - 05-shardA-identifier-authority.csv
 *   - 06-shardA-blocked-groups.csv
 *   - 07-shardB-orphan-vs-external.csv
 *   - 09-shardB-blocked.csv
 *   - logs/decision-trace.ndjson
 *
 * Outputs written to .cursor/audit-reports/next-18m/<runId>/:
 *   - manifest.json
 *   - run-summary.json
 *   - 00-dispute-candidates.csv
 *   - 01-dispute-candidates.ndjson
 *   - 02-authority-decisions.csv
 *   - 03-hot-loser-protection.csv
 *   - 04-ai-advisory-placeholders.json
 *   - 05-taxonomy-distribution.csv
 *   - 10-validation-checks.json
 *   - logs/decision-trace.ndjson
 *   - logs/policy-application-trace.ndjson
 *   - logs/fetch-warnings.ndjson
 *   - logs/query-trace.txt
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  NDJsonWriter,
  mkRunDir,
  mkRunId,
  writeCsv,
  writeJson,
  writeManifest,
  writeRunSummary,
  type RunMetadata,
} from "../lib/audits/product-seed-output";
import {
  KIND_AUTHORITY_LEVEL,
  CELL_PRIORITY_ORDER,
  applyAuthorityMatrixA,
  applyAuthorityMatrixB,
  assignShardATaxonomy,
  assignShardBTaxonomy,
  buildCrossGroupStrongIdIndex,
  buildSurvivingIdentifierSet,
  canonicalizeKind,
  deriveDisputeIdA,
  deriveDisputeIdB,
  emptyAiAdvice,
  resolveHotAndWindow,
  type AuthorityCsvRow,
  type AuthorityDecision,
  type DisputeCandidate,
  type IdentifierConflictEntry,
  type IdentifierKindBroad,
  type ShardAGroupInputs,
  type ShardBOrphanInputs,
  type TaxonomyCell,
} from "../lib/audits/product-seed-dispute-classifier";

const NEXT18K_BASE_DIR = path.join(".cursor", "audit-reports", "next-18k");
const NEXT18M_BASE_DIR = path.join(".cursor", "audit-reports", "next-18m");
const POLICY_VERSION = "next_18l_default_v1";
const AI_ADVICE_SHAPE_VERSION_DEFAULT = "v1";
const HOT_THRESHOLD_DAYS_DEFAULT = 30;
const REVERSIBILITY_WINDOW_H_DEFAULT = 72;

// ── CLI ─────────────────────────────────────────────────────────────────────

type Cli = {
  inputRunNext18k: string | null;
  organizationId: string | null;
  storeId: string | null;
  outputDir: string | null;
  shard: "A" | "B" | "all";
  hotThresholdDays: number;
  reversibilityWindowH: number;
  aiAdviceShapeVersion: string;
};

function parseCli(argv: string[]): Cli {
  let inputRunNext18k: string | null = null;
  let organizationId: string | null = null;
  let storeId: string | null = null;
  let outputDir: string | null = null;
  let shard: "A" | "B" | "all" = "all";
  let hotThresholdDays = HOT_THRESHOLD_DAYS_DEFAULT;
  let reversibilityWindowH = REVERSIBILITY_WINDOW_H_DEFAULT;
  let aiAdviceShapeVersion = AI_ADVICE_SHAPE_VERSION_DEFAULT;
  for (const arg of argv.slice(2)) {
    let m: RegExpMatchArray | null;
    if ((m = arg.match(/^--input-run-next-18k=(.+)$/))) inputRunNext18k = m[1].trim() || null;
    else if ((m = arg.match(/^--organization-id=(.+)$/))) organizationId = m[1].trim() || null;
    else if ((m = arg.match(/^--store-id=(.+)$/))) storeId = m[1].trim() || null;
    else if ((m = arg.match(/^--output-dir=(.+)$/))) outputDir = m[1].trim() || null;
    else if ((m = arg.match(/^--shard=(.+)$/))) {
      const v = m[1].trim();
      if (v !== "A" && v !== "B" && v !== "all") throw new Error(`Invalid --shard=${v}`);
      shard = v;
    } else if ((m = arg.match(/^--hot-threshold-days=(\d+)$/))) {
      hotThresholdDays = Number.parseInt(m[1], 10);
    } else if ((m = arg.match(/^--reversibility-window-h=(\d+)$/))) {
      reversibilityWindowH = Number.parseInt(m[1], 10);
    } else if ((m = arg.match(/^--ai-advice-shape-version=(.+)$/))) {
      aiAdviceShapeVersion = m[1].trim() || AI_ADVICE_SHAPE_VERSION_DEFAULT;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else throw new Error(`Unknown CLI flag: ${arg}`);
  }
  return {
    inputRunNext18k,
    organizationId,
    storeId,
    outputDir,
    shard,
    hotThresholdDays,
    reversibilityWindowH,
    aiAdviceShapeVersion,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      "NEXT-18M — Identifier dispute classifier (read-only, offline).",
      "",
      "Usage: npx tsx scripts/product-seed-dispute-classifier.ts [flags]",
      "",
      "Flags:",
      "  --input-run-next-18k=<runId>     Specific NEXT-18K run id (default: latest finished)",
      "  --organization-id=<uuid>         Optional override (default: derived from NEXT-18K manifest)",
      "  --store-id=<uuid>                Optional override (default: derived from NEXT-18K manifest)",
      "  --output-dir=<path>              Override output directory (default: .cursor/audit-reports/next-18m/<runId>)",
      "  --shard=A|B|all                  Restrict classification scope (default: all)",
      "  --hot-threshold-days=<n>         Days threshold for orphan recency hot flag (default: 30)",
      "  --reversibility-window-h=<n>     Base reversibility window in hours (default: 72)",
      "  --ai-advice-shape-version=<s>    AI placeholder schema version (default: v1)",
      "  --help, -h                       Show this help",
      "",
    ].join("\n"),
  );
}

// ── Run resolution ──────────────────────────────────────────────────────────

type RunSelection = {
  runId: string;
  runDir: string;
  startedAt: string;
  finishedAt: string;
  selectionReason: "auto_latest" | "cli_override";
};

function selectInputRun(args: {
  baseDir: string;
  override: string | null;
  requiredFile: string;
  trace: string[];
  label: string;
}): RunSelection {
  const { baseDir, override, requiredFile, trace, label } = args;
  if (!fs.existsSync(baseDir)) throw new Error(`${label} base directory not found: ${baseDir}`);
  type Candidate = { runId: string; runDir: string; startedAt: string; finishedAt: string };
  const candidates: Candidate[] = [];
  const subdirs = fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  trace.push(`[${label}] scanned ${subdirs.length} subdirectories under ${baseDir}`);
  for (const subdir of subdirs) {
    const runDir = path.join(baseDir, subdir);
    const manifestPath = path.join(runDir, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    let manifest: { runId?: string; startedAt?: string; finishedAt?: string | null };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (!manifest.finishedAt) continue;
    if (!fs.existsSync(path.join(runDir, requiredFile))) continue;
    candidates.push({
      runId: manifest.runId ?? subdir,
      runDir,
      startedAt: manifest.startedAt ?? "",
      finishedAt: manifest.finishedAt,
    });
  }
  if (override) {
    const found = candidates.find((c) => c.runId === override);
    if (!found) throw new Error(`${label} --input-run override ${override} did not match a finished run`);
    trace.push(`[${label}] override matched runId=${found.runId}`);
    return { ...found, selectionReason: "cli_override" };
  }
  if (candidates.length === 0) throw new Error(`No finished ${label} run found under ${baseDir}`);
  candidates.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  const chosen = candidates[0];
  trace.push(
    `[${label}] auto-selected runId=${chosen.runId} (${candidates.length} candidate(s), startedAt=${chosen.startedAt})`,
  );
  return { ...chosen, selectionReason: "auto_latest" };
}

// ── CSV ingest (vendored from NEXT-18K to keep helper module pure) ──────────

function parseCsv(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") {
        row.push(cell);
        cell = "";
      } else if (ch === "\r") {
        // ignore
      } else if (ch === "\n") {
        row.push(cell);
        cell = "";
        rows.push(row);
        row = [];
      } else cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  if (rows.length === 0) return out;
  const headers = rows[0];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = r[j] ?? "";
    out.push(obj);
  }
  return out;
}

function splitPipe(s: string | undefined | null): string[] {
  if (!s) return [];
  return s
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function parseJsonField<T>(s: string | undefined | null, fallback: T): T {
  if (!s) return fallback;
  const t = s.trim();
  if (t.length === 0) return fallback;
  try {
    return JSON.parse(t) as T;
  } catch {
    return fallback;
  }
}

function readJsonFile<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

function readNdjsonLines(p: string): Record<string, unknown>[] {
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, "utf8");
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // skip malformed
    }
  }
  return out;
}

// ── Loaded NEXT-18K snapshot shape ─────────────────────────────────────────

type Next18kSnapshot = {
  runId: string;
  runDir: string;
  manifest: Record<string, unknown>;
  runSummary: Record<string, unknown>;
  validationChecks: Array<{ name: string; pass: boolean; strict: boolean; note?: string }>;
  shardAGroupsSummary: Map<string, ShardAGroupSummaryRow>;
  shardAMembers: Map<string, ShardAMemberRow[]>;
  shardAWinners: Map<string, ShardAWinnerRow>;
  shardAMergeEdges: Map<string, ShardAMergeEdgeRow[]>;
  shardACascadeRisks: Map<string, ShardACascadeRiskRow[]>;
  shardAIdentifierAuthority: Map<string, AuthorityCsvRow[]>;
  shardABlockedGroups: Map<string, ShardABlockedGroupRow>;
  shardBOrphanVsExternal: Map<string, ShardBOrphanRow>;
  shardBBlocked: Map<string, ShardBBlockedRow>;
  decisionTrace: Record<string, unknown>[];
};

type ShardAGroupSummaryRow = {
  group_id: string;
  organization_id: string;
  store_id: string | null;
  size: number;
  winner_id: string;
  winner_composite_score: number;
  second_place_id: string | null;
  score_margin: number;
  safe_to_merge: boolean;
  block_reason: string[];
  loser_ids: string[];
  total_downstream_rewrites_for_group: number;
  total_prices_inherited: number;
  any_hot_loser: boolean;
  cluster_overlap_count: number;
  mismatch_overlap_count: number;
  identifier_authority_conflict_kinds: string[];
  tiebreak_path: unknown;
};

type ShardAMemberRow = {
  group_id: string;
  product_id: string;
  rank_in_group: number;
  is_winner: boolean;
  composite_score: number;
  candidate_sku: string | null;
  candidate_asin: string | null;
  candidate_fnsku: string | null;
  candidate_upc: string | null;
  most_recent_activity_across_surfaces: string | null;
};

type ShardAWinnerRow = {
  group_id: string;
  winner_id: string;
  organization_id: string;
  store_id: string | null;
  winner_composite_score: number;
  runner_up_id: string | null;
  runner_up_composite_score: number | null;
  score_margin: number;
  safe_to_merge: boolean;
  block_reasons: string[];
  winner_strong_identifier_kinds: string[];
  winner_identifier_set: Record<string, string>;
  reasoning: Record<string, unknown>;
};

type ShardAMergeEdgeRow = {
  group_id: string;
  loser_id: string;
  winner_id: string;
  organization_id: string;
  store_id: string | null;
  downstream_rewrite_count: number;
  cascade_delete_risk: number;
  imap_action: string;
  hot_loser_flag: boolean;
  most_recent_activity_across_surfaces: string | null;
  proposed_loser_state: Record<string, unknown> | null;
};

type ShardACascadeRiskRow = {
  group_id: string;
  loser_id: string;
  winner_id: string;
  organization_id: string;
  store_id: string | null;
  cascade_delete_risk: number;
  product_prices_count: number;
  product_prices_max_observed_at: string | null;
  total_downstream_rewrites: number;
  hot_loser_flag: boolean;
  evidence_snapshot: Record<string, unknown>;
};

type ShardABlockedGroupRow = {
  group_id: string;
  size: number;
  block_reasons: string[];
  winner_id: string;
  winner_composite_score: number;
  cluster_overlap_count: number;
  mismatch_overlap_count: number;
  identifier_authority_conflict_kinds: string[];
  tiebreak_path: unknown;
  missing_product_in_snapshot: boolean;
};

type ShardBOrphanRow = {
  orphan_id: string;
  organization_id: string;
  store_id: string | null;
  external_winner_id: string | null;
  external_winner_candidates: string[];
  safe_to_merge: boolean;
  block_reasons: string[];
  orphan_composite_score: number;
  external_winner_composite_score: number | null;
  orphan_strong_identifier_kinds: string[];
  external_winner_strong_identifier_kinds: string[];
  identifier_conflicts_raw: Array<{ kind: string; values: string[]; members: string[] }>;
  total_downstream_rewrites: number;
  prices_count: number;
  prices_max_observed_at: string | null;
  orphan_most_recent_activity: string | null;
  reasoning: Record<string, unknown>;
};

type ShardBBlockedRow = {
  orphan_id: string;
  organization_id: string;
  store_id: string | null;
  block_reasons: string[];
  external_winner_id: string | null;
  external_winner_candidates_count: number;
  total_downstream_rewrites: number;
  identifier_conflicts_count: number;
};

function strOrNull(s: string | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

function intOf(s: string | undefined): number {
  if (!s) return 0;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

function numOf(s: string | undefined): number {
  if (!s) return 0;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function boolOf(s: string | undefined): boolean {
  return s === "true";
}

function loadNext18kSnapshot(runDir: string, runId: string): Next18kSnapshot {
  const read = (rel: string): string => fs.readFileSync(path.join(runDir, rel), "utf8");

  const manifest = JSON.parse(read("manifest.json")) as Record<string, unknown>;
  const runSummary = JSON.parse(read("run-summary.json")) as Record<string, unknown>;
  const validationChecks = JSON.parse(read("10-validation-checks.json")) as Array<{
    name: string;
    pass: boolean;
    strict: boolean;
    note?: string;
  }>;

  const shardAGroupsSummary = new Map<string, ShardAGroupSummaryRow>();
  for (const r of parseCsv(read("00-shardA-groups-summary.csv"))) {
    const row: ShardAGroupSummaryRow = {
      group_id: r.group_id,
      organization_id: r.organization_id,
      store_id: strOrNull(r.store_id),
      size: intOf(r.size),
      winner_id: r.winner_id,
      winner_composite_score: numOf(r.winner_composite_score),
      second_place_id: strOrNull(r.second_place_id),
      score_margin: numOf(r.score_margin),
      safe_to_merge: boolOf(r.safe_to_merge),
      block_reason: splitPipe(r.block_reason),
      loser_ids: splitPipe(r.loser_ids),
      total_downstream_rewrites_for_group: intOf(r.total_downstream_rewrites_for_group),
      total_prices_inherited: intOf(r.total_prices_inherited),
      any_hot_loser: boolOf(r.any_hot_loser),
      cluster_overlap_count: intOf(r.cluster_overlap_count),
      mismatch_overlap_count: intOf(r.mismatch_overlap_count),
      identifier_authority_conflict_kinds: splitPipe(r.identifier_authority_conflict_kinds),
      tiebreak_path: parseJsonField<unknown>(r.tiebreak_path, []),
    };
    shardAGroupsSummary.set(row.group_id, row);
  }

  const shardAMembers = new Map<string, ShardAMemberRow[]>();
  for (const r of parseCsv(read("01-shardA-members-scored.csv"))) {
    const member: ShardAMemberRow = {
      group_id: r.group_id,
      product_id: r.product_id,
      rank_in_group: intOf(r.rank_in_group),
      is_winner: boolOf(r.is_winner),
      composite_score: numOf(r.composite_score),
      candidate_sku: strOrNull(r.candidate_sku),
      candidate_asin: strOrNull(r.candidate_asin),
      candidate_fnsku: strOrNull(r.candidate_fnsku),
      candidate_upc: strOrNull(r.candidate_upc),
      most_recent_activity_across_surfaces: strOrNull(r.most_recent_activity_across_surfaces),
    };
    const arr = shardAMembers.get(member.group_id);
    if (arr) arr.push(member);
    else shardAMembers.set(member.group_id, [member]);
  }

  const shardAWinners = new Map<string, ShardAWinnerRow>();
  for (const r of parseCsv(read("02-shardA-winners.csv"))) {
    const w: ShardAWinnerRow = {
      group_id: r.group_id,
      winner_id: r.winner_id,
      organization_id: r.organization_id,
      store_id: strOrNull(r.store_id),
      winner_composite_score: numOf(r.winner_composite_score),
      runner_up_id: strOrNull(r.runner_up_id),
      runner_up_composite_score: r.runner_up_composite_score ? numOf(r.runner_up_composite_score) : null,
      score_margin: numOf(r.score_margin),
      safe_to_merge: boolOf(r.safe_to_merge),
      block_reasons: splitPipe(r.block_reasons),
      winner_strong_identifier_kinds: splitPipe(r.winner_strong_identifier_kinds),
      winner_identifier_set: parseJsonField<Record<string, string>>(r.winner_identifier_set, {}),
      reasoning: parseJsonField<Record<string, unknown>>(r.reasoning, {}),
    };
    shardAWinners.set(w.group_id, w);
  }

  const shardAMergeEdges = new Map<string, ShardAMergeEdgeRow[]>();
  for (const r of parseCsv(read("03-shardA-merge-edges.csv"))) {
    const e: ShardAMergeEdgeRow = {
      group_id: r.group_id,
      loser_id: r.loser_id,
      winner_id: r.winner_id,
      organization_id: r.organization_id,
      store_id: strOrNull(r.store_id),
      downstream_rewrite_count: intOf(r.downstream_rewrite_count),
      cascade_delete_risk: numOf(r.cascade_delete_risk),
      imap_action: r.imap_action,
      hot_loser_flag: boolOf(r.hot_loser_flag),
      most_recent_activity_across_surfaces: strOrNull(r.most_recent_activity_across_surfaces),
      proposed_loser_state: parseJsonField<Record<string, unknown> | null>(r.proposed_loser_state, null),
    };
    const arr = shardAMergeEdges.get(e.group_id);
    if (arr) arr.push(e);
    else shardAMergeEdges.set(e.group_id, [e]);
  }

  const shardACascadeRisks = new Map<string, ShardACascadeRiskRow[]>();
  for (const r of parseCsv(read("04-shardA-cascade-risks.csv"))) {
    const e: ShardACascadeRiskRow = {
      group_id: r.group_id,
      loser_id: r.loser_id,
      winner_id: r.winner_id,
      organization_id: r.organization_id,
      store_id: strOrNull(r.store_id),
      cascade_delete_risk: numOf(r.cascade_delete_risk),
      product_prices_count: intOf(r.product_prices_count),
      product_prices_max_observed_at: strOrNull(r.product_prices_max_observed_at),
      total_downstream_rewrites: intOf(r.total_downstream_rewrites),
      hot_loser_flag: boolOf(r.hot_loser_flag),
      evidence_snapshot: parseJsonField<Record<string, unknown>>(r.evidence_snapshot, {}),
    };
    const arr = shardACascadeRisks.get(e.group_id);
    if (arr) arr.push(e);
    else shardACascadeRisks.set(e.group_id, [e]);
  }

  const shardAIdentifierAuthority = new Map<string, AuthorityCsvRow[]>();
  for (const r of parseCsv(read("05-shardA-identifier-authority.csv"))) {
    if (r.result !== "adopted" && r.result !== "conflict") continue;
    const row: AuthorityCsvRow = {
      group_id: r.group_id,
      kind: r.kind,
      result: r.result,
      winner_value: r.winner_value,
      contributing_members: splitPipe(r.contributing_members),
      conflict_values: splitPipe(r.conflict_values),
      conflict_members: splitPipe(r.conflict_members),
    };
    const arr = shardAIdentifierAuthority.get(row.group_id);
    if (arr) arr.push(row);
    else shardAIdentifierAuthority.set(row.group_id, [row]);
  }

  const shardABlockedGroups = new Map<string, ShardABlockedGroupRow>();
  for (const r of parseCsv(read("06-shardA-blocked-groups.csv"))) {
    const row: ShardABlockedGroupRow = {
      group_id: r.group_id,
      size: intOf(r.size),
      block_reasons: splitPipe(r.block_reasons),
      winner_id: r.winner_id,
      winner_composite_score: numOf(r.winner_composite_score),
      cluster_overlap_count: intOf(r.cluster_overlap_count),
      mismatch_overlap_count: intOf(r.mismatch_overlap_count),
      identifier_authority_conflict_kinds: splitPipe(r.identifier_authority_conflict_kinds),
      tiebreak_path: parseJsonField<unknown>(r.tiebreak_path, []),
      missing_product_in_snapshot: boolOf(r.missing_product_in_snapshot),
    };
    shardABlockedGroups.set(row.group_id, row);
  }

  const shardBOrphanVsExternal = new Map<string, ShardBOrphanRow>();
  for (const r of parseCsv(read("07-shardB-orphan-vs-external.csv"))) {
    const row: ShardBOrphanRow = {
      orphan_id: r.orphan_id,
      organization_id: r.organization_id,
      store_id: strOrNull(r.store_id),
      external_winner_id: strOrNull(r.external_winner_id),
      external_winner_candidates: splitPipe(r.external_winner_candidates),
      safe_to_merge: boolOf(r.safe_to_merge),
      block_reasons: splitPipe(r.block_reasons),
      orphan_composite_score: numOf(r.orphan_composite_score),
      external_winner_composite_score: r.external_winner_composite_score
        ? numOf(r.external_winner_composite_score)
        : null,
      orphan_strong_identifier_kinds: splitPipe(r.orphan_strong_identifier_kinds),
      external_winner_strong_identifier_kinds: splitPipe(r.external_winner_strong_identifier_kinds),
      identifier_conflicts_raw: parseJsonField<
        Array<{ kind: string; values: string[]; members: string[] }>
      >(r.identifier_conflicts, []),
      total_downstream_rewrites: intOf(r.total_downstream_rewrites),
      prices_count: intOf(r.prices_count),
      prices_max_observed_at: strOrNull(r.prices_max_observed_at),
      orphan_most_recent_activity: strOrNull(r.orphan_most_recent_activity),
      reasoning: parseJsonField<Record<string, unknown>>(r.reasoning, {}),
    };
    shardBOrphanVsExternal.set(row.orphan_id, row);
  }

  const shardBBlocked = new Map<string, ShardBBlockedRow>();
  for (const r of parseCsv(read("09-shardB-blocked.csv"))) {
    const row: ShardBBlockedRow = {
      orphan_id: r.orphan_id,
      organization_id: r.organization_id,
      store_id: strOrNull(r.store_id),
      block_reasons: splitPipe(r.block_reasons),
      external_winner_id: strOrNull(r.external_winner_id),
      external_winner_candidates_count: intOf(r.external_winner_candidates_count),
      total_downstream_rewrites: intOf(r.total_downstream_rewrites),
      identifier_conflicts_count: intOf(r.identifier_conflicts_count),
    };
    shardBBlocked.set(row.orphan_id, row);
  }

  const decisionTrace = readNdjsonLines(path.join(runDir, "logs", "decision-trace.ndjson"));

  return {
    runId,
    runDir,
    manifest,
    runSummary,
    validationChecks,
    shardAGroupsSummary,
    shardAMembers,
    shardAWinners,
    shardAMergeEdges,
    shardACascadeRisks,
    shardAIdentifierAuthority,
    shardABlockedGroups,
    shardBOrphanVsExternal,
    shardBBlocked,
    decisionTrace,
  };
}

// ── Helpers for evidence snapshots ──────────────────────────────────────────

function buildPartialSnapshot(args: {
  product_id: string;
  organization_id: string;
  store_id: string | null;
  sku?: string | null;
  asin?: string | null;
  fnsku?: string | null;
  upc_code?: string | null;
  capturedAt: string;
  role: "winner" | "orphan" | "external_winner_candidate";
}): Record<string, unknown> {
  return {
    product_id: args.product_id,
    organization_id: args.organization_id,
    store_id: args.store_id,
    sku: args.sku ?? null,
    asin: args.asin ?? null,
    fnsku: args.fnsku ?? null,
    upc_code: args.upc_code ?? null,
    mfg_part_number: null,
    barcode: null,
    product_name: null,
    brand: null,
    vendor_name: null,
    merge_status: null,
    merged_into_id: null,
    deleted_at: null,
    created_at: null,
    captured_at: args.capturedAt,
    role: args.role,
    partial: true,
  };
}

// ── Main classification ─────────────────────────────────────────────────────

type ClassifyContext = {
  snap: Next18kSnapshot;
  organizationId: string;
  storeId: string | null;
  hotThresholdDays: number;
  baseReversibilityWindowH: number;
  aiAdviceShapeVersion: string;
  nowIso: string;
  runId: string;
  policyTrace: NDJsonWriter;
  decisionTrace: NDJsonWriter;
};

function classifyShardA(ctx: ClassifyContext): {
  disputes: DisputeCandidate[];
  ndjsonRecords: Record<string, unknown>[];
  authorityDecisionRows: Record<string, unknown>[];
} {
  const allAuthRows: AuthorityCsvRow[] = [];
  for (const arr of ctx.snap.shardAIdentifierAuthority.values()) for (const r of arr) allAuthRows.push(r);
  const xidx = buildCrossGroupStrongIdIndex(allAuthRows);

  const disputes: DisputeCandidate[] = [];
  const ndjsonRecords: Record<string, unknown>[] = [];
  const authorityDecisionRows: Record<string, unknown>[] = [];

  for (const [groupId, summary] of ctx.snap.shardAGroupsSummary) {
    const winner = ctx.snap.shardAWinners.get(groupId);
    const members = ctx.snap.shardAMembers.get(groupId) ?? [];
    const edges = ctx.snap.shardAMergeEdges.get(groupId) ?? [];
    const cascades = ctx.snap.shardACascadeRisks.get(groupId) ?? [];
    const authRows = ctx.snap.shardAIdentifierAuthority.get(groupId) ?? [];

    const memberIds = members.length > 0
      ? members.map((m) => m.product_id)
      : [summary.winner_id, ...summary.loser_ids];

    const groupInputs: ShardAGroupInputs = {
      group_id: groupId,
      organization_id: summary.organization_id,
      store_id: summary.store_id,
      members: memberIds,
      winner_id: summary.winner_id,
      block_reasons: winner?.block_reasons ?? summary.block_reason,
      cluster_overlap_count: summary.cluster_overlap_count,
      mismatch_overlap_count: summary.mismatch_overlap_count,
      any_hot_loser: summary.any_hot_loser,
      identifier_authority_rows: authRows,
    };

    const taxonomy = assignShardATaxonomy(groupInputs, xidx);
    const decisions = applyAuthorityMatrixA({
      disputeId: deriveDisputeIdA({
        organizationId: summary.organization_id,
        storeId: summary.store_id,
        members: memberIds,
      }),
      authorityRows: authRows,
    });
    const { surviving_identifier_set, dropped_identifier_kinds } = buildSurvivingIdentifierSet(decisions);

    const disputeId = decisions[0]?.dispute_id ?? deriveDisputeIdA({
      organizationId: summary.organization_id,
      storeId: summary.store_id,
      members: memberIds,
    });

    const hotResolution = resolveHotAndWindow({
      anyHotLoser: summary.any_hot_loser,
      hotThresholdDays: ctx.hotThresholdDays,
      baseReversibilityWindowH: ctx.baseReversibilityWindowH,
      nowIso: ctx.nowIso,
    });

    const dispute: DisputeCandidate = {
      dispute_id: disputeId,
      organization_id: summary.organization_id,
      store_id: summary.store_id,
      shard: "A",
      group_id: groupId,
      orphan_id: null,
      taxonomy_cell: taxonomy.primary,
      secondary_cells: taxonomy.secondary,
      members: memberIds,
      member_count: memberIds.length,
      recommended_winner_id: summary.winner_id,
      winner_selection_method: "next_18k_ladder",
      surviving_identifier_set,
      dropped_identifier_kinds,
      identifier_conflicts: taxonomy.identifier_conflicts,
      proposed_authority_decisions: decisions,
      hot_loser_flag: hotResolution.hot_loser_flag,
      reversibility_window_h: hotResolution.reversibility_window_h,
      days_since_activity: hotResolution.days_since_activity,
      block_reasons: winner?.block_reasons ?? summary.block_reason,
      cluster_overlap_count: summary.cluster_overlap_count,
      mismatch_overlap_count: summary.mismatch_overlap_count,
      total_downstream_rewrites: summary.total_downstream_rewrites_for_group,
      total_prices_inherited: summary.total_prices_inherited,
      status: "open",
      detected_at: ctx.nowIso,
      detected_by_run_id: ctx.runId,
      detected_by_kind: "automation",
      ai_advice: emptyAiAdvice(),
    };
    disputes.push(dispute);

    // Per-member evidence snapshots: losers from cascade-risks CSV (full),
    // winner from candidates (partial).
    const losersSnapshots = new Map<string, Record<string, unknown>>();
    for (const c of cascades) losersSnapshots.set(c.loser_id, c.evidence_snapshot);
    const membersEvidence: Record<string, Record<string, unknown>> = {};
    for (const m of members) {
      const ls = losersSnapshots.get(m.product_id);
      if (ls) {
        membersEvidence[m.product_id] = ls;
      } else {
        membersEvidence[m.product_id] = buildPartialSnapshot({
          product_id: m.product_id,
          organization_id: summary.organization_id,
          store_id: summary.store_id,
          sku: m.candidate_sku,
          asin: m.candidate_asin,
          fnsku: m.candidate_fnsku,
          upc_code: m.candidate_upc,
          capturedAt: ctx.nowIso,
          role: m.is_winner ? "winner" : "winner",
        });
      }
    }
    // Defensive: cover ids missing from 01-shardA-members-scored.
    for (const id of memberIds) {
      if (membersEvidence[id]) continue;
      const ls = losersSnapshots.get(id);
      membersEvidence[id] = ls ?? buildPartialSnapshot({
        product_id: id,
        organization_id: summary.organization_id,
        store_id: summary.store_id,
        capturedAt: ctx.nowIso,
        role: id === summary.winner_id ? "winner" : "winner",
      });
    }

    const ndjson: Record<string, unknown> = {
      ...dispute,
      members_evidence_snapshots: membersEvidence,
      reasoning: {
        winner_score_breakdown: winner?.reasoning?.score_breakdown ?? null,
        composite_score: winner?.winner_composite_score ?? null,
        tiebreak_path: winner?.reasoning?.tiebreak_path ?? null,
        block_reason_chain: winner?.reasoning?.block_reason_chain ?? summary.block_reason,
        c2_evidence: taxonomy.c2_evidence,
      },
      cascade_risks: cascades.map((c) => ({
        loser_id: c.loser_id,
        cascade_delete_risk: c.cascade_delete_risk,
        total_downstream_rewrites: c.total_downstream_rewrites,
        product_prices_count: c.product_prices_count,
        product_prices_max_observed_at: c.product_prices_max_observed_at,
        hot_loser_flag: c.hot_loser_flag,
      })),
      merge_edges_summary: edges.map((e) => ({
        loser_id: e.loser_id,
        downstream_rewrite_count: e.downstream_rewrite_count,
        cascade_delete_risk: e.cascade_delete_risk,
        imap_action: e.imap_action,
        hot_loser_flag: e.hot_loser_flag,
        most_recent_activity_across_surfaces: e.most_recent_activity_across_surfaces,
      })),
      policy_version: POLICY_VERSION,
      ai_advice_shape_version: ctx.aiAdviceShapeVersion,
    };
    ndjsonRecords.push(ndjson);

    for (const d of decisions) {
      authorityDecisionRows.push({
        dispute_id: d.dispute_id,
        shard: "A",
        group_id: groupId,
        orphan_id: "",
        kind: d.kind,
        authority_level: d.authority_level,
        result: d.result,
        survived_value: d.survived_value ?? "",
        dropped_values: d.dropped_values.join("|"),
        evidence_member_count: d.evidence_member_count,
        policy_rule_id: d.policy_rule_id,
      });
      ctx.policyTrace.write({
        ts: ctx.nowIso,
        shard: "A",
        group_id: groupId,
        dispute_id: d.dispute_id,
        kind: d.kind,
        authority_level: d.authority_level,
        result: d.result,
        survived_value: d.survived_value,
        dropped_values: d.dropped_values,
        policy_rule_id: d.policy_rule_id,
        rule: {
          policy: POLICY_VERSION,
          authority_level: d.authority_level,
          on_conflict_default: d.result === "adopted" ? null : d.result === "escalated" ? "escalate" : "drop_kind_from_winner",
        },
      });
    }

    ctx.decisionTrace.write({
      ts: ctx.nowIso,
      shard: "A",
      group_id: groupId,
      dispute_id: disputeId,
      taxonomy_cell: taxonomy.primary,
      secondary_cells: taxonomy.secondary,
      member_count: memberIds.length,
      block_reasons: dispute.block_reasons,
      hot_loser_flag: dispute.hot_loser_flag,
      reversibility_window_h: dispute.reversibility_window_h,
      authority_kinds: decisions.map((d) => d.kind),
      c2_evidence_count: taxonomy.c2_evidence.length,
    });
  }

  return { disputes, ndjsonRecords, authorityDecisionRows };
}

function classifyShardB(ctx: ClassifyContext): {
  disputes: DisputeCandidate[];
  ndjsonRecords: Record<string, unknown>[];
  authorityDecisionRows: Record<string, unknown>[];
} {
  const disputes: DisputeCandidate[] = [];
  const ndjsonRecords: Record<string, unknown>[] = [];
  const authorityDecisionRows: Record<string, unknown>[] = [];

  for (const [orphanId, orphan] of ctx.snap.shardBOrphanVsExternal) {
    const blocked = ctx.snap.shardBBlocked.get(orphanId);
    const externalDeletedOrMerged = false; // NEXT-18K does not surface this directly; default to false

    const inputs: ShardBOrphanInputs = {
      orphan_id: orphan.orphan_id,
      organization_id: orphan.organization_id,
      store_id: orphan.store_id,
      external_winner_id: orphan.external_winner_id,
      external_winner_candidates: orphan.external_winner_candidates,
      block_reasons: blocked?.block_reasons ?? orphan.block_reasons,
      orphan_most_recent_activity: orphan.orphan_most_recent_activity,
      identifier_conflicts_raw: orphan.identifier_conflicts_raw,
      external_winner_strong_identifier_kinds: orphan.external_winner_strong_identifier_kinds,
      external_winner_deleted_or_merged: externalDeletedOrMerged,
    };

    const hotResolution = resolveHotAndWindow({
      anyHotLoser: null,
      orphanMostRecentActivity: orphan.orphan_most_recent_activity,
      hotThresholdDays: ctx.hotThresholdDays,
      baseReversibilityWindowH: ctx.baseReversibilityWindowH,
      nowIso: ctx.nowIso,
    });

    const taxonomy = assignShardBTaxonomy(inputs, hotResolution.hot_loser_flag);

    const disputeId = deriveDisputeIdB({
      organizationId: orphan.organization_id,
      storeId: orphan.store_id,
      orphanId: orphan.orphan_id,
      externalCandidates: orphan.external_winner_candidates,
    });

    const decisions = applyAuthorityMatrixB({
      disputeId,
      conflicts: taxonomy.identifier_conflicts,
    });

    const { surviving_identifier_set, dropped_identifier_kinds } = buildSurvivingIdentifierSet(decisions);

    const recommendedWinnerId =
      orphan.external_winner_candidates.length === 1
        ? orphan.external_winner_candidates[0]
        : null;

    const members = [orphan.orphan_id, ...orphan.external_winner_candidates];

    const dispute: DisputeCandidate = {
      dispute_id: disputeId,
      organization_id: orphan.organization_id,
      store_id: orphan.store_id,
      shard: "B",
      group_id: null,
      orphan_id: orphan.orphan_id,
      taxonomy_cell: taxonomy.primary,
      secondary_cells: taxonomy.secondary,
      members,
      member_count: members.length,
      recommended_winner_id: recommendedWinnerId,
      winner_selection_method: recommendedWinnerId ? "single_external_match" : "deferred_human_review",
      surviving_identifier_set,
      dropped_identifier_kinds,
      identifier_conflicts: taxonomy.identifier_conflicts,
      proposed_authority_decisions: decisions,
      hot_loser_flag: hotResolution.hot_loser_flag,
      reversibility_window_h: hotResolution.reversibility_window_h,
      days_since_activity: hotResolution.days_since_activity,
      block_reasons: blocked?.block_reasons ?? orphan.block_reasons,
      cluster_overlap_count: 0,
      mismatch_overlap_count: 0,
      total_downstream_rewrites: orphan.total_downstream_rewrites,
      total_prices_inherited: orphan.prices_count,
      status: "open",
      detected_at: ctx.nowIso,
      detected_by_run_id: ctx.runId,
      detected_by_kind: "automation",
      ai_advice: emptyAiAdvice(),
    };
    disputes.push(dispute);

    const membersEvidence: Record<string, Record<string, unknown>> = {};
    membersEvidence[orphan.orphan_id] = buildPartialSnapshot({
      product_id: orphan.orphan_id,
      organization_id: orphan.organization_id,
      store_id: orphan.store_id,
      capturedAt: ctx.nowIso,
      role: "orphan",
    });
    for (const c of orphan.external_winner_candidates) {
      membersEvidence[c] = buildPartialSnapshot({
        product_id: c,
        organization_id: orphan.organization_id,
        store_id: orphan.store_id,
        capturedAt: ctx.nowIso,
        role: "external_winner_candidate",
      });
    }

    const ndjson: Record<string, unknown> = {
      ...dispute,
      members_evidence_snapshots: membersEvidence,
      reasoning: {
        composite_score: orphan.orphan_composite_score,
        external_winner_health: taxonomy.external_winner_health,
        block_reason_chain: orphan.reasoning?.block_reason_chain ?? blocked?.block_reasons ?? [],
        orphan_reasoning: orphan.reasoning,
      },
      prices: {
        count: orphan.prices_count,
        max_observed_at: orphan.prices_max_observed_at,
      },
      orphan_strong_identifier_kinds: orphan.orphan_strong_identifier_kinds,
      external_winner_strong_identifier_kinds: orphan.external_winner_strong_identifier_kinds,
      policy_version: POLICY_VERSION,
      ai_advice_shape_version: ctx.aiAdviceShapeVersion,
    };
    ndjsonRecords.push(ndjson);

    for (const d of decisions) {
      authorityDecisionRows.push({
        dispute_id: d.dispute_id,
        shard: "B",
        group_id: "",
        orphan_id: orphan.orphan_id,
        kind: d.kind,
        authority_level: d.authority_level,
        result: d.result,
        survived_value: d.survived_value ?? "",
        dropped_values: d.dropped_values.join("|"),
        evidence_member_count: d.evidence_member_count,
        policy_rule_id: d.policy_rule_id,
      });
      ctx.policyTrace.write({
        ts: ctx.nowIso,
        shard: "B",
        orphan_id: orphan.orphan_id,
        dispute_id: d.dispute_id,
        kind: d.kind,
        authority_level: d.authority_level,
        result: d.result,
        survived_value: d.survived_value,
        dropped_values: d.dropped_values,
        policy_rule_id: d.policy_rule_id,
        rule: {
          policy: POLICY_VERSION,
          authority_level: d.authority_level,
          on_conflict_default: d.result === "escalated" ? "escalate" : "drop_kind_from_winner",
        },
      });
    }

    ctx.decisionTrace.write({
      ts: ctx.nowIso,
      shard: "B",
      orphan_id: orphan.orphan_id,
      dispute_id: disputeId,
      taxonomy_cell: taxonomy.primary,
      secondary_cells: taxonomy.secondary,
      external_winner_health: taxonomy.external_winner_health,
      external_winner_candidates_count: orphan.external_winner_candidates.length,
      block_reasons: dispute.block_reasons,
      hot_loser_flag: dispute.hot_loser_flag,
      reversibility_window_h: dispute.reversibility_window_h,
      authority_kinds: decisions.map((d) => d.kind),
    });
  }

  return { disputes, ndjsonRecords, authorityDecisionRows };
}

// ── Validation (N1–N17) ─────────────────────────────────────────────────────

type NCheck = { name: string; pass: boolean; strict: boolean; note?: string };

function runNChecks(args: {
  disputes: DisputeCandidate[];
  ndjsonRecords: Record<string, unknown>[];
  snap: Next18kSnapshot;
  shardScope: "A" | "B" | "all";
  authorityDecisionRows: Record<string, unknown>[];
  reversibilityBase: number;
}): NCheck[] {
  const checks: NCheck[] = [];
  const shardA = args.disputes.filter((d) => d.shard === "A");
  const shardB = args.disputes.filter((d) => d.shard === "B");
  const expectedA = args.shardScope === "B" ? 0 : args.snap.shardAGroupsSummary.size;
  const expectedB = args.shardScope === "A" ? 0 : args.snap.shardBOrphanVsExternal.size;

  checks.push({
    name: "N1_shardA_count_eq_next_18k_groups",
    pass: shardA.length === expectedA,
    strict: true,
    note: `shardA disputes=${shardA.length} expected=${expectedA}`,
  });
  checks.push({
    name: "N2_shardB_count_eq_next_18k_orphans",
    pass: shardB.length === expectedB,
    strict: true,
    note: `shardB disputes=${shardB.length} expected=${expectedB}`,
  });

  const allCells: TaxonomyCell[] = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8"];
  let allPrimaryValid = true;
  for (const d of args.disputes) {
    if (!allCells.includes(d.taxonomy_cell)) {
      allPrimaryValid = false;
      break;
    }
  }
  checks.push({
    name: "N3_primary_taxonomy_in_C1_C8",
    pass: allPrimaryValid,
    strict: true,
    note: `disputes=${args.disputes.length}`,
  });

  let secondaryCleanly = true;
  for (const d of args.disputes) {
    if (new Set(d.secondary_cells).size !== d.secondary_cells.length) {
      secondaryCleanly = false;
      break;
    }
    if (d.secondary_cells.includes(d.taxonomy_cell)) {
      secondaryCleanly = false;
      break;
    }
  }
  checks.push({
    name: "N4_secondary_cells_disjoint_no_dupes",
    pass: secondaryCleanly,
    strict: true,
  });

  let winnerInMembers = true;
  let winnerMisses = 0;
  for (const d of args.disputes) {
    if (d.recommended_winner_id == null) continue;
    if (!d.members.includes(d.recommended_winner_id)) {
      winnerInMembers = false;
      winnerMisses++;
    }
  }
  checks.push({
    name: "N5_recommended_winner_in_members",
    pass: winnerInMembers,
    strict: true,
    note: `misses=${winnerMisses}`,
  });

  let evidenceComplete = true;
  let evidenceMissing = 0;
  for (const rec of args.ndjsonRecords) {
    const snaps = (rec.members_evidence_snapshots as Record<string, unknown>) ?? {};
    const dispute = rec as unknown as DisputeCandidate;
    for (const m of dispute.members) {
      if (!snaps[m] || Object.keys(snaps[m] as Record<string, unknown>).length === 0) {
        evidenceComplete = false;
        evidenceMissing++;
      }
    }
  }
  checks.push({
    name: "N6_member_evidence_snapshots_present",
    pass: evidenceComplete,
    strict: true,
    note: `missing=${evidenceMissing}`,
  });

  let conflictsWellFormed = true;
  for (const d of args.disputes) {
    for (const c of d.identifier_conflicts) {
      if (
        !c.kind ||
        !Array.isArray(c.values) ||
        !Array.isArray(c.members) ||
        !c.authority_level ||
        !c.policy_outcome
      ) {
        conflictsWellFormed = false;
        break;
      }
    }
    if (!conflictsWellFormed) break;
  }
  checks.push({
    name: "N7_identifier_conflicts_well_formed",
    pass: conflictsWellFormed,
    strict: true,
  });

  // N8 — authority decisions cover every kind appearing in identifier_conflicts.
  let authorityCovered = true;
  let authorityMisses = 0;
  for (const d of args.disputes) {
    const conflictKinds = new Set<IdentifierKindBroad>(d.identifier_conflicts.map((c) => c.kind));
    const decisionKinds = new Set<IdentifierKindBroad>(
      d.proposed_authority_decisions.map((dec) => dec.kind),
    );
    for (const k of conflictKinds) {
      if (!decisionKinds.has(k)) {
        authorityCovered = false;
        authorityMisses++;
      }
    }
  }
  checks.push({
    name: "N8_authority_decisions_cover_conflict_kinds",
    pass: authorityCovered,
    strict: true,
    note: `misses=${authorityMisses}`,
  });

  const idSet = new Set<string>();
  let idsUnique = true;
  for (const d of args.disputes) {
    if (idSet.has(d.dispute_id)) {
      idsUnique = false;
      break;
    }
    idSet.add(d.dispute_id);
  }
  checks.push({
    name: "N9_dispute_id_uniqueness",
    pass: idsUnique,
    strict: true,
    note: `unique_count=${idSet.size}`,
  });

  // N10 — hot_loser_flag reproducible
  let hotConsistent = true;
  for (const d of args.disputes) {
    if (d.shard === "A") {
      const summary = args.snap.shardAGroupsSummary.get(d.group_id!);
      if (!summary) continue;
      if (summary.any_hot_loser !== d.hot_loser_flag) {
        hotConsistent = false;
        break;
      }
    }
  }
  checks.push({
    name: "N10_hot_loser_flag_reproducible",
    pass: hotConsistent,
    strict: true,
  });

  let windowOk = true;
  const allowedWindows = new Set<number>([args.reversibilityBase, args.reversibilityBase * 2]);
  for (const d of args.disputes) {
    if (!allowedWindows.has(d.reversibility_window_h)) {
      windowOk = false;
      break;
    }
  }
  checks.push({
    name: "N11_reversibility_window_in_band",
    pass: windowOk,
    strict: true,
    note: `allowed=${[...allowedWindows].join(",")}`,
  });

  const cellCounts = new Map<TaxonomyCell, number>();
  for (const d of args.disputes) cellCounts.set(d.taxonomy_cell, (cellCounts.get(d.taxonomy_cell) ?? 0) + 1);
  const cellSum = [...cellCounts.values()].reduce((a, b) => a + b, 0);
  checks.push({
    name: "N12_taxonomy_distribution_sums_to_total",
    pass: cellSum === args.disputes.length,
    strict: true,
    note: `sum=${cellSum} total=${args.disputes.length}`,
  });

  // N13 — neither the orchestrator nor the helper module declares a Supabase
  // client import. Detection uses an import-statement regex so the check does
  // not match the string literal inside this very check body.
  let noSupabase = true;
  const supabaseImportRe = /\b(?:from|require\()\s*["']@supabase\/[A-Za-z0-9_\-/]+["']/;
  const filesToInspect: string[] = [];
  try {
    filesToInspect.push(__filename);
    const helperPath = path.join(
      path.dirname(__filename),
      "..",
      "lib",
      "audits",
      "product-seed-dispute-classifier.ts",
    );
    if (fs.existsSync(helperPath)) filesToInspect.push(helperPath);
    for (const p of filesToInspect) {
      const src = fs.readFileSync(p, "utf8");
      if (supabaseImportRe.test(src)) {
        noSupabase = false;
        break;
      }
    }
  } catch {
    // best-effort
  }
  checks.push({
    name: "N13_no_supabase_client_imports",
    pass: noSupabase,
    strict: true,
    note: `inspected=${filesToInspect.length}`,
  });

  let tenantOk = true;
  for (const d of args.disputes) {
    if (!d.organization_id) {
      tenantOk = false;
      break;
    }
  }
  checks.push({
    name: "N14_organization_id_present",
    pass: tenantOk,
    strict: true,
  });

  // N15 — input quality gate: all strict NEXT-18K checks pass.
  let inputGate = true;
  const failed: string[] = [];
  for (const c of args.snap.validationChecks) {
    if (c.strict && !c.pass) {
      inputGate = false;
      failed.push(c.name);
    }
  }
  checks.push({
    name: "N15_next_18k_strict_checks_green",
    pass: inputGate,
    strict: true,
    note: failed.length === 0 ? "all strict pass" : `failed=${failed.join("|")}`,
  });

  // N16 (soft) — C2 evidence references at least one other valid group_id.
  let c2SoftOk = true;
  let c2Refs = 0;
  for (const rec of args.ndjsonRecords) {
    const reasoning = rec.reasoning as Record<string, unknown> | undefined;
    const c2 = (reasoning?.c2_evidence as Array<{ other_group_ids: string[] }>) ?? [];
    for (const c of c2) {
      c2Refs += c.other_group_ids.length;
      for (const g of c.other_group_ids) {
        if (!args.snap.shardAGroupsSummary.has(g)) {
          c2SoftOk = false;
        }
      }
    }
  }
  checks.push({
    name: "N16_c2_evidence_resolves_to_known_groups",
    pass: c2SoftOk,
    strict: false,
    note: `c2_refs=${c2Refs}`,
  });

  // N17 (soft) — every dispute with primary=C8 has hot_loser_flag=true.
  let c8SoftOk = true;
  let c8Total = 0;
  let c8Hot = 0;
  for (const d of args.disputes) {
    if (d.taxonomy_cell === "C8") {
      c8Total++;
      if (d.hot_loser_flag) c8Hot++;
      else c8SoftOk = false;
    }
  }
  checks.push({
    name: "N17_C8_disputes_are_hot",
    pass: c8SoftOk,
    strict: false,
    note: `c8_total=${c8Total} c8_hot=${c8Hot}`,
  });

  return checks;
}

// ── Reporting ──────────────────────────────────────────────────────────────

function taxonomyDistribution(disputes: readonly DisputeCandidate[]): Record<TaxonomyCell, number> {
  const out: Record<TaxonomyCell, number> = {
    C1: 0, C2: 0, C3: 0, C4: 0, C5: 0, C6: 0, C7: 0, C8: 0,
  };
  for (const d of disputes) out[d.taxonomy_cell]++;
  return out;
}

function secondaryHistogram(disputes: readonly DisputeCandidate[]): Record<TaxonomyCell, number> {
  const out: Record<TaxonomyCell, number> = {
    C1: 0, C2: 0, C3: 0, C4: 0, C5: 0, C6: 0, C7: 0, C8: 0,
  };
  for (const d of disputes) for (const s of d.secondary_cells) out[s]++;
  return out;
}

function authorityDecisionCounts(rows: readonly Record<string, unknown>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const key = `${String(r.kind)}|${String(r.authority_level)}|${String(r.result)}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function reversibilityHistogram(
  disputes: readonly DisputeCandidate[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of disputes) {
    const k = String(d.reversibility_window_h);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function identifierKindDistribution(
  disputes: readonly DisputeCandidate[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of disputes) for (const c of d.identifier_conflicts) out[c.kind] = (out[c.kind] ?? 0) + 1;
  return out;
}

function envHash(cli: Cli, runId: string): string {
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const payload = JSON.stringify({ cli, runId, POLICY_VERSION });
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

function gitSha(): string | null {
  try {
    const child = require("node:child_process") as typeof import("node:child_process");
    return child.execSync("git rev-parse HEAD", { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cli = parseCli(process.argv);
  const trace: string[] = [];
  const startedAt = new Date();
  const runId = mkRunId(startedAt);
  const baseOutputDir = cli.outputDir ?? NEXT18M_BASE_DIR;
  const runDir = mkRunDir(baseOutputDir, runId);

  trace.push(`[next-18m] runId=${runId} runDir=${runDir}`);

  // Resolve NEXT-18K run.
  const next18k = selectInputRun({
    baseDir: NEXT18K_BASE_DIR,
    override: cli.inputRunNext18k,
    requiredFile: "10-validation-checks.json",
    trace,
    label: "next_18k",
  });
  trace.push(`[next-18m] reading next-18k run: ${next18k.runDir}`);

  const snap = loadNext18kSnapshot(next18k.runDir, next18k.runId);
  trace.push(
    `[next-18m] loaded snapshot: shardA_groups=${snap.shardAGroupsSummary.size}, shardA_members=${[
      ...snap.shardAMembers.values(),
    ].reduce((a, b) => a + b.length, 0)}, shardA_winners=${snap.shardAWinners.size}, shardA_edges=${[
      ...snap.shardAMergeEdges.values(),
    ].reduce((a, b) => a + b.length, 0)}, shardA_cascades=${[
      ...snap.shardACascadeRisks.values(),
    ].reduce((a, b) => a + b.length, 0)}, shardA_auth_rows=${[
      ...snap.shardAIdentifierAuthority.values(),
    ].reduce((a, b) => a + b.length, 0)}, shardB_orphans=${snap.shardBOrphanVsExternal.size}`,
  );

  // N15 gate: refuse to run if NEXT-18K has any strict failure.
  const strictFails = snap.validationChecks.filter((c) => c.strict && !c.pass);
  if (strictFails.length > 0) {
    const detail = strictFails.map((f) => `${f.name}:${f.note ?? ""}`).join(", ");
    throw new Error(
      `NEXT-18K strict validation checks did not all pass: ${detail}. ` +
        `Refusing to run NEXT-18M (N15 input quality gate).`,
    );
  }
  trace.push(`[next-18m] N15 input gate satisfied (strict NEXT-18K checks: ${snap.validationChecks.filter((c) => c.strict).length})`);

  // Tenant resolution.
  const manifestTenant = (snap.manifest.tenant as Record<string, unknown> | undefined) ?? {};
  const organizationId = cli.organizationId ?? String(manifestTenant.organization_id ?? "");
  const storeId = cli.storeId ?? (manifestTenant.store_id_filter as string | null) ?? null;
  if (!organizationId) {
    throw new Error("Could not determine organization_id (NEXT-18K manifest.tenant missing).");
  }
  trace.push(`[next-18m] tenant organization_id=${organizationId} store_id=${storeId ?? "<all>"}`);

  const nowIso = startedAt.toISOString();
  const policyTracePath = path.join(runDir, "logs", "policy-application-trace.ndjson");
  const decisionTracePath = path.join(runDir, "logs", "decision-trace.ndjson");
  const fetchWarningsPath = path.join(runDir, "logs", "fetch-warnings.ndjson");
  const policyTrace = new NDJsonWriter(policyTracePath);
  const decisionTrace = new NDJsonWriter(decisionTracePath);
  const fetchWarnings = new NDJsonWriter(fetchWarningsPath);

  const ctx: ClassifyContext = {
    snap,
    organizationId,
    storeId,
    hotThresholdDays: cli.hotThresholdDays,
    baseReversibilityWindowH: cli.reversibilityWindowH,
    aiAdviceShapeVersion: cli.aiAdviceShapeVersion,
    nowIso,
    runId,
    policyTrace,
    decisionTrace,
  };

  let shardARes: ReturnType<typeof classifyShardA> = { disputes: [], ndjsonRecords: [], authorityDecisionRows: [] };
  let shardBRes: ReturnType<typeof classifyShardB> = { disputes: [], ndjsonRecords: [], authorityDecisionRows: [] };
  if (cli.shard === "A" || cli.shard === "all") shardARes = classifyShardA(ctx);
  if (cli.shard === "B" || cli.shard === "all") shardBRes = classifyShardB(ctx);

  const allDisputes = [...shardARes.disputes, ...shardBRes.disputes];
  const allNdjson = [...shardARes.ndjsonRecords, ...shardBRes.ndjsonRecords];
  const allAuthority = [...shardARes.authorityDecisionRows, ...shardBRes.authorityDecisionRows];

  trace.push(
    `[next-18m] classified disputes: shardA=${shardARes.disputes.length} shardB=${shardBRes.disputes.length} total=${allDisputes.length}`,
  );

  // 00-dispute-candidates.csv (flat).
  const flatHeaders = [
    "dispute_id",
    "shard",
    "organization_id",
    "store_id",
    "group_id",
    "orphan_id",
    "taxonomy_cell",
    "secondary_cells",
    "member_count",
    "members",
    "recommended_winner_id",
    "winner_selection_method",
    "surviving_identifier_set",
    "dropped_identifier_kinds",
    "identifier_conflict_kinds",
    "identifier_conflict_count",
    "hot_loser_flag",
    "reversibility_window_h",
    "days_since_activity",
    "block_reasons",
    "cluster_overlap_count",
    "mismatch_overlap_count",
    "total_downstream_rewrites",
    "total_prices_inherited",
    "status",
    "detected_at",
    "detected_by_run_id",
    "detected_by_kind",
    "policy_version",
    "ai_advice_shape_version",
  ] as const;
  const flatRows = allDisputes.map((d) => ({
    dispute_id: d.dispute_id,
    shard: d.shard,
    organization_id: d.organization_id,
    store_id: d.store_id ?? "",
    group_id: d.group_id ?? "",
    orphan_id: d.orphan_id ?? "",
    taxonomy_cell: d.taxonomy_cell,
    secondary_cells: d.secondary_cells.join("|"),
    member_count: d.member_count,
    members: d.members.join("|"),
    recommended_winner_id: d.recommended_winner_id ?? "",
    winner_selection_method: d.winner_selection_method,
    surviving_identifier_set: JSON.stringify(d.surviving_identifier_set),
    dropped_identifier_kinds: d.dropped_identifier_kinds.join("|"),
    identifier_conflict_kinds: d.identifier_conflicts.map((c) => c.kind).join("|"),
    identifier_conflict_count: d.identifier_conflicts.length,
    hot_loser_flag: d.hot_loser_flag,
    reversibility_window_h: d.reversibility_window_h,
    days_since_activity: d.days_since_activity ?? "",
    block_reasons: d.block_reasons.join("|"),
    cluster_overlap_count: d.cluster_overlap_count,
    mismatch_overlap_count: d.mismatch_overlap_count,
    total_downstream_rewrites: d.total_downstream_rewrites,
    total_prices_inherited: d.total_prices_inherited,
    status: d.status,
    detected_at: d.detected_at,
    detected_by_run_id: d.detected_by_run_id,
    detected_by_kind: d.detected_by_kind,
    policy_version: POLICY_VERSION,
    ai_advice_shape_version: cli.aiAdviceShapeVersion,
  }));
  writeCsv(path.join(runDir, "00-dispute-candidates.csv"), flatHeaders, flatRows);

  // 01-dispute-candidates.ndjson — full shapes.
  const ndPath = path.join(runDir, "01-dispute-candidates.ndjson");
  const ndWriter = new NDJsonWriter(ndPath);
  for (const r of allNdjson) ndWriter.write(r);
  await ndWriter.close();

  // 02-authority-decisions.csv.
  writeCsv(
    path.join(runDir, "02-authority-decisions.csv"),
    [
      "dispute_id",
      "shard",
      "group_id",
      "orphan_id",
      "kind",
      "authority_level",
      "result",
      "survived_value",
      "dropped_values",
      "evidence_member_count",
      "policy_rule_id",
    ],
    allAuthority,
  );

  // 03-hot-loser-protection.csv.
  const hotRows = allDisputes
    .filter((d) => d.hot_loser_flag)
    .map((d) => ({
      dispute_id: d.dispute_id,
      shard: d.shard,
      group_id: d.group_id ?? "",
      orphan_id: d.orphan_id ?? "",
      taxonomy_cell: d.taxonomy_cell,
      secondary_cells: d.secondary_cells.join("|"),
      hot_loser_flag: d.hot_loser_flag,
      reversibility_window_h: d.reversibility_window_h,
      days_since_activity: d.days_since_activity ?? "",
      block_reasons: d.block_reasons.join("|"),
      total_downstream_rewrites: d.total_downstream_rewrites,
      total_prices_inherited: d.total_prices_inherited,
    }));
  writeCsv(
    path.join(runDir, "03-hot-loser-protection.csv"),
    [
      "dispute_id",
      "shard",
      "group_id",
      "orphan_id",
      "taxonomy_cell",
      "secondary_cells",
      "hot_loser_flag",
      "reversibility_window_h",
      "days_since_activity",
      "block_reasons",
      "total_downstream_rewrites",
      "total_prices_inherited",
    ],
    hotRows,
  );

  // 04-ai-advisory-placeholders.json.
  writeJson(path.join(runDir, "04-ai-advisory-placeholders.json"), {
    shape_version: cli.aiAdviceShapeVersion,
    advisory_only: true,
    ai_settings_source: "tenant_pim_ai_settings (future)",
    schema: {
      normalization_suggestions: "Array<{kind, suggested, confidence, reasoning}>",
      winner_recommendation: "{winner_id, confidence, reasoning} | null",
      vendor_lineage_inference: "{vendor_canonical, confidence, evidence} | null",
      similarity_clustering: "{cluster_id, members, score} | null",
      last_advised_at: "ISO-8601 | null",
      last_advised_by_model: "string | null",
      advisory_only: "true",
    },
    placeholders: allDisputes.map((d) => ({
      dispute_id: d.dispute_id,
      shard: d.shard,
      ai_advice: emptyAiAdvice(),
    })),
  });

  // 05-taxonomy-distribution.csv.
  const taxonomyA = taxonomyDistribution(shardARes.disputes);
  const taxonomyB = taxonomyDistribution(shardBRes.disputes);
  const taxonomyAll = taxonomyDistribution(allDisputes);
  const secondaryAll = secondaryHistogram(allDisputes);
  const taxonomyCsvRows: Record<string, unknown>[] = [];
  for (const cell of CELL_PRIORITY_ORDER) {
    taxonomyCsvRows.push({
      taxonomy_cell: cell,
      shardA_primary_count: taxonomyA[cell],
      shardB_primary_count: taxonomyB[cell],
      total_primary_count: taxonomyAll[cell],
      secondary_count: secondaryAll[cell],
    });
  }
  writeCsv(
    path.join(runDir, "05-taxonomy-distribution.csv"),
    [
      "taxonomy_cell",
      "shardA_primary_count",
      "shardB_primary_count",
      "total_primary_count",
      "secondary_count",
    ],
    taxonomyCsvRows,
  );

  // N-checks.
  const checks = runNChecks({
    disputes: allDisputes,
    ndjsonRecords: allNdjson,
    snap,
    shardScope: cli.shard,
    authorityDecisionRows: allAuthority,
    reversibilityBase: cli.reversibilityWindowH,
  });
  writeJson(path.join(runDir, "10-validation-checks.json"), checks);

  await policyTrace.close();
  await decisionTrace.close();
  await fetchWarnings.close();

  // query-trace.txt — purely descriptive (no DB queries this run).
  fs.writeFileSync(path.join(runDir, "logs", "query-trace.txt"), trace.join("\n") + "\n", "utf8");

  // Run summary + manifest.
  const finishedAt = new Date();
  const finishedIso = finishedAt.toISOString();
  const summary = {
    runId,
    startedAt: nowIso,
    finishedAt: finishedIso,
    policy_version: POLICY_VERSION,
    ai_advice_shape_version: cli.aiAdviceShapeVersion,
    tenant: { organization_id: organizationId, store_id_filter: storeId },
    inputs: {
      next_18k_run_id: next18k.runId,
      next_18k_run_dir: next18k.runDir,
      next_18k_selection_reason: next18k.selectionReason,
    },
    expected_counts: {
      shardA: snap.shardAGroupsSummary.size,
      shardB: snap.shardBOrphanVsExternal.size,
      total: snap.shardAGroupsSummary.size + snap.shardBOrphanVsExternal.size,
    },
    counts: {
      shardA_disputes: shardARes.disputes.length,
      shardB_disputes: shardBRes.disputes.length,
      total_disputes: allDisputes.length,
    },
    taxonomy: {
      primary: { shardA: taxonomyA, shardB: taxonomyB, total: taxonomyAll },
      secondary_total: secondaryAll,
    },
    recommended_winner_coverage: {
      shardA_with_recommendation: shardARes.disputes.filter((d) => d.recommended_winner_id != null).length,
      shardA_total: shardARes.disputes.length,
      shardB_with_recommendation: shardBRes.disputes.filter((d) => d.recommended_winner_id != null).length,
      shardB_total: shardBRes.disputes.length,
    },
    hot_loser: {
      total: allDisputes.filter((d) => d.hot_loser_flag).length,
      shardA: shardARes.disputes.filter((d) => d.hot_loser_flag).length,
      shardB: shardBRes.disputes.filter((d) => d.hot_loser_flag).length,
    },
    reversibility_window_histogram: reversibilityHistogram(allDisputes),
    identifier_kind_distribution: identifierKindDistribution(allDisputes),
    authority_decisions: {
      total: allAuthority.length,
      by_kind_level_result: authorityDecisionCounts(allAuthority),
    },
    block_reason_histogram: (() => {
      const out: Record<string, number> = {};
      for (const d of allDisputes) for (const r of d.block_reasons) out[r] = (out[r] ?? 0) + 1;
      return out;
    })(),
    files: {
      manifest: "manifest.json",
      run_summary: "run-summary.json",
      dispute_candidates_csv: "00-dispute-candidates.csv",
      dispute_candidates_ndjson: "01-dispute-candidates.ndjson",
      authority_decisions_csv: "02-authority-decisions.csv",
      hot_loser_protection_csv: "03-hot-loser-protection.csv",
      ai_advisory_placeholders_json: "04-ai-advisory-placeholders.json",
      taxonomy_distribution_csv: "05-taxonomy-distribution.csv",
      validation_checks_json: "10-validation-checks.json",
      logs: {
        decision_trace: "logs/decision-trace.ndjson",
        policy_application_trace: "logs/policy-application-trace.ndjson",
        fetch_warnings: "logs/fetch-warnings.ndjson",
        query_trace: "logs/query-trace.txt",
      },
    },
    n_checks: checks,
  };
  writeRunSummary(runDir, summary);

  const meta: RunMetadata & {
    inputs: Record<string, unknown>;
    tenant: { organization_id: string; store_id_filter: string | null };
    policy_version: string;
    ai_advice_shape_version: string;
    entryPoint: string;
  } = {
    runId,
    startedAt: nowIso,
    finishedAt: finishedIso,
    cliArgs: {
      inputRunNext18k: cli.inputRunNext18k,
      organizationId: cli.organizationId,
      storeId: cli.storeId,
      outputDir: cli.outputDir,
      shard: cli.shard,
      hotThresholdDays: cli.hotThresholdDays,
      reversibilityWindowH: cli.reversibilityWindowH,
      aiAdviceShapeVersion: cli.aiAdviceShapeVersion,
    },
    envHash: envHash(cli, runId),
    nodeVersion: process.version,
    supabaseJsVersion: null,
    generatorGitSha: gitSha(),
    inputs: {
      next_18k: {
        runId: next18k.runId,
        runDir: next18k.runDir,
        startedAt: next18k.startedAt,
        finishedAt: next18k.finishedAt,
        selectionReason: next18k.selectionReason,
      },
    },
    tenant: { organization_id: organizationId, store_id_filter: storeId },
    policy_version: POLICY_VERSION,
    ai_advice_shape_version: cli.aiAdviceShapeVersion,
    entryPoint: "scripts/product-seed-dispute-classifier.ts",
  };
  writeManifest(runDir, meta);

  // Report.
  const strict = checks.filter((c) => c.strict);
  const soft = checks.filter((c) => !c.strict);
  const strictPass = strict.filter((c) => c.pass).length;
  const softPass = soft.filter((c) => c.pass).length;
  process.stdout.write(
    [
      `[next-18m] DONE runId=${runId}`,
      `[next-18m] output_dir=${runDir}`,
      `[next-18m] shardA_disputes=${shardARes.disputes.length} (expected=${snap.shardAGroupsSummary.size})`,
      `[next-18m] shardB_disputes=${shardBRes.disputes.length} (expected=${snap.shardBOrphanVsExternal.size})`,
      `[next-18m] total_disputes=${allDisputes.length} (expected=${snap.shardAGroupsSummary.size + snap.shardBOrphanVsExternal.size})`,
      `[next-18m] taxonomy_primary=${JSON.stringify(taxonomyAll)}`,
      `[next-18m] taxonomy_secondary=${JSON.stringify(secondaryAll)}`,
      `[next-18m] hot_total=${summary.hot_loser.total} shardA=${summary.hot_loser.shardA} shardB=${summary.hot_loser.shardB}`,
      `[next-18m] recommended_winner shardA=${summary.recommended_winner_coverage.shardA_with_recommendation}/${summary.recommended_winner_coverage.shardA_total} shardB=${summary.recommended_winner_coverage.shardB_with_recommendation}/${summary.recommended_winner_coverage.shardB_total}`,
      `[next-18m] reversibility_window_hist=${JSON.stringify(summary.reversibility_window_histogram)}`,
      `[next-18m] identifier_kind_dist=${JSON.stringify(summary.identifier_kind_distribution)}`,
      `[next-18m] n_checks strict=${strictPass}/${strict.length} soft=${softPass}/${soft.length}`,
      `[next-18m] n_checks_detail=${JSON.stringify(checks.map((c) => ({ name: c.name, pass: c.pass, strict: c.strict })))}`,
      "",
    ].join("\n"),
  );

  if (strict.some((c) => !c.pass)) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`[next-18m] fatal: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exitCode = 1;
});

// Reference (silences unused import noise from intentional cross-module types).
void KIND_AUTHORITY_LEVEL;
void canonicalizeKind;
