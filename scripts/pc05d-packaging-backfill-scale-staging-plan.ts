/**
 * PC05D — Packaging backfill scale staging plan (read-only).
 *
 *   npx tsx scripts/pc05d-packaging-backfill-scale-staging-plan.ts
 *   npx tsx scripts/pc05d-packaging-backfill-scale-staging-plan.ts --dry-run-id=20260523T220000Z
 */
import { createReadStream } from "node:fs";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const DRY_RUN_DEFAULT = "20260523T220000Z";
const DRY_RUN_BASE = ".cursor/audit-reports/pc05-product-packaging-governed-backfill-dry-run";
const PC05C_EXECUTE_PROOF = "20260526T180000Z";
const OUT_BASE = ".cursor/audit-reports/pc05d-packaging-backfill-scale-staging-plan";
const EXECUTE_APPROVAL = ".cursor/operator-approvals/product-packaging-backfill-pc05d-scale-execute-approval.md";
const ACTIVATE_APPROVAL = ".cursor/operator-approvals/product-packaging-backfill-pc05d-scale-activate-approval.md";

const WAVE1_SAFE_LIMIT = 50;
const WAVE2_SAFE_LIMIT = 200;

type CsvRow = Record<string, string>;

type QualityBucket =
  | "safe_exact_packaging"
  | "needs_operator_review"
  | "missing_dimensions"
  | "conflicting_dimensions"
  | "unsafe";

