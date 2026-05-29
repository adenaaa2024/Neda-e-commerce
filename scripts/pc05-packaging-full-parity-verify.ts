/**
 * PC05-PACKAGING-FULL-PARITY-VERIFY — Staging vs original total census (read-only).
 *
 *   npx tsx scripts/pc05-packaging-full-parity-verify.ts
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
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/pc05-packaging-full-parity-verify";
const EXPECTED_TOTAL = 441;
const WAVE1_TAG = "PC05D_WAVE1_20260526T190000Z";
const WAVE2_TAG = "PC05D_WAVE2_20260526T202000Z";
const DRY_RUN_ID = "20260523T220000Z";

type GovernedRow = {
  composite_key: string;
  candidate_id: string;
  profile_id: string;
  version_id: string;
  display_label: string | null;
  organization_id: string;
  store_id: string | null;
  product_id: string;
  packaging_level: string;
  fulfillment_context: string;
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
  product_exists: boolean;
  evidence_summary: Record<string, unknown>;
};

type Classification = "matched" | "staging_only" | "original_only" | "conflict" | "unsafe";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

function profileKey(org: string, store: string | null, product: string, level: string, context: string): string {
  return `${org}|${store ?? ""}|${product}|${level}|${context}`;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dimsMatch(a: GovernedRow, b: GovernedRow): boolean {
  const fields: (keyof GovernedRow)[] = [
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

function batchCohort(
  label: string | null,
  candidateId: string,
  evidence?: Record<string, unknown>,
): "pilot" | "wave1" | "wave2" | "other" {
  if (label === WAVE1_TAG || label?.startsWith("PC05E_WAVE1_ORIGINAL")) return "wave1";
  if (label === WAVE2_TAG || label?.startsWith("PC05F_WAVE2_ORIGINAL")) return "wave2";
  if (evidence?.wave1_execute_run || evidence?.wave1_activate_run) return "wave1";
  if (evidence?.wave2_execute_run || evidence?.wave2_activate_run) return "wave2";
  if (
    candidateId.startsWith("afi-") ||
    label?.includes("PC05C") ||
    label?.includes("PC05_BACKFILL") ||
    label?.startsWith("PC05C_ORIGINAL")
  ) {
    return "pilot";
  }
  return "other";
}

async function fetchGovernedCurrent(client: pg.Client): Promise<Map<string, GovernedRow>> {
  const r = await client.query(
    `SELECT
       c.profile_id::text,
       c.current_version_id::text AS version_id,
       p.display_label,
       p.organization_id::text,
       p.store_id::text,
       p.product_id::text,
       p.packaging_level,
       p.fulfillment_context,
       v.profile_status,
       v.length_value, v.width_value, v.height_value, v.dimension_unit,
       v.weight_value, v.weight_unit, v.units_per_inner_pack, v.units_per_case,
       v.source_type,
       v.evidence_summary->>'pc05_candidate_id' AS candidate_id,
       v.evidence_summary,
       (pr.id IS NOT NULL AND pr.deleted_at IS NULL) AS product_exists
     FROM public.product_packaging_dimensions_current c
     JOIN public.product_packaging_profiles p ON p.id = c.profile_id
     JOIN public.product_packaging_profile_versions v ON v.id = c.current_version_id
     LEFT JOIN public.products pr ON pr.id = p.product_id
     WHERE v.profile_status = 'active' AND v.effective_to IS NULL`,
  );
  const out = new Map<string, GovernedRow>();
  for (const row of r.rows as Record<string, unknown>[]) {
    const org = String(row.organization_id);
    const store = row.store_id ? String(row.store_id) : null;
    const product = String(row.product_id);
    const level = String(row.packaging_level);
    const context = String(row.fulfillment_context);
    const key = profileKey(org, store, product, level, context);
    const candidateId = String(row.candidate_id ?? "");
    const evidence = (row.evidence_summary as Record<string, unknown>) ?? {};
    out.set(key, {
      composite_key: key,
      candidate_id: candidateId,
      profile_id: String(row.profile_id),
      version_id: String(row.version_id),
      display_label: row.display_label ? String(row.display_label) : null,
      organization_id: org,
      store_id: store,
      product_id: product,
      packaging_level: level,
      fulfillment_context: context,
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
      product_exists: !!row.product_exists,
      evidence_summary: evidence,
    });
  }
  return out;
}

function cohortOf(row: GovernedRow): "pilot" | "wave1" | "wave2" | "other" {
  return batchCohort(row.display_label, row.candidate_id, row.evidence_summary);
}

async function runOrphanChecks(client: pg.Client, env: string): Promise<Record<string, number | string[]>> {
  const issues: string[] = [];

  const curWithoutActive = await client.query(
    `SELECT c.profile_id::text
     FROM public.product_packaging_dimensions_current c
     LEFT JOIN public.product_packaging_profile_versions v
       ON v.id = c.current_version_id AND v.profile_status = 'active' AND v.effective_to IS NULL
     WHERE v.id IS NULL`,
  );
  if ((curWithoutActive.rowCount ?? 0) > 0) {
    issues.push(`current_without_active_version:${curWithoutActive.rowCount}`);
  }

  const activeWithoutCur = await client.query(
    `SELECT v.id::text
     FROM public.product_packaging_profile_versions v
     WHERE v.profile_status = 'active' AND v.effective_to IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.product_packaging_dimensions_current c WHERE c.current_version_id = v.id
       )`,
  );
  if ((activeWithoutCur.rowCount ?? 0) > 0) {
    issues.push(`active_version_without_current:${activeWithoutCur.rowCount}`);
  }

  const orphanVersions = await client.query(
    `SELECT v.id::text
     FROM public.product_packaging_profile_versions v
     LEFT JOIN public.product_packaging_profiles p ON p.id = v.profile_id
     WHERE p.id IS NULL`,
  );
  if ((orphanVersions.rowCount ?? 0) > 0) {
    issues.push(`orphan_versions:${orphanVersions.rowCount}`);
  }

  const noProduct = await client.query(
    `SELECT p.id::text
     FROM public.product_packaging_profiles p
     WHERE p.product_id IS NULL`,
  );
  if ((noProduct.rowCount ?? 0) > 0) {
    issues.push(`profile_without_product_id:${noProduct.rowCount}`);
  }

  const missingProduct = await client.query(
    `SELECT p.id::text
     FROM public.product_packaging_profiles p
     LEFT JOIN public.products pr ON pr.id = p.product_id
     WHERE pr.id IS NULL OR pr.deleted_at IS NOT NULL`,
  );

  const curCount = await client.query(`SELECT count(*)::int c FROM public.product_packaging_dimensions_current`);

  return {
    env,
    dimensions_current: curCount.rows[0]?.c ?? 0,
    current_without_active_version: curWithoutActive.rowCount ?? 0,
    active_without_current: activeWithoutCur.rowCount ?? 0,
    orphan_versions: orphanVersions.rowCount ?? 0,
    profile_without_product_id: noProduct.rowCount ?? 0,
    profiles_with_missing_or_deleted_product: missingProduct.rowCount ?? 0,
    issues,
  };
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

  let stagingGov = new Map<string, GovernedRow>();
  let originalGov = new Map<string, GovernedRow>();
  const diffRows: {
    composite_key: string;
    classification: Classification;
    reason: string;
    staging_profile_id: string | null;
    original_profile_id: string | null;
    batch_staging: string;
    batch_original: string;
  }[] = [];

  let orphanStaging: Record<string, unknown> = {};
  let orphanOriginal: Record<string, unknown> = {};

  if (blockers.length === 0) {
    const stagingClient = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    const originalClient = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await stagingClient.connect();
    await originalClient.connect();

    stagingGov = await fetchGovernedCurrent(stagingClient);
    originalGov = await fetchGovernedCurrent(originalClient);

    if (stagingGov.size !== EXPECTED_TOTAL) {
      blockers.push(`Staging dimensions_current governed set ${stagingGov.size}, expected ${EXPECTED_TOTAL}`);
    }
    if (originalGov.size !== EXPECTED_TOTAL) {
      blockers.push(`Original dimensions_current governed set ${originalGov.size}, expected ${EXPECTED_TOTAL}`);
    }

    const allKeys = new Set([...stagingGov.keys(), ...originalGov.keys()]);
    for (const key of allKeys) {
      const s = stagingGov.get(key) ?? null;
      const o = originalGov.get(key) ?? null;
      let classification: Classification;
      let reason = "";

      if (s && !o) {
        classification = "staging_only";
        reason = "present_on_staging_not_original";
      } else if (!s && o) {
        classification = "original_only";
        reason = "present_on_original_not_staging";
      } else if (!s || !o) {
        classification = "unsafe";
        reason = "unexpected_null";
      } else if (!s.product_exists || !o.product_exists) {
        classification = "unsafe";
        reason = "product_missing_or_deleted";
      } else if (!dimsMatch(s, o) || s.profile_status !== o.profile_status) {
        classification = "conflict";
        reason = !dimsMatch(s, o) ? "dimension_or_unit_mismatch" : "status_mismatch";
      } else if (s.version_id !== o.version_id) {
        classification = "matched";
        reason = "parity_match_different_version_ids";
      } else {
        classification = "matched";
        reason = "parity_match";
      }

      diffRows.push({
        composite_key: key,
        classification,
        reason,
        staging_profile_id: s?.profile_id ?? null,
        original_profile_id: o?.profile_id ?? null,
        batch_staging: s ? batchCohort(s.display_label, s.candidate_id) : "none",
        batch_original: o ? batchCohort(o.display_label, o.candidate_id) : "none",
      });
    }

    orphanStaging = await runOrphanChecks(stagingClient, "staging");
    orphanOriginal = await runOrphanChecks(originalClient, "original");

    for (const o of [orphanStaging, orphanOriginal]) {
      const iss = o.issues as string[] | undefined;
      if (iss?.length) blockers.push(...iss.map((i) => `${o.env}: ${i}`));
    }

    await stagingClient.end();
    await originalClient.end();
  }

  const counts = {
    staging_total: stagingGov.size,
    original_total: originalGov.size,
    matched: diffRows.filter((d) => d.classification === "matched").length,
    staging_only: diffRows.filter((d) => d.classification === "staging_only").length,
    original_only: diffRows.filter((d) => d.classification === "original_only").length,
    conflicts: diffRows.filter((d) => d.classification === "conflict").length,
    unsafe: diffRows.filter((d) => d.classification === "unsafe").length,
  };
  const drift = counts.staging_only + counts.original_only + counts.conflicts + counts.unsafe;

  function batchSummary(env: Map<string, GovernedRow>) {
    const pilot = [...env.values()].filter((r) => cohortOf(r) === "pilot").length;
    const wave1 = [...env.values()].filter((r) => cohortOf(r) === "wave1").length;
    const wave2 = [...env.values()].filter((r) => cohortOf(r) === "wave2").length;
    const other = [...env.values()].filter((r) => cohortOf(r) === "other").length;
    return { pilot, wave1, wave2, other, total: env.size };
  }

  const batchParity = {
    staging: batchSummary(stagingGov),
    original: batchSummary(originalGov),
    expected: { pilot: 191, wave1: 50, wave2: 200, total: EXPECTED_TOTAL },
  };

  if (batchParity.staging.wave1 !== 50) blockers.push(`Staging wave1 batch count ${batchParity.staging.wave1}, expected 50`);
  if (batchParity.staging.wave2 !== 200) blockers.push(`Staging wave2 batch count ${batchParity.staging.wave2}, expected 200`);
  if (batchParity.original.wave1 !== 50) blockers.push(`Original wave1 batch count ${batchParity.original.wave1}, expected 50`);
  if (batchParity.original.wave2 !== 200) blockers.push(`Original wave2 batch count ${batchParity.original.wave2}, expected 200`);

  const parityPass =
    drift === 0 &&
    counts.matched === EXPECTED_TOTAL &&
    counts.staging_total === EXPECTED_TOTAL &&
    counts.original_total === EXPECTED_TOTAL &&
    blockers.length === 0;

  fs.writeFileSync(
    path.join(outDir, "full-packaging-parity-census.md"),
    [
      "# Full packaging parity census",
      "",
      `**Run:** \`${runId}\``,
      `**Branch:** \`${branch}\``,
      `**Staging:** \`${STAGING_REF}\` | **Original:** \`${ORIGINAL_REF}\``,
      "",
      "## Totals",
      "",
      "| Metric | Staging | Original | Expected |",
      "|--------|--------:|---------:|---------:|",
      `| Governed current snapshots | ${counts.staging_total} | ${counts.original_total} | ${EXPECTED_TOTAL} |`,
      `| Matched | ${counts.matched} | — | ${EXPECTED_TOTAL} |`,
      `| Staging-only | ${counts.staging_only} | — | 0 |`,
      `| Original-only | ${counts.original_only} | — | 0 |`,
      `| Conflicts | ${counts.conflicts} | — | 0 |`,
      `| Unsafe | ${counts.unsafe} | — | 0 |`,
      `| **Drift** | **${drift}** | — | **0** |`,
      "",
      `**Overall:** ${parityPass ? "**PASS**" : "**FAIL**"}`,
      "",
      "## Batch cohorts (by display_label / candidate_id)",
      "",
      "| Cohort | Staging | Original | Expected |",
      "|--------|--------:|---------:|---------:|",
      `| Pilot | ${batchParity.staging.pilot} | ${batchParity.original.pilot} | 191 |`,
      `| Wave 1 (\`${WAVE1_TAG}\`) | ${batchParity.staging.wave1} | ${batchParity.original.wave1} | 50 |`,
      `| Wave 2 (\`${WAVE2_TAG}\`) | ${batchParity.staging.wave2} | ${batchParity.original.wave2} | 200 |`,
      `| Other | ${batchParity.staging.other} | ${batchParity.original.other} | 0 |`,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "staging-vs-original-full-packaging-diff.json"),
    JSON.stringify(
      {
        run_id: runId,
        dry_run_id: DRY_RUN_ID,
        counts,
        drift,
        parity_pass: parityPass,
        rows: diffRows,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(path.join(outDir, "batch-parity-summary.json"), JSON.stringify(batchParity, null, 2));

  fs.writeFileSync(
    path.join(outDir, "orphan-checks.md"),
    [
      "# Orphan and integrity checks",
      "",
      "## Staging",
      "",
      "```json",
      JSON.stringify(orphanStaging, null, 2),
      "```",
      "",
      "## Original",
      "",
      "```json",
      JSON.stringify(orphanOriginal, null, 2),
      "```",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "no-write-proof.md"),
    [
      "# No-write proof",
      "",
      "- Read-only SELECT on staging and original",
      "- Script: `scripts/pc05-packaging-full-parity-verify.ts`",
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
        prompt: "PC05-PACKAGING-FULL-PARITY-VERIFY — STAGING VS ORIGINAL TOTAL CENSUS",
        run_id: runId,
        branch,
        counts,
        drift,
        batch_parity: batchParity,
        blocker_count: blockers.length,
        parity_pass: parityPass,
        ok: parityPass,
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
        counts,
        drift,
        blocker_count: blockers.length,
        blockers,
      },
      null,
      2,
    ),
  );
  process.exit(parityPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
