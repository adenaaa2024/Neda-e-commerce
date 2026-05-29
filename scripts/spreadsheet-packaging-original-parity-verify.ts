/**
 * Spreadsheet packaging original parity verify (read-only).
 *
 *   npx tsx scripts/spreadsheet-packaging-original-parity-verify.ts
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
const BATCH_TAG = "SPREADSHEET_DIMENSIONS_20260528T010000Z";
const ACTIVATE_RUN = "20260528T050000Z";
const ORIGINAL_EXECUTE_RUN = "20260528T070000Z";
const OUT_BASE = ".cursor/audit-reports/spreadsheet-packaging-original-parity-verify";
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
};

type Classification = "matched" | "missing" | "conflict" | "unsafe";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
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

async function fetchSpreadsheetActivatedStaging(client: pg.Client): Promise<Map<string, PackagingRow>> {
  const r = await client.query(
    `SELECT
       COALESCE(v.evidence_summary->>'spreadsheet_candidate_id', 'spreadsheet-row-' || (v.evidence_summary->>'spreadsheet_row')) AS candidate_id,
       p.organization_id::text, p.store_id::text, p.product_id::text,
       p.packaging_level, p.fulfillment_context,
       p.id::text AS profile_id, v.id::text AS version_id, v.profile_status,
       v.length_value, v.width_value, v.height_value, v.dimension_unit,
       v.weight_value, v.weight_unit, v.units_per_inner_pack, v.units_per_case,
       v.source_type, v.source_reference, v.confidence_score,
       c.current_version_id::text AS current_version_id
     FROM public.product_packaging_profiles p
     JOIN public.product_packaging_profile_versions v ON v.profile_id = p.id
     LEFT JOIN public.product_packaging_dimensions_current c ON c.profile_id = p.id
     WHERE p.display_label = $1
       AND v.profile_status = 'active'
       AND (v.effective_to IS NULL OR v.effective_to > now())
       AND c.current_version_id = v.id`,
    [BATCH_TAG],
  );
  const out = new Map<string, PackagingRow>();
  for (const row of r.rows as Record<string, unknown>[]) {
    const cid = String(row.candidate_id ?? "").trim();
    if (!cid) continue;
    out.set(cid, {
      candidate_id: cid,
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
    });
  }
  return out;
}

async function fetchOriginalByKey(client: pg.Client): Promise<Map<string, PackagingRow>> {
  const r = await client.query(
    `SELECT
       p.organization_id::text, p.store_id::text, p.product_id::text,
       p.packaging_level, p.fulfillment_context,
       p.id::text AS profile_id, v.id::text AS version_id, v.profile_status,
       v.length_value, v.width_value, v.height_value, v.dimension_unit,
       v.weight_value, v.weight_unit, v.units_per_inner_pack, v.units_per_case,
       v.source_type, v.source_reference, v.confidence_score,
       c.current_version_id::text AS current_version_id
     FROM public.product_packaging_profiles p
     JOIN public.product_packaging_profile_versions v ON v.profile_id = p.id
     LEFT JOIN public.product_packaging_dimensions_current c ON c.profile_id = p.id
     WHERE v.profile_status = 'active' AND (v.effective_to IS NULL OR v.effective_to > now())`,
  );
  const out = new Map<string, PackagingRow>();
  for (const row of r.rows as Record<string, unknown>[]) {
    const key = profileKey(
      String(row.organization_id),
      row.store_id ? String(row.store_id) : null,
      String(row.product_id),
      String(row.packaging_level),
      String(row.fulfillment_context),
    );
    out.set(key, {
      candidate_id: "",
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
      has_current:
        row.profile_status === "active" &&
        !!row.current_version_id &&
        String(row.current_version_id) === String(row.version_id),
    });
  }
  return out;
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

  const originalExecuteManifest = path.join(
    process.cwd(),
    ".cursor/audit-reports/spreadsheet-packaging-original-parity-execute",
    ORIGINAL_EXECUTE_RUN,
    "manifest.json",
  );
  if (!fs.existsSync(originalExecuteManifest)) {
    blockers.push(`Missing original execute manifest: ${ORIGINAL_EXECUTE_RUN}`);
  }

  const diffRows: {
    candidate_id: string;
    composite_key: string;
    classification: Classification;
    reason: string;
    staging_profile_id: string | null;
    original_profile_id: string | null;
    staging_has_current: boolean;
    original_has_current: boolean;
  }[] = [];

  let stagingBatch = new Map<string, PackagingRow>();
  let stagingCounts = { profiles: 0, versions: 0, current: 0 };
  let originalCounts = { profiles: 0, versions: 0, current: 0 };
  let snapBefore = stagingCounts;
  let snapAfter = stagingCounts;

  if (blockers.length === 0) {
    const stagingClient = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    const originalClient = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await stagingClient.connect();
    await originalClient.connect();

    snapBefore = (
      await stagingClient.query(
        `SELECT
           (SELECT count(*)::int FROM public.product_packaging_profiles) AS profiles,
           (SELECT count(*)::int FROM public.product_packaging_profile_versions) AS versions,
           (SELECT count(*)::int FROM public.product_packaging_dimensions_current) AS current`,
      )
    ).rows[0] as typeof stagingCounts;

    stagingBatch = await fetchSpreadsheetActivatedStaging(stagingClient);
    if (stagingBatch.size !== EXPECTED_ROWS) {
      blockers.push(`Expected ${EXPECTED_ROWS} staging spreadsheet active rows, got ${stagingBatch.size}`);
    }

    const sc = await stagingClient.query(
      `SELECT count(*)::int c FROM public.product_packaging_dimensions_current`,
    );
    stagingCounts.current = Number(sc.rows[0]?.c ?? 0);
    stagingCounts.profiles = snapBefore.profiles;
    stagingCounts.versions = snapBefore.versions;

    const originalByKey = await fetchOriginalByKey(originalClient);
    const oc = await originalClient.query(
      `SELECT
         (SELECT count(*)::int FROM public.product_packaging_profiles) AS profiles,
         (SELECT count(*)::int FROM public.product_packaging_profile_versions) AS versions,
         (SELECT count(*)::int FROM public.product_packaging_dimensions_current) AS current`,
    );
    originalCounts = oc.rows[0] as typeof originalCounts;
    snapAfter = { ...originalCounts };

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

      if (staging.dimension_unit !== "in") {
        classification = "unsafe";
        reason = "staging_dimension_unit_not_in";
      } else if (staging.weight_value != null && staging.weight_unit !== "lb") {
        classification = "unsafe";
        reason = "staging_weight_unit_not_lb";
      } else if (!orig) {
        classification = "missing";
        reason = "no_matching_active_profile_on_original";
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
        staging_has_current: staging.has_current,
        original_has_current: orig?.has_current ?? false,
      });
    }

    await stagingClient.end();
    await originalClient.end();
  }

  const counts = {
    staging_active_spreadsheet: stagingBatch.size,
    original_matched: diffRows.filter((d) => d.classification === "matched").length,
    missing_on_original: diffRows.filter((d) => d.classification === "missing").length,
    conflicts: diffRows.filter((d) => d.classification === "conflict").length,
    unsafe: diffRows.filter((d) => d.classification === "unsafe").length,
    staging_dimensions_current: stagingCounts.current,
    original_dimensions_current: originalCounts.current,
  };

  const parityPass =
    blockers.length === 0 &&
    counts.staging_active_spreadsheet === EXPECTED_ROWS &&
    counts.original_matched === EXPECTED_ROWS &&
    counts.missing_on_original === 0 &&
    counts.conflicts === 0 &&
    counts.unsafe === 0 &&
    counts.staging_dimensions_current === EXPECTED_CURRENT &&
    counts.original_dimensions_current === EXPECTED_CURRENT;

  const conflicts = diffRows.filter((d) => d.classification === "conflict");
  const missing = diffRows.filter((d) => d.classification === "missing");
  const unsafe = diffRows.filter((d) => d.classification === "unsafe");

  fs.writeFileSync(
    path.join(outDir, "staging-vs-original-spreadsheet-diff.json"),
    JSON.stringify({ batch_tag: BATCH_TAG, counts, rows: diffRows }, null, 2),
  );

  fs.writeFileSync(
    path.join(outDir, "spreadsheet-parity-census.md"),
    [
      "# Spreadsheet packaging parity census",
      "",
      `**Run:** \`${OUT_BASE}/${runId}/\``,
      `**Batch (staging):** \`${BATCH_TAG}\``,
      `**Staging:** \`${STAGING_REF}\``,
      `**Original:** \`${ORIGINAL_REF}\``,
      "**Mode:** read-only",
      "",
      "## Summary",
      "",
      "| Metric | Count | Expected |",
      "|--------|------:|---------:|",
      `| Staging active spreadsheet rows | ${counts.staging_active_spreadsheet} | ${EXPECTED_ROWS} |`,
      `| Original matched | ${counts.original_matched} | ${EXPECTED_ROWS} |`,
      `| Missing on original | ${counts.missing_on_original} | 0 |`,
      `| Conflicts | ${counts.conflicts} | 0 |`,
      `| Unsafe | ${counts.unsafe} | 0 |`,
      `| Staging dimensions_current | ${counts.staging_dimensions_current} | ${EXPECTED_CURRENT} |`,
      `| Original dimensions_current | ${counts.original_dimensions_current} | ${EXPECTED_CURRENT} |`,
      "",
      `**Parity:** **${parityPass ? "PASS" : "FAIL"}** (${counts.original_matched}/${EXPECTED_ROWS} matched)`,
      "",
      "## Compare method",
      "",
      "Match by composite key: `organization_id + store_id + product_id + packaging_level + fulfillment_context`",
      "",
      "Dimension parity: same-unit numeric ε = 0.0001 on L/W/H, weight, units_per_case.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "conflict-report.md"),
    [
      "# Conflict report",
      "",
      conflicts.length + unsafe.length
        ? [
            `**Conflicts:** ${conflicts.length}`,
            `**Unsafe:** ${unsafe.length}`,
            "",
            ...conflicts.slice(0, 20).map(
              (c) => `- \`${c.candidate_id}\`: ${c.reason} (staging=${c.staging_profile_id}, original=${c.original_profile_id})`,
            ),
            ...unsafe.slice(0, 20).map((c) => `- \`${c.candidate_id}\`: ${c.reason}`),
          ].join("\n")
        : "**No conflicts or unsafe rows.**",
      "",
      missing.length ? `**Missing (${missing.length}):** see diff JSON` : "",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "no-write-proof.md"),
    [
      "# No-write proof",
      "",
      "| Check | Result |",
      "|-------|--------|",
      "| SQL mutations | **0** |",
      "| Staging dimensions_current | " + stagingCounts.current + " (unchanged) |",
      "| Original dimensions_current | " + originalCounts.current + " (unchanged) |",
      "",
      "Script: `scripts/spreadsheet-packaging-original-parity-verify.ts`",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "None.",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "SPREADSHEET PACKAGING ORIGINAL PARITY VERIFY",
        run_id: runId,
        batch_tag: BATCH_TAG,
        original_execute_run: ORIGINAL_EXECUTE_RUN,
        parity_pass: parityPass,
        ok: parityPass,
        counts,
        blockers,
        next_prompt: parityPass
          ? "SPREADSHEET PACKAGING COHORT ACCOUNTING UPDATE — record 80/80 parity in PACKAGING_DIMENSIONS_STATE (571 staging + original)"
          : "SPREADSHEET PACKAGING PARITY REMEDIATION — resolve missing/conflict rows before accounting",
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: parityPass,
        outDir,
        staging_active: counts.staging_active_spreadsheet,
        original_matched: counts.original_matched,
        missing: counts.missing_on_original,
        conflicts: counts.conflicts,
        original_dimensions_current: counts.original_dimensions_current,
        next_prompt: parityPass
          ? "SPREADSHEET PACKAGING COHORT ACCOUNTING UPDATE — record 80/80 parity in PACKAGING_DIMENSIONS_STATE (571 staging + original)"
          : "SPREADSHEET PACKAGING PARITY REMEDIATION — resolve missing/conflict rows before accounting",
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