type ClassifiedRow = {
  candidate_id: string;
  quality_bucket: QualityBucket;
  recommended_action: string;
  blockers: string;
  packaging_level: string;
  fulfillment_context: string;
  source_type: string;
  product_id: string;
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

function dryRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--dry-run-id="));
  return a ? a.split("=")[1]!.trim() : DRY_RUN_DEFAULT;
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

function hasLwh(row: CsvRow): boolean {
  const l = Number(row.length_value);
  const w = Number(row.width_value);
  const h = Number(row.height_value);
  return [l, w, h].every((n) => Number.isFinite(n) && n > 0);
}

function classifyQuality(row: CsvRow): QualityBucket {
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

function approvalTemplate(kind: "execute" | "activate"): string {
  const flag =
    kind === "execute"
      ? "APPROVED_PRODUCT_PACKAGING_BACKFILL_PC05D_SCALE_EXECUTE"
      : "APPROVED_PRODUCT_PACKAGING_BACKFILL_PC05D_SCALE_ACTIVATE";
  const title =
    kind === "execute"
      ? "PC05D scale execute — staging packaging backfill"
      : "PC05D scale activate — staging packaging versions";
  return `# ${title}

**Default:** not approved until PC05D wave plan is reviewed.

| Field | Value |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| Original | **forbidden** |
| Dry-run | \`pc05-product-packaging-governed-backfill-dry-run/${DRY_RUN_DEFAULT}/\` |
| Wave source | \`remaining-safe-candidates.json\` + operator-filtered wave list |

\`\`\`text
APPROVED_TO_RUN_STAGING=false
${flag}=false
\`\`\`

## Sign-off

\`\`\`
APPROVED_TO_RUN_STAGING=false
${flag}=false
Approved by:
UTC date:
Plan run_id:
Wave:
\`\`\`
`;
}

async function loadAllCandidates(dryRunDir: string): Promise<CsvRow[]> {
  const csvPath = path.join(dryRunDir, "candidate-rows.csv");
  const rl = readline.createInterface({ input: createReadStream(csvPath, "utf8"), crlfDelay: Infinity });
  let headers: string[] = [];
  const rows: CsvRow[] = [];
  let first = true;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (first) {
      headers = cols;
      first = false;
      continue;
    }
    const row: CsvRow = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const dryRunId = dryRunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = refFromSupabaseUrl(stagingUrl) || getStagingProjectRef({ loadEnv: false });

  const dryRunDir = path.join(process.cwd(), DRY_RUN_BASE, dryRunId);
  const pilotPath = path.join(dryRunDir, "accepted-candidate-ids.txt");
  const pc05cManifest = path.join(
    process.cwd(),
    ".cursor/audit-reports/pc05c-packaging-original-data-parity-execute",
    PC05C_EXECUTE_PROOF,
    "manifest.json",
  );

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (ref !== STAGING_REF) blockers.push(`Planning target must be staging ${STAGING_REF}`);
  if (!fs.existsSync(pilotPath)) blockers.push(`Missing pilot list: ${pilotPath}`);
  if (!fs.existsSync(path.join(dryRunDir, "candidate-rows.csv"))) blockers.push("Missing candidate-rows.csv");

  const pc05cOk =
    fs.existsSync(pc05cManifest) &&
    (() => {
      try {
        const m = JSON.parse(fs.readFileSync(pc05cManifest, "utf8")) as { ok?: boolean; inserted_profiles?: number };
        return m.ok === true && (m.inserted_profiles ?? 0) >= 191;
      } catch {
        return false;
      }
    })();
  if (!pc05cOk) {
    blockers.push(`PC05C original execute proof required: ${PC05C_EXECUTE_PROOF}`);
  }

  const pilot = new Set(
    fs
      .readFileSync(pilotPath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );

  if (!fs.existsSync(path.join(process.cwd(), EXECUTE_APPROVAL))) {
    fs.mkdirSync(path.dirname(path.join(process.cwd(), EXECUTE_APPROVAL)), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), EXECUTE_APPROVAL), approvalTemplate("execute"));
  }
  if (!fs.existsSync(path.join(process.cwd(), ACTIVATE_APPROVAL))) {
    fs.writeFileSync(path.join(process.cwd(), ACTIVATE_APPROVAL), approvalTemplate("activate"));
  }

  const bucketCounts: Record<QualityBucket, number> = {
    safe_exact_packaging: 0,
    needs_operator_review: 0,
    missing_dimensions: 0,
    conflicting_dimensions: 0,
    unsafe: 0,
  };

  const remaining: ClassifiedRow[] = [];
  let totalDryRun = 0;
  let pilotExcluded = 0;

  if (blockers.length === 0) {
    const all = await loadAllCandidates(dryRunDir);
    totalDryRun = all.length;
    for (const row of all) {
      const cid = row.candidate_id ?? "";
      if (pilot.has(cid)) {
        pilotExcluded++;
        continue;
      }
      const bucket = classifyQuality(row);
      bucketCounts[bucket]++;
      const conf = Number(row.confidence_score);
      remaining.push({
        candidate_id: cid,
        quality_bucket: bucket,
        recommended_action: row.recommended_action ?? "",
        blockers: row.blockers ?? "",
        packaging_level: row.packaging_level ?? "",
        fulfillment_context: row.fulfillment_context ?? "",
        source_type: row.source_type ?? "",
        product_id: row.product_id ?? "",
        has_lwh: hasLwh(row),
        confidence_score: Number.isFinite(conf) ? conf : null,
      });
    }
  }

  const safeRows = remaining
    .filter((r) => r.quality_bucket === "safe_exact_packaging")
    .sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0));

  // Pilot consumed all ready_for_execute AFI rows; fallback Wave 1 = PIM case-pack structure (needs_review insert)
  const wave1CandidatesAfi = remaining
    .filter(
      (r) =>
        r.quality_bucket === "missing_dimensions" &&
        r.blockers.includes("volume_only_no_lwh") &&
        !r.blockers.includes("source_conflict_afi_mfba") &&
        r.candidate_id.startsWith("afi-"),
    )
    .sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0));

  const wave1CandidatesPim = remaining
    .filter(
      (r) =>
        r.quality_bucket === "missing_dimensions" &&
        r.blockers.includes("pim_pack_structure_only") &&
        !r.blockers.includes("source_conflict_afi_mfba"),
    )
    .sort((a, b) => (b.confidence_score ?? 0) - (a.confidence_score ?? 0));

  const wave1Pool =
    safeRows.length > 0 ? safeRows : wave1CandidatesAfi.length > 0 ? wave1CandidatesAfi : wave1CandidatesPim;
  const wave1Strategy =
    safeRows.length > 0
      ? "safe_exact_packaging"
      : wave1CandidatesAfi.length > 0
        ? "missing_dimensions_volume_only_afi"
        : "missing_dimensions_pim_pack_structure";

  const wave1 = wave1Pool.slice(0, WAVE1_SAFE_LIMIT).map((r) => r.candidate_id);
  const wave2 = wave1Pool.slice(WAVE1_SAFE_LIMIT, WAVE1_SAFE_LIMIT + WAVE2_SAFE_LIMIT).map((r) => r.candidate_id);

  const waveSet = new Set([...wave1, ...wave2]);
  const manualReview = remaining
    .filter((r) => !waveSet.has(r.candidate_id))
    .map((r) => ({
      candidate_id: r.candidate_id,
      quality_bucket: r.quality_bucket,
      recommended_action: r.recommended_action,
      blockers: r.blockers,
      packaging_level: r.packaging_level,
      fulfillment_context: r.fulfillment_context,
      source_type: r.source_type,
      product_id: r.product_id,
      has_lwh: r.has_lwh,
      confidence_score: r.confidence_score,
    }));

  fs.writeFileSync(
    path.join(outDir, "remaining-safe-candidates.json"),
    JSON.stringify(
      {
        wave1_candidate_ids: wave1,
        wave2_candidate_ids: wave2,
        all_safe_candidate_ids: safeRows.map((r) => r.candidate_id),
        safe_total: safeRows.length,
        wave1_strategy: wave1Strategy,
        wave1_pool_size: wave1Pool.length,
        wave1_note:
          safeRows.length === 0
            ? "Pilot absorbed all ready_for_execute AFI; scale waves use controlled missing_dimensions cohorts"
            : null,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(path.join(outDir, "manual-review-queue.json"), JSON.stringify(manualReview, null, 2));

  fs.writeFileSync(
    path.join(outDir, "scale-candidate-census.md",
    ),
    [
      "# Scale candidate census — PC05D (plan only)",
      "",
      `**Run id:** \`${runId}\``,
      `**Branch:** \`${branch}\``,
      `**Staging ref (plan target):** \`${STAGING_REF}\``,
      `**Original ref:** \`${ORIGINAL_REF}\` — **not targeted**`,
      `**Dry-run:** \`${dryRunId}\``,
      "",
      "## Preconditions",
      "",
      `- PC05 pilot on staging: **191** active/current (excluded below)`,
      `- PC05C original execute: **${pc05cOk ? "PASS" : "MISSING"}** (\`${PC05C_EXECUTE_PROOF}\`)`,
      "",
      "## Dry-run totals",
      "",
      "| Metric | Count |",
      "|--------|------:|",
      `| Total dry-run candidates | ${totalDryRun} |`,
      `| Pilot excluded (accepted PC05) | ${pilotExcluded} |`,
      `| **Remaining (scale pool)** | **${remaining.length}** |`,
      "",
      "## Quality buckets (remaining only)",
      "",
      "| Bucket | Count |",
      "|--------|------:|",
      `| safe_exact_packaging | ${bucketCounts.safe_exact_packaging} |`,
      `| needs_operator_review | ${bucketCounts.needs_operator_review} |`,
      `| missing_dimensions | ${bucketCounts.missing_dimensions} |`,
      `| conflicting_dimensions | ${bucketCounts.conflicting_dimensions} |`,
      `| unsafe | ${bucketCounts.unsafe} |`,
      "",
      "## Recommended waves (staging execute — not run yet)",
      "",
      `| Wave | Size | Criteria |`,
      `|------|-----:|----------|`,
      `| Wave 1 (pilot scale) | ${wave1.length} | Strategy: \`${wave1Strategy}\`, cap ${WAVE1_SAFE_LIMIT} |`,
      `| Wave 2 (medium) | ${wave2.length} | Next row in Wave 1 pool, cap ${WAVE2_SAFE_LIMIT} |`,
      `| Manual review queue | ${manualReview.length} | All non-safe buckets |`,
      `| Safe backlog after Wave 2 | ${Math.max(0, safeRows.length - WAVE1_SAFE_LIMIT - WAVE2_SAFE_LIMIT)} | Remaining safe_exact |`,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "wave-plan.md",
    ),
    [
      "# Wave plan — PC05D staging scale",
      "",
      "## Wave 1 — small safe batch",
      "",
      `- **Count:** ${wave1.length} (max ${WAVE1_SAFE_LIMIT})`,
      `- **Strategy:** \`${wave1Strategy}\` (pool ${wave1Pool.length}; pilot took all \`ready_for_execute\` AFI)`,
      "- **Insert:** `needs_review` versions (same as PC05 pilot); separate activate approval",
      "- **List file:** `remaining-safe-candidates.json` → `wave1_candidate_ids`",
      "- **Execute approval:** `product-packaging-backfill-pc05d-scale-execute-approval.md`",
      "",
      "## Wave 2 — medium batch",
      "",
      `- **Count:** ${wave2.length} (max ${WAVE2_SAFE_LIMIT})`,
      "- Run only after Wave 1 execute + activate smoke PASS",
      "- **List file:** `remaining-safe-candidates.json` → `wave2_candidate_ids`",
      "",
      "## Manual review queue",
      "",
      `- **Count:** ${manualReview.length}`,
      "- **File:** `manual-review-queue.json`",
      "- Includes: operator review, missing L×W×H, AFI/MFBA conflicts, blocked/unsafe",
      "- Do not auto-execute; export for operator CSV review",
      "",
      "## Post-scale original parity",
      "",
      "After each staging wave is active/current, run a **new** original data parity plan+execute for that wave only (do not bulk-copy full 17k to original).",
      "",
      "## Forbidden",
      "",
      "- No DB writes in this plan run",
      "- No Amazon API / no AI",
      "- No `products` UPDATE",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "approval-files.md",
    ),
    [
      "# Approval files (default false)",
      "",
      "| File | Execute flag |",
      "|------|----------------|",
      `| \`${EXECUTE_APPROVAL}\` | \`APPROVED_PRODUCT_PACKAGING_BACKFILL_PC05D_SCALE_EXECUTE\` |`,
      `| \`${ACTIVATE_APPROVAL}\` | \`APPROVED_PRODUCT_PACKAGING_BACKFILL_PC05D_SCALE_ACTIVATE\` |`,
      "",
      "Both require `APPROVED_TO_RUN_STAGING=true`.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md",
    ),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "None.",
  );

  const ok = blockers.length === 0 && remaining.length > 0;
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PC05D — PACKAGING BACKFILL SCALE STAGING PLAN ONLY",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        dry_run_id: dryRunId,
        read_only: true,
        total_dry_run_candidates: totalDryRun,
        pilot_excluded: pilotExcluded,
        remaining_count: remaining.length,
        bucket_counts: bucketCounts,
        wave1_count: wave1.length,
        wave2_count: wave2.length,
        wave1_strategy: wave1Strategy,
        manual_review_count: manualReview.length,
        safe_exact_total: safeRows.length,
        pc05c_original_execute_ok: pc05cOk,
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
        remaining: remaining.length,
        wave1: wave1.length,
        manual_review: manualReview.length,
        safe_total: safeRows.length,
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
