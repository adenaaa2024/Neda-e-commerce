/**
 * PC05D-WAVE1-REVIEW — Wave 1 packaging review census (read-only, staging).
 *
 *   npx tsx scripts/pc05d-wave1-review-census-staging.ts
 *   npx tsx scripts/pc05d-wave1-review-census-staging.ts --execute-run-id=20260526T190000Z
 */
import { createReadStream } from "node:fs";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const EXECUTE_DEFAULT = "20260526T190000Z";
const DRY_RUN_ID = "20260523T220000Z";
const DRY_RUN_DIR = `.cursor/audit-reports/pc05-product-packaging-governed-backfill-dry-run/${DRY_RUN_ID}`;
const EXECUTE_DIR = `.cursor/audit-reports/pc05d-wave1-packaging-scale-staging-execute/${EXECUTE_DEFAULT}`;
const OUT_BASE = ".cursor/audit-reports/pc05d-wave1-review-census-staging";

const VALID_LEVELS = new Set(["unit", "inner_pack", "case", "master_carton", "pallet_load"]);
const VALID_CONTEXTS = new Set(["fba", "mfn", "wholesale", "removal", "unknown"]);

type RowReview = {
  candidate_id: string;
  profile_id: string;
  version_id: string;
  product_id: string;
  sku: string | null;
  packaging_level: string;
  fulfillment_context: string;
  profile_status: string;
  source_type: string;
  units_per_case: number | null;
  units_per_inner_pack: number | null;
  has_lwh: boolean;
  dry_run_blockers: string;
  activate_eligible: boolean;
  holdout_reasons: string[];
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function executeRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--execute-run-id="));
  return a ? a.split("=")[1]!.trim() : EXECUTE_DEFAULT;
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

async function loadDryRunByCandidateIds(ids: Set<string>): Promise<Map<string, Record<string, string>>> {
  const csvPath = path.join(process.cwd(), DRY_RUN_DIR, "candidate-rows.csv");
  const out = new Map<string, Record<string, string>>();
  const rl = readline.createInterface({ input: createReadStream(csvPath, "utf8"), crlfDelay: Infinity });
  let headers: string[] = [];
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
    const cid = row.candidate_id ?? "";
    if (ids.has(cid)) out.set(cid, row);
  }
  return out;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function hasLwh(l: unknown, w: unknown, h: unknown): boolean {
  return [l, w, h].every((x) => {
    const n = num(x);
    return n != null && n > 0;
  });
}

function reviewRow(
  db: Record<string, unknown>,
  dry: Record<string, string> | undefined,
  expectedBatchTag: string,
): RowReview {
  const holdout: string[] = [];
  const candidateId = String(db.candidate_id ?? dry?.candidate_id ?? "");
  const status = String(db.profile_status);
  const level = String(db.packaging_level);
  const context = String(db.fulfillment_context);
  const sourceType = String(db.source_type);
  const lwh = hasLwh(db.length_value, db.width_value, db.height_value);
  const upc = num(db.units_per_case);
  const upi = num(db.units_per_inner_pack);
  const blockers = dry?.blockers ?? String(db.evidence_blockers ?? "");

  if (String(db.display_label) !== expectedBatchTag) holdout.push("display_label_mismatch");
  if (status !== "needs_review") holdout.push(`status_${status}`);
  if (!db.product_exists) holdout.push("product_missing_or_deleted");
  if (!db.store_exists && db.store_id) holdout.push("store_id_not_found");
  if (!VALID_LEVELS.has(level)) holdout.push(`invalid_packaging_level_${level}`);
  if (!VALID_CONTEXTS.has(context)) holdout.push(`invalid_fulfillment_context_${context}`);
  if (lwh) holdout.push("has_lwh_false_confidence_for_pim_pack_structure");
  if (sourceType !== "import") holdout.push(`source_type_${sourceType}_not_pim_import`);
  if (level !== "case") holdout.push(`expected_case_level_got_${level}`);
  if (context !== "wholesale") holdout.push(`expected_wholesale_context_got_${context}`);
  if (!blockers.includes("pim_pack_structure_only")) holdout.push("missing_pim_pack_structure_only_blocker");
  if (blockers.includes("source_conflict_afi_mfba")) holdout.push("source_conflict");
  if (upc != null && (upc < 1 || upc > 10000)) holdout.push("units_per_case_out_of_range");
  if (upi != null && (upi < 1 || upi > 10000)) holdout.push("units_per_inner_pack_out_of_range");
  if (upc == null && upi == null) holdout.push("no_units_per_case_or_inner_pack");
  if (db.has_current_snapshot) holdout.push("already_has_dimensions_current");
  if (!candidateId.startsWith("pim-")) holdout.push("not_pim_candidate_id");

  return {
    candidate_id: candidateId,
    profile_id: String(db.profile_id),
    version_id: String(db.version_id),
    product_id: String(db.product_id),
    sku: db.sku ? String(db.sku) : null,
    packaging_level: level,
    fulfillment_context: context,
    profile_status: status,
    source_type: sourceType,
    units_per_case: upc,
    units_per_inner_pack: upi,
    has_lwh: lwh,
    dry_run_blockers: blockers,
    activate_eligible: holdout.length === 0,
    holdout_reasons: holdout,
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const executeRunId = executeRunIdArg();
  const batchTag = `PC05D_WAVE1_${executeRunId}`;
  const executeDir = path.join(process.cwd(), `.cursor/audit-reports/pc05d-wave1-packaging-scale-staging-execute`, executeRunId);
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = refFromSupabaseUrl(dbUrl) || getStagingProjectRef({ loadEnv: false });

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (ref !== STAGING_REF) blockers.push(`Target must be staging ${STAGING_REF}`);
  const summaryPath = path.join(executeDir, "insert-summary.json");
  if (!fs.existsSync(summaryPath)) blockers.push(`Missing ${summaryPath}`);

  const inserted = fs.existsSync(summaryPath)
    ? (JSON.parse(fs.readFileSync(summaryPath, "utf8")) as {
        insertedIds: { candidate_id: string; profile_id: string; version_id: string }[];
      }).insertedIds
    : [];

  if (inserted.length !== 50) blockers.push(`Expected 50 inserted rows, got ${inserted.length}`);

  const reviews: RowReview[] = [];

  if (blockers.length === 0 && dbUrl) {
    const candidateIds = new Set(inserted.map((r) => r.candidate_id));
    const dryMap = await loadDryRunByCandidateIds(candidateIds);

    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    const r = await client.query(
      `SELECT
         v.evidence_summary->>'pc05_candidate_id' AS candidate_id,
         p.id::text AS profile_id, v.id::text AS version_id,
         p.display_label, p.organization_id::text, p.store_id::text, p.product_id::text,
         pr.sku, p.packaging_level, p.fulfillment_context,
         v.profile_status, v.source_type,
         v.length_value, v.width_value, v.height_value,
         v.units_per_case, v.units_per_inner_pack,
         v.evidence_summary->>'pc05_blockers' AS evidence_blockers,
         (pr.id IS NOT NULL AND pr.deleted_at IS NULL) AS product_exists,
         (s.id IS NOT NULL) AS store_exists,
         (c.profile_id IS NOT NULL) AS has_current_snapshot
       FROM public.product_packaging_profiles p
       JOIN public.product_packaging_profile_versions v ON v.profile_id = p.id
       LEFT JOIN public.products pr ON pr.id = p.product_id
       LEFT JOIN public.stores s ON s.id = p.store_id
       LEFT JOIN public.product_packaging_dimensions_current c ON c.profile_id = p.id
       WHERE p.display_label = $1`,
      [batchTag],
    );

    if ((r.rowCount ?? 0) !== 50) {
      blockers.push(`DB batch row count ${r.rowCount ?? 0}, expected 50 for ${batchTag}`);
    }

    for (const row of r.rows as Record<string, unknown>[]) {
      const cid = String(row.candidate_id ?? "");
      reviews.push(reviewRow(row, dryMap.get(cid), batchTag));
    }

    const curCount = await client.query(`SELECT count(*)::int c FROM public.product_packaging_dimensions_current`);
    fs.writeFileSync(
      path.join(outDir, "staging-snapshot.json"),
      JSON.stringify({ batch_tag: batchTag, dimensions_current_total: curCount.rows[0]?.c }, null, 2),
    );

    await client.end();
  }

  const eligible = reviews.filter((r) => r.activate_eligible);
  const holdout = reviews.filter((r) => !r.activate_eligible);

  fs.writeFileSync(path.join(outDir, "wave1-row-review.json"), JSON.stringify(reviews, null, 2));
  fs.writeFileSync(
    path.join(outDir, "activate-eligible-ids.txt"),
    eligible.map((r) => r.version_id).join("\n") + (eligible.length ? "\n" : ""),
  );
  fs.writeFileSync(
    path.join(outDir, "holdout-ids.txt"),
    holdout.map((r) => `${r.version_id}\t${r.holdout_reasons.join(";")}`).join("\n") + (holdout.length ? "\n" : ""),
  );

  const holdoutByReason: Record<string, number> = {};
  for (const h of holdout) {
    for (const reason of h.holdout_reasons) {
      holdoutByReason[reason] = (holdoutByReason[reason] ?? 0) + 1;
    }
  }

  fs.writeFileSync(
    path.join(outDir, "wave1-review-census.md"),
    [
      "# Wave 1 review census — PC05D (read-only)",
      "",
      `**Run id:** \`${runId}\``,
      `**Execute run:** \`${executeRunId}\``,
      `**Batch tag:** \`${batchTag}\``,
      `**Branch:** \`${branch}\``,
      `**Staging:** \`${STAGING_REF}\``,
      "",
      "## Summary",
      "",
      "| Metric | Count |",
      "|--------|------:|",
      `| Reviewed | ${reviews.length} |`,
      `| Activate eligible | ${eligible.length} |`,
      `| Holdout | ${holdout.length} |`,
      "",
      "## Validation rules (PIM pack structure cohort)",
      "",
      "- `needs_review` status only",
      "- `packaging_level=case`, `fulfillment_context=wholesale`, `source_type=import`",
      "- Dry-run blocker includes `pim_pack_structure_only`",
      "- No L×W×H populated (pack structure only, not dimensional claims)",
      "- `units_per_case` or `units_per_inner_pack` present and in range 1–10000",
      "- Product exists on staging; no pre-existing `dimensions_current` for profile",
      "",
      "## Holdout reason counts",
      "",
      holdout.length
        ? Object.entries(holdoutByReason)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `- \`${k}\`: ${v}`)
            .join("\n")
        : "None — all 50 eligible for governed activate.",
      "",
      "## Operator recommendation",
      "",
      eligible.length === 50
        ? "All 50 rows pass automated review for **pack-structure-only** activation. Operator should still spot-check case_pack semantics before signing activate approval."
        : `Review holdout-ids.txt (${holdout.length} rows) before any activate run.`,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "no-write-proof.md"),
    [
      "# No-write proof",
      "",
      "- Read-only SELECT on staging",
      "- No activate, no INSERT/UPDATE/DELETE",
      "- Original not queried for writes",
      `- Script: scripts/pc05d-wave1-review-census-staging.ts`,
    ].join("\n"),
  );

  fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "None.");

  const ok = blockers.length === 0 && reviews.length === 50;
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PC05D-WAVE1-REVIEW — PACKAGING SCALE WAVE 1 REVIEW CENSUS",
        run_id: runId,
        execute_run_id: executeRunId,
        batch_tag: batchTag,
        branch,
        staging_ref: STAGING_REF,
        read_only: true,
        reviewed_count: reviews.length,
        activate_eligible_count: eligible.length,
        holdout_count: holdout.length,
        holdout_by_reason: holdoutByReason,
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
        reviewed: reviews.length,
        activate_eligible: eligible.length,
        holdout: holdout.length,
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
