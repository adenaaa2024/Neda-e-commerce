/**
 * PC05-MANUAL-REVIEW-QUEUE-PLAN — Remaining packaging backlog after Wave 1+2 (read-only).
 *
 *   npx tsx scripts/pc05-manual-review-queue-plan.ts
 */
import { createReadStream } from "node:fs";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const DRY_RUN_ID = "20260523T220000Z";
const PC05D_PLAN_RUN = "20260526T181000Z";
const DRY_RUN_DIR = `.cursor/audit-reports/pc05-product-packaging-governed-backfill-dry-run/${DRY_RUN_ID}`;
const PC05D_PLAN_DIR = `.cursor/audit-reports/pc05d-packaging-backfill-scale-staging-plan/${PC05D_PLAN_RUN}`;
const OUT_BASE = ".cursor/audit-reports/pc05-manual-review-queue-plan";
const WAVE3_SIZE = 50;
const DATA_IMPORT_BATCH_SIZE = 200;
const SP_API_BATCH_SIZE = 500;

const EXECUTED_WAVES = {
  pilot: 191,
  wave1: 50,
  wave2: 200,
  governed_current: 441,
};

type QualityBucket =
  | "safe_exact_packaging"
  | "needs_operator_review"
  | "missing_dimensions"
  | "conflicting_dimensions"
  | "unsafe";

type PlanCategory =
  | "unsafe_hold"
  | "conflicting_dimensions"
  | "pim_pack_structure_only"
  | "sp_api_dimensions_evidence"
  | "operator_measurement"
  | "data_import_preparation"
  | "missing_dimensions_other"
  | "needs_operator_review_other";

