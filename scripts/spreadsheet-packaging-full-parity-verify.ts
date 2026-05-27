/**
 * Spreadsheet packaging full parity verify — staging vs original (read-only).
 *
 *   npx tsx scripts/spreadsheet-packaging-full-parity-verify.ts
 *   npx tsx scripts/spreadsheet-packaging-full-parity-verify.ts --run-id=<UTC_Z>
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

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const STAGING_BATCH = "SPREADSHEET_DIMENSIONS_20260528T010000Z";
const ORIGINAL_BATCH = "SPREADSHEET_DIMENSIONS_ORIGINAL_20260528T070000Z";
const OUT_BASE = ".cursor/audit-reports/spreadsheet-packaging-full-parity-verify";
const EXPECTED_ROWS = 80;
const EXPECTED_CURRENT = 571;

type PackagingRow = {
  candidate_id: string;
  organization_id: string;
  store_id: string | null;
  product_id: string;
  packaging_level: string;
  fulfillment_context: string;
  profile_id: string;
  version_id: string;
  profile_status: string;
  length_value: number | null;
  width_value: number | null;
  height_value: number | null;
  dimension_unit: string | null;
  weight_value: number | null;
  weight_unit: string | null;
  units_per_inner_pack: number | null;
  units_per_case: number | null;
  source_type: string;
  source_reference: string | null;
  confidence_score: number | null;
  has_current: boolean;
  display_label: string | null;
};

type Classification = "matched" | "missing" | "conflict" | "unsafe";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function profileKey(
  org: string,
  store: string | null,
  product: string,
  level: string,
  context: string,
): string {
  return `${org}|${store ?? ""}|${product}|${level}|${context}`;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dimsMatch(a: PackagingRow, b: PackagingRow): boolean {
  const fields: (keyof PackagingRow)[] = [
    "length_value",
    "width_value",
    "height_value",
    "dimension_unit",
    "weight_value",
    "weight_unit",
    "units_per_inner_pack",
    "units_per_case",
  ];
  return fields.every((f) => {
    const av = a[f];
    const bv = b[f];
    if (av == null && bv == null) return true;
    if (typeof av === "number" && typeof bv === "number") return Math.abs(av - bv) < 0.0001;
    return av === bv;
  });
}

async function fetchBatchActive(
  client: pg.Client,
  batchTag: string | null,
): Promise<Map<string, PackagingRow>> {
  const whereBatch = batchTag ? "AND p.display_label = $1" : "";
  const params = batchTag ? [batchTag] : [];
  const r = await client.query(
    `SELECT
       COALESCE(v.evidence_summary->>'spreadsheet_candidate_id',
         'spreadsheet-row-' || (v.evidence_summary->>'spreadsheet_row')) AS candidate_id,
       p.organization_id::text, p.store_id::text, p.product_id::text,
       p.packaging_level, p.fulfillment_context, p.display_label,
       p.id::text AS profile_id, v.id::text AS version_id, v.profile_status,
       v.length_value, v.width_value, v.height_value, v.dimension_unit,
       v.weight_value, v.weight_unit, v.units_per_inner_pack, v.units_per_case,
       v.source_type, v.source_reference, v.confidence_score,
       c.current_version_id::text AS current_version_id
     FROM public.product_packaging_profiles p
     JOIN public.product_packaging_profile_versions v ON v.profile_id = p.id
     LEFT JOIN public.product_packaging_dimensions_current c ON c.profile_id = p.id
     WHERE v.profile_status = 'active'
       AND (v.effective_to IS NULL OR v.effective_to > now())
       AND c.current_version_id = v.id
       ${whereBatch}`,
    params,
  );
  const out = new Map<string, PackagingRow>();
  for (const row of r.rows as Record<string, unknown>[]) {
    const cid = String(row.candidate_id ?? "").trim();
    const key = profileKey(
      String(row.organization_id),
      row.store_id ? String(row.store_id) : null,
      String(row.product_id),
      String(row.packaging_level),
      String(row.fulfillment_context),
    );
    const pkg: PackagingRow = {
      candidate_id: cid || key,
      organization_id: String(row.organization_id),
      store_id: row.store_id ? String(row.store_id) : null,
      product_id: String(row.product_id),
      packaging_level: String(row.packaging_level),
      fulfillment_context: String(row.fulfillment_context),
      profile_id: String(row.profile_id),
      version_id: String(row.version_id),
      profile_status: String(row.profile_status),
      length_value: num(row.length_value),
      width_value: num(row.width_value),
      height_value: num(row.height_value),
      dimension_unit: row.dimension_unit ? String(row.dimension_unit) : null,
      weight_value: num(row.weight_value),
      weight_unit: row.weight_unit ? String(row.weight_unit) : null,
      units_per_inner_pack: num(row.units_per_inner_pack),
      units_per_case: num(row.units_per_case),
      source_type: String(row.source_type),
      source_reference: row.source_reference ? String(row.source_reference) : null,
      confidence_score: num(row.confidence_score),
      has_current: true,
      display_label: row.display_label ? String(row.display_label) : null,
    };
    out.set(key, pkg);
  }
  return out;
}

async function fetchOriginalByComposite(client: pg.Client): Promise<Map<string, PackagingRow>> {
  return fetchBatchActive(client, null);
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const stagingRef = refFromConnectionUrl(stagingUrl) || getStagingProjectRef({ loadEnv: false });
  const originalRef = refFromConnectionUrl(originalUrl);

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (stagingRef !== STAGING_REF) blockers.push(`Staging ref must be ${STAGING_REF}`);
  if (originalRef !== ORIGINAL_REF) blockers.push(`Original ref must be ${ORIGINAL_REF}`);
  if (!stagingUrl || !originalUrl) blockers.push("Missing postgres URLs");
  if (stagingUrl === originalUrl) blockers.push("URLs must differ");

  const diffRows: {
    candidate_id: string;
    composite_key: string;
    classification: Classification;
    reason: string;
    staging_profile_id: string | null;
    original_profile_id: string | null;
    staging_display_label: string | null;
    original_display_label: string | null;
  }[] = [];

  let stagingBatch = new Map<string, PackagingRow>();
  let originalBatch = new Map<string, PackagingRow>();
  let stagingCounts = { current: 0, batch_active: 0 };
  let originalCounts = { current: 0, batch_active: 0 };

  if (blockers.length === 0) {
    const stagingClient = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    const originalClient = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await stagingClient.connect();
    await originalClient.connect();

    stagingBatch = await fetchBatchActive(stagingClient, STAGING_BATCH);
    originalBatch = await fetchBatchActive(originalClient, ORIGINAL_BATCH);

    const sc = await stagingClient.query(
      `SELECT count(*)::int AS current FROM public.product_packaging_dimensions_current`,
    );
    const oc = await originalClient.query(
      `SELECT count(*)::int AS current FROM public.product_packaging_dimensions_current`,
    );
    stagingCounts.current = Number(sc.rows[0]?.current ?? 0);
    originalCounts.current = Number(oc.rows[0]?.current ?? 0);
    stagingCounts.batch_active = stagingBatch.size;
    originalCounts.batch_active = originalBatch.size;

    const originalByKey = await fetchOriginalByComposite(originalClient);

    for (const staging of stagingBatch.values()) {
      const composite = profileKey(
        staging.organization_id,
        staging.store_id,
        staging.product_id,
        staging.packaging_level,
        staging.fulfillment_context,
      );

      let classification: Classification = "missing";
      let reason = "";
      const orig = originalByKey.get(composite) ?? null;
      const origBatchRow = originalBatch.get(composite) ?? null;

      if (staging.dimension_unit !== "in") {
        classification = "unsafe";
        reason = "staging_dimension_unit_not_in";
      } else if (staging.weight_value != null && staging.weight_unit !== "lb") {
        classification = "unsafe";
        reason = "staging_weight_unit_not_lb";
      } else if (!orig) {
        classification = "missing";
        reason = "no_matching_active_profile_on_original";
      } else if (!origBatchRow) {
        classification = "missing";
        reason = "original_profile_not_in_spreadsheet_batch";
      } else if (!dimsMatch(staging, orig) || staging.profile_status !== orig.profile_status) {
        classification = "conflict";
        reason = !dimsMatch(staging, orig) ? "dimension_or_unit_mismatch" : "status_mismatch";
      } else if (!staging.has_current || !orig.has_current) {
        classification = "missing";
        reason = "missing_current_snapshot";
      } else {
        classification = "matched";
        reason = "parity_match";
      }

      diffRows.push({
        candidate_id: staging.candidate_id,
        composite_key: composite,
        classification,
        reason,
        staging_profile_id: staging.profile_id,
        original_profile_id: orig?.profile_id ?? null,
        staging_display_label: staging.display_label,
        original_display_label: orig?.display_label ?? null,
      });
    }

    await stagingClient.end();
    await originalClient.end();
  }

  const matched = diffRows.filter((d) => d.classification === "matched").length;
  const missing = diffRows.filter((d) => d.classification === "missing").length;
  const conflicts = diffRows.filter((d) => d.classification === "conflict").length;
  const unsafe = diffRows.filter((d) => d.classification === "unsafe").length;
  const driftCount = missing + conflicts + unsafe;

  const parityPass =
    blockers.length === 0 &&
    stagingCounts.batch_active === EXPECTED_ROWS &&
    originalCounts.batch_active === EXPECTED_ROWS &&
    matched === EXPECTED_ROWS &&
    missing === 0 &&
    conflicts === 0 &&
    unsafe === 0 &&
    stagingCounts.current === EXPECTED_CURRENT &&
    originalCounts.current === EXPECTED_CURRENT;

  const nextPrompt = parityPass
    ? "SPREADSHEET PACKAGING COHORT ACCOUNTING UPDATE — record 80/80 parity in PACKAGING_DIMENSIONS_STATE (571 staging + original)"
    : "SPREADSHEET PACKAGING PARITY REMEDIATION — resolve drift/conflict rows before accounting";

  fs.writeFileSync(
    path.join(outDir, "staging-vs-original-spreadsheet-diff.json"),
    JSON.stringify(
      {
        staging_batch: STAGING_BATCH,
        original_batch: ORIGINAL_BATCH,
        staging_count: stagingCounts.batch_active,
        original_batch_count: originalCounts.batch_active,
        matched,
        missing,
        conflicts,
        unsafe,
        drift_count: driftCount,
        rows: diffRows,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "full-parity-verify.md"),
    [
      "# Spreadsheet packaging full parity verify",
      "",
      `**Run:** \`${OUT_BASE}/${runId}/\``,
      `**Staging batch:** \`${STAGING_BATCH}\``,
      `**Original batch:** \`${ORIGINAL_BATCH}\``,
      `**Staging ref:** \`${STAGING_REF}\` | **Original ref:** \`${ORIGINAL_REF}\``,
      "**Mode:** read-only · **0 SQL mutations**",
      "",
      "## Required checks",
      "",
      "| Check | Actual | Expected | OK |",
      "|-------|-------:|---------:|:--:|",
      `| Staging spreadsheet active rows | ${stagingCounts.batch_active} | ${EXPECTED_ROWS} | ${stagingCounts.batch_active === EXPECTED_ROWS ? "✓" : "✗"} |`,
      `| Original spreadsheet batch active | ${originalCounts.batch_active} | ${EXPECTED_ROWS} | ${originalCounts.batch_active === EXPECTED_ROWS ? "✓" : "✗"} |`,
      `| Matched (composite key + dims) | ${matched} | ${EXPECTED_ROWS} | ${matched === EXPECTED_ROWS ? "✓" : "✗"} |`,
      `| Missing | ${missing} | 0 | ${missing === 0 ? "✓" : "✗"} |`,
      `| Conflicts | ${conflicts} | 0 | ${conflicts === 0 ? "✓" : "✗"} |`,
      `| Unsafe | ${unsafe} | 0 | ${unsafe === 0 ? "✓" : "✗"} |`,
      `| Staging dimensions_current | ${stagingCounts.current} | ${EXPECTED_CURRENT} | ${stagingCounts.current === EXPECTED_CURRENT ? "✓" : "✗"} |`,
      `| Original dimensions_current | ${originalCounts.current} | ${EXPECTED_CURRENT} | ${originalCounts.current === EXPECTED_CURRENT ? "✓" : "✗"} |`,
      "",
      `**Result:** **${parityPass ? "PASS" : "FAIL"}** · drift=${driftCount}`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "conflict-report.md",
    ),
    conflicts + unsafe
      ? [
          "# Conflicts / unsafe",
          "",
          ...diffRows
            .filter((d) => d.classification === "conflict" || d.classification === "unsafe")
            .map((d) => `- \`${d.candidate_id}\`: ${d.classification} — ${d.reason}`),
        ].join("\n") + "\n"
      : "# Conflicts / unsafe\n\nNone.\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") + "\n" : "None.\n",
  );

  fs.writeFileSync(
    path.join(outDir, "no-write-proof.md"),
    [
      "# No-write proof",
      "",
      "- SQL mutations: **0**",
      `- Staging dimensions_current observed: **${stagingCounts.current}**`,
      `- Original dimensions_current observed: **${originalCounts.current}**`,
      "- Script: `scripts/spreadsheet-packaging-full-parity-verify.ts`",
    ].join("\n") + "\n",
  );

  const manifest = {
    prompt: "SPREADSHEET PACKAGING FULL PARITY VERIFY",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    original_ref: ORIGINAL_REF,
    staging_batch: STAGING_BATCH,
    original_batch: ORIGINAL_BATCH,
    status: parityPass ? "PASS" : "FAIL",
    parity_pass: parityPass,
    staging_count: stagingCounts.batch_active,
    original_count: originalCounts.batch_active,
    original_matched_count: matched,
    drift_count: driftCount,
    conflict_count: conflicts,
    missing_count: missing,
    unsafe_count: unsafe,
    staging_dimensions_current: stagingCounts.current,
    original_dimensions_current: originalCounts.current,
    blockers,
    exact_next_prompt: nextPrompt,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
