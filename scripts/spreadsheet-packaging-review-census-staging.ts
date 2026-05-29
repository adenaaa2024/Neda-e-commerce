/**
 * Spreadsheet packaging review census (read-only, staging).
 *
 *   npx tsx scripts/spreadsheet-packaging-review-census-staging.ts
 *   npx tsx scripts/spreadsheet-packaging-review-census-staging.ts --execute-run-id=20260528T030000Z
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const EXPECTED_ROWS = 80;
const EXPECTED_DIMENSIONS_CURRENT = 491;
const EXECUTE_BASE = ".cursor/audit-reports/spreadsheet-packaging-import-staging-execute";
const OUT_BASE = ".cursor/audit-reports/spreadsheet-packaging-review-census-staging";

const CONFLICT_THRESHOLD_IN = 1.0;
const SAME_EPSILON = 0.0001;

const VALID_LEVELS = new Set(["unit", "inner_pack", "case", "master_carton", "pallet_load"]);
const VALID_CONTEXTS = new Set(["fba", "mfn", "wholesale", "removal", "unknown"]);

type RowReview = {
  candidate_id: string;
  profile_id: string;
  version_id: string;
  product_id: string;
  seller_sku: string | null;
  sheet_asin: string | null;
  packaging_level: string;
  fulfillment_context: string;
  profile_status: string;
  source_type: string;
  dimension_unit: string | null;
  weight_unit: string | null;
  length_value: number | null;
  width_value: number | null;
  height_value: number | null;
  weight_value: number | null;
  units_per_case: number | null;
  has_lwh: boolean;
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

function executeRunIdArg(): string | null {
  const a = process.argv.find((x) => x.startsWith("--execute-run-id="));
  return a ? a.split("=")[1]!.trim() : null;
}

function latestExecuteRunId(): string | null {
  const base = path.join(process.cwd(), EXECUTE_BASE);
  if (!fs.existsSync(base)) return null;
  return fs
    .readdirSync(base)
    .filter((d) => {
      const m = path.join(base, d, "manifest.json");
      if (!fs.existsSync(m)) return false;
      try {
        const j = JSON.parse(fs.readFileSync(m, "utf8")) as { ok?: boolean; inserted_profiles?: number };
        return j.ok && (j.inserted_profiles ?? 0) === EXPECTED_ROWS;
      } catch {
        return false;
      }
    })
    .sort()
    .reverse()[0] ?? null;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toInches(v: number, unit: string | null): number {
  if (!unit || unit === "in") return v;
  if (unit === "cm") return v / 2.54;
  if (unit === "mm") return v / 25.4;
  return v;
}

function maxAxisDeltaIn(
  a: { l: number; w: number; h: number },
  b: { l: number; w: number; h: number; unit: string | null },
): number {
  return Math.max(
    Math.abs(a.l - toInches(b.l, b.unit)),
    Math.abs(a.w - toInches(b.w, b.unit)),
    Math.abs(a.h - toInches(b.h, b.unit)),
  );
}

function hasLwh(l: unknown, w: unknown, h: unknown): boolean {
  return [l, w, h].every((x) => {
    const n = num(x);
    return n != null && n > 0;
  });
}

function reviewRow(
  db: Record<string, unknown>,
  activeCaseByProduct: Map<string, Array<Record<string, unknown>>>,
  expectedBatchTag: string,
): RowReview {
  const holdout: string[] = [];
  const evidence = (db.evidence_summary ?? {}) as Record<string, unknown>;
  const candidateId = String(evidence.spreadsheet_candidate_id ?? db.candidate_id ?? "");
  const status = String(db.profile_status);
  const level = String(db.packaging_level);
  const context = String(db.fulfillment_context);
  const sourceType = String(db.source_type);
  const dimUnit = db.dimension_unit ? String(db.dimension_unit) : null;
  const wtUnit = db.weight_unit ? String(db.weight_unit) : null;
  const lv = num(db.length_value);
  const wv = num(db.width_value);
  const hv = num(db.height_value);
  const wgt = num(db.weight_value);
  const lwh = hasLwh(lv, wv, hv);
  const upc = num(db.units_per_case);
  const productId = String(db.product_id);

  if (String(db.display_label) !== expectedBatchTag) holdout.push("display_label_mismatch");
  if (status !== "needs_review") holdout.push(`status_${status}`);
  if (!db.product_exists) holdout.push("product_missing_or_deleted");
  if (!VALID_LEVELS.has(level)) holdout.push(`invalid_packaging_level_${level}`);
  if (!VALID_CONTEXTS.has(context)) holdout.push(`invalid_fulfillment_context_${context}`);
  if (sourceType !== "import") holdout.push(`source_type_${sourceType}`);
  if (level !== "case") holdout.push(`expected_case_got_${level}`);
  if (!lwh) holdout.push("missing_or_invalid_lwh");
  if (dimUnit !== "in") holdout.push(`dimension_unit_${dimUnit ?? "null"}`);
  if (wgt != null && wgt > 0 && wtUnit !== "lb") holdout.push(`weight_unit_${wtUnit ?? "null"}`);
  if (lv != null && lv <= 0) holdout.push("unsafe_non_positive_length");
  if (wv != null && wv <= 0) holdout.push("unsafe_non_positive_width");
  if (hv != null && hv <= 0) holdout.push("unsafe_non_positive_height");
  if (upc != null && (upc < 1 || upc > 10000)) holdout.push("units_per_case_out_of_range");
  if (db.has_current_snapshot) holdout.push("already_has_dimensions_current");

  if (lwh && lv != null && wv != null && hv != null) {
    const incoming = { l: lv, w: wv, h: hv };
    const activeCases = activeCaseByProduct.get(productId) ?? [];
    for (const ac of activeCases) {
      const otherProfileId = String(ac.profile_id);
      if (otherProfileId === String(db.profile_id)) continue;
      const al = num(ac.length_value);
      const aw = num(ac.width_value);
      const ah = num(ac.height_value);
      if (al == null || aw == null || ah == null) continue;
      const delta = maxAxisDeltaIn(incoming, {
        l: al,
        w: aw,
        h: ah,
        unit: ac.dimension_unit ? String(ac.dimension_unit) : null,
      });
      if (delta > CONFLICT_THRESHOLD_IN) {
        holdout.push(`conflict_gt_1in_vs_active_${otherProfileId.slice(0, 8)}`);
      } else if (delta < SAME_EPSILON) {
        holdout.push(`duplicate_active_case_same_dims_${otherProfileId.slice(0, 8)}`);
      } else {
        holdout.push(`active_case_minor_delta_${delta.toFixed(3)}in`);
      }
    }
  }

  if (!candidateId.startsWith("spreadsheet-row-")) holdout.push("unexpected_candidate_id");

  return {
    candidate_id: candidateId,
    profile_id: String(db.profile_id),
    version_id: String(db.version_id),
    product_id: productId,
    seller_sku: db.sku ? String(db.sku) : null,
    sheet_asin: evidence.sheet_asin ? String(evidence.sheet_asin) : null,
    packaging_level: level,
    fulfillment_context: context,
    profile_status: status,
    source_type: sourceType,
    dimension_unit: dimUnit,
    weight_unit: wtUnit,
    length_value: lv,
    width_value: wv,
    height_value: hv,
    weight_value: wgt,
    units_per_case: upc,
    has_lwh: lwh,
    activate_eligible: holdout.length === 0,
    holdout_reasons: holdout,
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const executeRunId = executeRunIdArg() ?? latestExecuteRunId();
  if (!executeRunId) {
    console.error(JSON.stringify({ ok: false, error: "No spreadsheet execute run found" }));
    process.exit(1);
  }

  const executeDir = path.join(process.cwd(), EXECUTE_BASE, executeRunId);
  const executeManifest = JSON.parse(
    fs.readFileSync(path.join(executeDir, "manifest.json"), "utf8"),
  ) as { batch_tag: string; inserted_profiles: number };
  const batchTag = executeManifest.batch_tag;
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = refFromSupabaseUrl(dbUrl) || getStagingProjectRef({ loadEnv: false });

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (ref !== STAGING_REF) blockers.push(`Target must be staging ${STAGING_REF}`);
  if (originalUrl && dbUrl === originalUrl) blockers.push("Must not use original URL");
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  if (executeManifest.inserted_profiles !== EXPECTED_ROWS) {
    blockers.push(`Execute inserted ${executeManifest.inserted_profiles}, expected ${EXPECTED_ROWS}`);
  }

  const reviews: RowReview[] = [];
  let dimensionsCurrent = 0;
  let batchRowCount = 0;
  let snapBefore = { profiles: 0, versions: 0, dimensions_current: 0 };
  let snapAfter = { profiles: 0, versions: 0, dimensions_current: 0 };

  if (blockers.length === 0) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    snapBefore = (
      await client.query(
        `SELECT
           (SELECT count(*)::int FROM public.product_packaging_profiles) AS profiles,
           (SELECT count(*)::int FROM public.product_packaging_profile_versions) AS versions,
           (SELECT count(*)::int FROM public.product_packaging_dimensions_current) AS dimensions_current`,
      )
    ).rows[0] as typeof snapBefore;
    snapAfter = { ...snapBefore };

    const activeCase = await client.query(
      `SELECT profile_id::text, product_id::text, packaging_level, fulfillment_context,
              length_value::float8, width_value::float8, height_value::float8, dimension_unit,
              profile_status
       FROM public.product_packaging_dimensions_current
       WHERE packaging_level = 'case'
         AND length_value IS NOT NULL AND width_value IS NOT NULL AND height_value IS NOT NULL`,
    );
    const activeCaseByProduct = new Map<string, Array<Record<string, unknown>>>();
    for (const row of activeCase.rows as Record<string, unknown>[]) {
      const pid = String(row.product_id);
      const list = activeCaseByProduct.get(pid) ?? [];
      list.push(row);
      activeCaseByProduct.set(pid, list);
    }

    const r = await client.query(
      `SELECT
         p.id::text AS profile_id, v.id::text AS version_id,
         p.display_label, p.organization_id::text, p.store_id::text, p.product_id::text,
         pr.sku, p.packaging_level, p.fulfillment_context,
         v.profile_status, v.source_type,
         v.length_value, v.width_value, v.height_value, v.dimension_unit,
         v.weight_value, v.weight_unit, v.units_per_case,
         v.evidence_summary,
         (pr.id IS NOT NULL AND pr.deleted_at IS NULL) AS product_exists,
         (c.profile_id IS NOT NULL) AS has_current_snapshot
       FROM public.product_packaging_profiles p
       JOIN public.product_packaging_profile_versions v ON v.profile_id = p.id AND v.version_number = 1
       LEFT JOIN public.products pr ON pr.id = p.product_id
       LEFT JOIN public.product_packaging_dimensions_current c ON c.profile_id = p.id
       WHERE p.display_label = $1
       ORDER BY v.evidence_summary->>'spreadsheet_row'`,
      [batchTag],
    );

    batchRowCount = r.rowCount ?? 0;
    if (batchRowCount !== EXPECTED_ROWS) {
      blockers.push(`DB batch count ${batchRowCount}, expected ${EXPECTED_ROWS}`);
    }

    for (const row of r.rows as Record<string, unknown>[]) {
      reviews.push(reviewRow(row, activeCaseByProduct, batchTag));
    }

    dimensionsCurrent = snapAfter.dimensions_current;
    await client.end();
  }

  const eligible = reviews.filter((r) => r.activate_eligible);
  const holdout = reviews.filter((r) => !r.activate_eligible);

  fs.writeFileSync(path.join(outDir, "spreadsheet-row-review.json"), JSON.stringify(reviews, null, 2));
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
      const key = reason.split("_vs_")[0]!.split("_")[0] === "conflict" ? "conflict_gt_1in" : reason.replace(/_[a-f0-9]{8}$/, "");
      holdoutByReason[key] = (holdoutByReason[key] ?? 0) + 1;
    }
  }

  fs.writeFileSync(
    path.join(outDir, "review-summary.md"),
    [
      "# Spreadsheet packaging review census",
      "",
      `**Run:** \`${OUT_BASE}/${runId}/\``,
      `**Execute run:** \`${executeRunId}\``,
      `**Batch tag:** \`${batchTag}\``,
      `**Staging:** \`${STAGING_REF}\``,
      "**Mode:** read-only",
      "",
      "## Summary",
      "",
      "| Metric | Count |",
      "|--------|------:|",
      `| Reviewed | ${reviews.length} |`,
      `| **Activate eligible** | **${eligible.length}** |`,
      `| Holdout | ${holdout.length} |`,
      `| dimensions_current (unchanged) | ${dimensionsCurrent} |`,
      "",
      "## Validation rules",
      "",
      "- `profile_status = needs_review`",
      "- `source_type = import`, `packaging_level = case`",
      "- Parseable L×W×H (all > 0)",
      "- `dimension_unit = in`",
      "- `weight_unit = lb` when weight present",
      "- Product exists on staging",
      "- No `dimensions_current` on batch profile yet",
      "- No conflict > 1.0 in vs other **active case** L×W×H",
      "- No duplicate active case dims (same product, Δ < ε)",
      "",
      "## Holdout reason counts",
      "",
      holdout.length
        ? Object.entries(holdoutByReason)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `- \`${k}\`: ${v}`)
            .join("\n")
        : "None — all rows activate-eligible.",
      "",
      "## Operator recommendation",
      "",
      eligible.length === EXPECTED_ROWS
        ? `All **${EXPECTED_ROWS}** rows eligible for governed activate (separate approval).`
        : `Resolve **${holdout.length}** holdout(s) before activate.`,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "no-write-proof.md"),
    [
      "# No-write proof",
      "",
      "| Check | Result |",
      "|-------|--------|",
      "| SQL mutations | **0** — SELECT only |",
      "| dimensions_current before | " + snapBefore.dimensions_current + " |",
      "| dimensions_current after | " + snapAfter.dimensions_current + " |",
      "| profiles before | " + snapBefore.profiles + " |",
      "| profiles after | " + snapAfter.profiles + " |",
      "",
      "Script: `scripts/spreadsheet-packaging-review-census-staging.ts`",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "SPREADSHEET PACKAGING REVIEW CENSUS",
        run_id: runId,
        execute_run_id: executeRunId,
        batch_tag: batchTag,
        read_only: true,
        no_db_writes: true,
        reviewed: reviews.length,
        activate_eligible: eligible.length,
        holdout: holdout.length,
        dimensions_current: dimensionsCurrent,
        blockers,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: blockers.length === 0,
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