type Row = {
  candidate_id: string;
  quality_bucket: QualityBucket;
  plan_category: PlanCategory;
  recommended_action: string;
  blockers: string;
  packaging_level: string;
  fulfillment_context: string;
  source_type: string;
  source_table: string;
  product_id: string;
  sku: string;
  has_lwh: boolean;
  confidence_score: number | null;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function hasLwh(row: Record<string, string>): boolean {
  const l = Number(row.length_value);
  const w = Number(row.width_value);
  const h = Number(row.height_value);
  return [l, w, h].every((n) => Number.isFinite(n) && n > 0);
}

function classifyQuality(row: Record<string, string>): QualityBucket {
  const blockers = (row.blockers ?? "").split("|").filter(Boolean);
  const action = row.recommended_action ?? "";
  if (action === "blocked" || blockers.some((b) => ["profile_already_exists", "zero_volume", "invalid_case_pack_parse"].includes(b))) {
    return "unsafe";
  }
  if (blockers.includes("source_conflict_afi_mfba")) return "conflicting_dimensions";
  if (action === "ready_for_execute") return "safe_exact_packaging";
  if (blockers.includes("volume_only_no_lwh") || blockers.includes("pim_pack_structure_only")) {
    return "missing_dimensions";
  }
  if (action === "needs_operator_review") return "needs_operator_review";
  return hasLwh(row) ? "needs_operator_review" : "missing_dimensions";
}

function classifyPlan(row: Record<string, string>, bucket: QualityBucket): PlanCategory {
  const blockers = row.blockers ?? "";
  const action = row.recommended_action ?? "";
  const sourceType = row.source_type ?? "";
  const lwh = hasLwh(row);

  if (bucket === "unsafe") return "unsafe_hold";
  if (bucket === "conflicting_dimensions") return "conflicting_dimensions";
  if (blockers.includes("pim_pack_structure_only")) return "pim_pack_structure_only";
  if (
    sourceType === "amazon_report" &&
    blockers.includes("volume_only_no_lwh") &&
    !blockers.includes("source_conflict_afi_mfba")
  ) {
    return "sp_api_dimensions_evidence";
  }
  if (lwh && action === "needs_operator_review" && bucket !== "conflicting_dimensions") {
    return "operator_measurement";
  }
  if (sourceType === "import" && bucket === "missing_dimensions" && !blockers.includes("pim_pack_structure_only")) {
    return "data_import_preparation";
  }
  if (bucket === "missing_dimensions") return "missing_dimensions_other";
  return "needs_operator_review_other";
}

async function loadCsv(dryRunDir: string): Promise<Record<string, string>[]> {
  const csvPath = path.join(dryRunDir, "candidate-rows.csv");
  const rl = readline.createInterface({ input: createReadStream(csvPath, "utf8"), crlfDelay: Infinity });
  let headers: string[] = [];
  const rows: Record<string, string>[] = [];
  let first = true;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (first) {
      headers = cols;
      first = false;
      continue;
    }
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

function csvEscape(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n")) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function writeCsv(filePath: string, headers: string[], rows: Record<string, string>[]): void {
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h] ?? "")).join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);

  const pilotPath = path.join(process.cwd(), DRY_RUN_DIR, "accepted-candidate-ids.txt");
  const wavePlanPath = path.join(process.cwd(), PC05D_PLAN_DIR, "remaining-safe-candidates.json");
  if (!fs.existsSync(pilotPath)) blockers.push(`Missing ${pilotPath}`);
  if (!fs.existsSync(wavePlanPath)) blockers.push(`Missing ${wavePlanPath}`);

  const pilot = new Set(
    fs
      .readFileSync(pilotPath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const wavePlan = JSON.parse(fs.readFileSync(wavePlanPath, "utf8")) as {
    wave1_candidate_ids: string[];
    wave2_candidate_ids: string[];
  };
  const executed = new Set([
    ...pilot,
    ...(wavePlan.wave1_candidate_ids ?? []),
    ...(wavePlan.wave2_candidate_ids ?? []),
  ]);

  const backlog: Row[] = [];
  const bucketCounts: Record<QualityBucket, number> = {
    safe_exact_packaging: 0,
    needs_operator_review: 0,
    missing_dimensions: 0,
    conflicting_dimensions: 0,
    unsafe: 0,
  };
  const planCounts: Record<PlanCategory, number> = {
    unsafe_hold: 0,
    conflicting_dimensions: 0,
    pim_pack_structure_only: 0,
    sp_api_dimensions_evidence: 0,
    operator_measurement: 0,
    data_import_preparation: 0,
    missing_dimensions_other: 0,
    needs_operator_review_other: 0,
  };

  if (blockers.length === 0) {
    const all = await loadCsv(path.join(process.cwd(), DRY_RUN_DIR));
    for (const row of all) {
      const cid = row.candidate_id ?? "";
      if (pilot.has(cid) || executed.has(cid)) continue;
      const bucket = classifyQuality(row);
      bucketCounts[bucket]++;
      const plan_category = classifyPlan(row, bucket);
      planCounts[plan_category]++;
      const conf = Number(row.confidence_score);
      backlog.push({
        candidate_id: cid,
        quality_bucket: bucket,
        plan_category,
        recommended_action: row.recommended_action ?? "",
        blockers: row.blockers ?? "",
        packaging_level: row.packaging_level ?? "",
        fulfillment_context: row.fulfillment_context ?? "",
        source_type: row.source_type ?? "",
        source_table: row.source_table ?? "",
        product_id: row.product_id ?? "",
        sku: row.sku ?? "",
        has_lwh: hasLwh(row),
        confidence_score: Number.isFinite(conf) ? conf : null,
      });
    }
  }

  const pimRemaining = backlog
    .filter((r) => r.plan_category === "pim_pack_structure_only")
    .sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0));
  const wave3Ids = pimRemaining.slice(0, WAVE3_SIZE).map((r) => r.candidate_id);

  const spApiCandidates = backlog
    .filter((r) => r.plan_category === "sp_api_dimensions_evidence")
    .sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0));
  const spApiBatch = spApiCandidates.slice(0, SP_API_BATCH_SIZE);

  const operatorQueue = backlog
    .filter((r) => r.plan_category === "operator_measurement")
    .sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0));

  const dataImportBatch = backlog
    .filter((r) => r.plan_category === "data_import_preparation")
    .sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0))
    .slice(0, DATA_IMPORT_BATCH_SIZE);

  const unsafeRows = backlog.filter((r) => r.plan_category === "unsafe_hold");
  const conflictRows = backlog.filter((r) => r.plan_category === "conflicting_dimensions");

  const pc05dManifest = fs.existsSync(path.join(process.cwd(), PC05D_PLAN_DIR, "manifest.json"))
    ? (JSON.parse(fs.readFileSync(path.join(process.cwd(), PC05D_PLAN_DIR, "manifest.json"), "utf8")) as {
        manual_review_count?: number;
      })
    : {};

  fs.writeFileSync(
    path.join(outDir, "remaining-packaging-backlog.md"),
    [
      "# Remaining packaging backlog — after pilot + Wave 1 + Wave 2",
      "",
      `**Run:** \`${runId}\``,
      `**Dry-run:** \`${DRY_RUN_ID}\``,
      `**PC05D plan:** \`${PC05D_PLAN_RUN}\``,
      "",
      "## Executed (not in backlog)",
      "",
      "| Cohort | Count |",
      "|--------|------:|",
      `| Pilot (PC05) | ${EXECUTED_WAVES.pilot} |`,
      `| Wave 1 staging + original | ${EXECUTED_WAVES.wave1} |`,
      `| Wave 2 staging + original | ${EXECUTED_WAVES.wave2} |`,
      `| **Governed current (staging + original)** | **${EXECUTED_WAVES.governed_current}** |`,
      "",
      "## Remaining totals",
      "",
      `| Metric | PC05D plan (pre-wave) | Recomputed now |`,
      "|--------|----------------------:|---------------:|",
      `| Manual review queue | ${pc05dManifest.manual_review_count ?? "?"} | **${backlog.length}** |`,
      `| **Remaining after W1+W2** | — | **${backlog.length}** |`,
      "",
      "### Quality buckets (remaining)",
      "",
      "| Bucket | Count |",
      "|--------|------:|",
      ...Object.entries(bucketCounts).map(([k, v]) => `| ${k} | ${v} |`),
      "",
      "### Plan categories (remaining)",
      "",
      "| Category | Count |",
      "|--------|------:|",
      ...Object.entries(planCounts).map(([k, v]) => `| ${k} | ${v} |`),
      "",
      "### PIM pack structure pool",
      "",
      `- Remaining \`pim_pack_structure_only\`: **${pimRemaining.length}**`,
      `- Proposed Wave 3 (next ${WAVE3_SIZE}): **${wave3Ids.length}**`,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "backlog-classification.json"),
    JSON.stringify(
      {
        run_id: runId,
        executed_ids: executed.size,
        remaining_total: backlog.length,
        bucket_counts: bucketCounts,
        plan_category_counts: planCounts,
        wave3_proposed_ids: wave3Ids,
        wave3_count: wave3Ids.length,
        sp_api_evidence_candidate_count: spApiCandidates.length,
        sp_api_batch_export_count: spApiBatch.length,
        unsafe_count: unsafeRows.length,
        conflicting_count: conflictRows.length,
        pim_pack_structure_remaining: pimRemaining.length,
        data_import_batch_size: dataImportBatch.length,
        operator_measurement_count: operatorQueue.length,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "wave3-proposal.md"),
    [
      "# Wave 3 proposal — small operator-review batch",
      "",
      `**Size:** ${WAVE3_SIZE} (same governed insert pattern as Wave 1/2)`,
      `**Cohort:** \`pim_pack_structure_only\` — case/wholesale import pack structure, no L×W×H claims`,
      `**Remaining in pool after W1 (${EXECUTED_WAVES.wave1}) + W2 (${EXECUTED_WAVES.wave2}):** ${pimRemaining.length}`,
      "",
      "## Workflow (not executed here)",
      "",
      "1. PC05D-WAVE3-EXECUTE (staging, needs_review)",
      "2. PC05D-WAVE3-REVIEW census",
      "3. PC05D-WAVE3-ACTIVATE (staging)",
      "4. PC05F-style original parity plan + execute + verify for Wave 3 only",
      "",
      "## Candidate IDs",
      "",
      "See `backlog-classification.json` → `wave3_proposed_ids`",
      "",
      wave3Ids.slice(0, 20).map((id) => `- \`${id}\``).join("\n"),
      wave3Ids.length > 20 ? `\n… and ${wave3Ids.length - 20} more` : "",
    ].join("\n"),
  );

  writeCsv(
    path.join(outDir, "operator-measurement-queue.csv"),
    [
      "candidate_id",
      "product_id",
      "sku",
      "packaging_level",
      "fulfillment_context",
      "source_type",
      "confidence_score",
      "blockers",
    ],
    operatorQueue.map((r) => ({
      candidate_id: r.candidate_id,
      product_id: r.product_id,
      sku: r.sku,
      packaging_level: r.packaging_level,
      fulfillment_context: r.fulfillment_context,
      source_type: r.source_type,
      confidence_score: String(r.confidence_score ?? ""),
      blockers: r.blockers,
    })),
  );

  writeCsv(
    path.join(outDir, "sp-api-dimensions-evidence-candidates.csv"),
    [
      "candidate_id",
      "product_id",
      "sku",
      "packaging_level",
      "fulfillment_context",
      "source_table",
      "confidence_score",
      "blockers",
      "note",
    ],
    spApiBatch.map((r) => ({
      candidate_id: r.candidate_id,
      product_id: r.product_id,
      sku: r.sku,
      packaging_level: r.packaging_level,
      fulfillment_context: r.fulfillment_context,
      source_table: r.source_table,
      confidence_score: String(r.confidence_score ?? ""),
      blockers: r.blockers,
      note: "AFI volume-only; candidate for SP-API catalog dimensions enrichment dry-run (no API in this plan)",
    })),
  );

  fs.writeFileSync(
    path.join(outDir, "unsafe-hold-queue.md"),
    [
      "# Unsafe / hold queue",
      "",
      `**Count:** ${unsafeRows.length}`,
      "",
      "Do not auto-insert. Resolve blockers manually.",
      "",
      unsafeRows.length
        ? unsafeRows.map((r) => `- \`${r.candidate_id}\`: ${r.blockers}`).join("\n")
        : "None.",
      "",
      "## Conflicting dimensions (707 expected)",
      "",
      `**Count:** ${conflictRows.length}`,
      "",
      "AFI vs MFBA source conflict — reconcile before any activate.",
      "",
      conflictRows
        .slice(0, 15)
        .map((r) => `- \`${r.candidate_id}\` (${r.product_id})`)
        .join("\n"),
      conflictRows.length > 15 ? `\n… and ${conflictRows.length - 15} more (see backlog-classification.json)` : "",
    ].join("\n"),
  );

  fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "None.");

  const ok = blockers.length === 0 && backlog.length > 0;
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PC05-MANUAL-REVIEW-QUEUE-PLAN — REMAINING PACKAGING BACKLOG",
        run_id: runId,
        branch,
        read_only: true,
        remaining_total: backlog.length,
        wave3_proposed_count: wave3Ids.length,
        sp_api_evidence_candidate_count: spApiCandidates.length,
        unsafe_count: unsafeRows.length,
        conflicting_count: conflictRows.length,
        pim_pack_structure_remaining: pimRemaining.length,
        ok,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok,
        outDir,
        remaining_total: backlog.length,
        wave3_proposed_count: wave3Ids.length,
        sp_api_evidence_candidate_count: spApiCandidates.length,
        unsafe_count: unsafeRows.length,
        blockers,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
