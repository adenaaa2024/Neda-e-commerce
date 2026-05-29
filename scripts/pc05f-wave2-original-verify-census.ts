/**
 * PC05F-ORIGINAL-VERIFY — Wave 2 packaging original parity census (read-only).
 *
 *   npx tsx scripts/pc05f-wave2-original-verify-census.ts
 *   npx tsx scripts/pc05f-wave2-original-verify-census.ts --execute-run-id=20260526T211000Z
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
const WAVE2_EXECUTE_RUN = "20260526T202000Z";
const WAVE2_ACTIVATE_RUN = "20260526T204000Z";
const PC05F_EXECUTE_DEFAULT = "20260526T211000Z";
const BATCH_TAG = `PC05D_WAVE2_${WAVE2_EXECUTE_RUN}`;
const OUT_BASE = ".cursor/audit-reports/pc05f-wave2-original-verify";
const EXPECTED_WAVE2 = 200;
const EXPECTED_ORIGINAL_CURRENT = 441;

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

function executeRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--execute-run-id="));
  return a ? a.split("=")[1]!.trim() : PC05F_EXECUTE_DEFAULT;
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

async function fetchWave2ActivatedStaging(client: pg.Client): Promise<Map<string, PackagingRow>> {
  const r = await client.query(
    `SELECT
       v.evidence_summary->>'pc05_candidate_id' AS candidate_id,
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
       AND v.effective_to IS NULL
       AND c.current_version_id = v.id`,
    [BATCH_TAG],
  );
  const out = new Map<string, PackagingRow>();
  for (const row of r.rows as Record<string, unknown>[]) {
    const cid = String(row.candidate_id ?? "");
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
       v.evidence_summary->>'pc05_candidate_id' AS candidate_id,
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
     WHERE v.profile_status = 'active' AND v.effective_to IS NULL`,
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
      candidate_id: row.candidate_id ? String(row.candidate_id) : "",
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
  const executeRunId = executeRunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const stagingRef = refFromConnectionUrl(stagingUrl) || getStagingProjectRef({ loadEnv: false });
  const originalRef = refFromConnectionUrl(originalUrl);

  const executeManifestPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/pc05f-wave2-original-parity-execute",
    executeRunId,
    "manifest.json",
  );
  const activateManifestPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/pc05d-wave2-activate-staging",
    WAVE2_ACTIVATE_RUN,
    "manifest.json",
  );

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (stagingRef !== STAGING_REF) blockers.push(`Staging ref must be ${STAGING_REF}`);
  if (originalRef !== ORIGINAL_REF) blockers.push(`Original ref must be ${ORIGINAL_REF}`);
  if (!stagingUrl || !originalUrl) blockers.push("Missing postgres URLs");
  if (stagingUrl === originalUrl) blockers.push("URLs must differ");

  if (!fs.existsSync(executeManifestPath)) {
    blockers.push(`Missing PC05F execute proof: ${executeRunId}`);
  } else {
    try {
      const em = JSON.parse(fs.readFileSync(executeManifestPath, "utf8")) as {
        ok?: boolean;
        inserted_profiles?: number;
        initial_inserted_profiles?: number;
        dimensions_current_count?: number;
      };
      const inserted = em.initial_inserted_profiles ?? em.inserted_profiles ?? 0;
      if (!em.ok || inserted < EXPECTED_WAVE2) {
        if ((em.dimensions_current_count ?? 0) < EXPECTED_ORIGINAL_CURRENT) {
          blockers.push(`PC05F execute not ok or <${EXPECTED_WAVE2} inserts`);
        }
      }
    } catch {
      blockers.push("Invalid PC05F execute manifest");
    }
  }

  if (fs.existsSync(activateManifestPath)) {
    try {
      const am = JSON.parse(fs.readFileSync(activateManifestPath, "utf8")) as { ok?: boolean; activated_count?: number };
      if (!am.ok || (am.activated_count ?? 0) < EXPECTED_WAVE2) blockers.push("Wave2 activate manifest not ok");
    } catch {
      blockers.push("Invalid activate manifest");
    }
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

  let stagingWave2 = new Map<string, PackagingRow>();
  let originalCounts = { profiles: 0, versions: 0, current: 0 };

  if (blockers.length === 0) {
    const stagingClient = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    const originalClient = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await stagingClient.connect();
    await originalClient.connect();

    stagingWave2 = await fetchWave2ActivatedStaging(stagingClient);
    if (stagingWave2.size !== EXPECTED_WAVE2) {
      blockers.push(`Expected ${EXPECTED_WAVE2} activated Wave2 rows on staging, got ${stagingWave2.size}`);
    }

    const originalByKey = await fetchOriginalByKey(originalClient);
    const oc = await originalClient.query(
      `SELECT
         (SELECT count(*)::int FROM public.product_packaging_profiles) AS profiles,
         (SELECT count(*)::int FROM public.product_packaging_profile_versions) AS versions,
         (SELECT count(*)::int FROM public.product_packaging_dimensions_current) AS current`,
    );
    originalCounts = oc.rows[0] as typeof originalCounts;

    for (const staging of stagingWave2.values()) {
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

      if (!orig) {
        classification = "missing";
        reason = "no_matching_active_profile_on_original";
      } else if (!dimsMatch(staging, orig) || staging.profile_status !== orig.profile_status) {
        classification = "conflict";
        reason = !dimsMatch(staging, orig) ? "dimension_or_unit_mismatch" : "status_mismatch";
      } else if (!staging.has_current || !orig.has_current) {
        classification = "missing";
        reason = "missing_current_snapshot";
      } else if (orig.candidate_id && orig.candidate_id !== staging.candidate_id) {
        classification = "conflict";
        reason = "candidate_id_mismatch_on_original";
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
    staging_active_wave2: stagingWave2.size,
    original_matched: diffRows.filter((d) => d.classification === "matched").length,
    missing_on_original: diffRows.filter((d) => d.classification === "missing").length,
    conflicts: diffRows.filter((d) => d.classification === "conflict").length,
    unsafe: diffRows.filter((d) => d.classification === "unsafe").length,
    original_dimensions_current: originalCounts.current,
  };

  const parityPass =
    counts.staging_active_wave2 === EXPECTED_WAVE2 &&
    counts.original_matched === EXPECTED_WAVE2 &&
    counts.missing_on_original === 0 &&
    counts.conflicts === 0 &&
    counts.unsafe === 0 &&
    counts.original_dimensions_current === EXPECTED_ORIGINAL_CURRENT;

  const conflicts = diffRows.filter((d) => d.classification === "conflict");
  const missing = diffRows.filter((d) => d.classification === "missing");

  fs.writeFileSync(
    path.join(outDir, "wave2-parity-census.md"),
    [
      "# Wave 2 parity census — PC05F-ORIGINAL-VERIFY",
      "",
      `**Run id:** \`${runId}\``,
      `**Branch:** \`${branch}\``,
      `**Staging:** \`${STAGING_REF}\` | **Original:** \`${ORIGINAL_REF}\``,
      `**Wave 1 batch:** \`${BATCH_TAG}\``,
      `**PC05E execute proof:** \`${executeRunId}\``,
      "",
      "## Verification matrix",
      "",
      "| Check | Expected | Actual | Pass |",
      "|-------|----------|--------|------|",
      `| staging_active_wave2 | ${EXPECTED_WAVE2} | ${counts.staging_active_wave2} | ${counts.staging_active_wave2 === EXPECTED_WAVE2 ? "YES" : "NO"} |`,
      `| original_matched | ${EXPECTED_WAVE2} | ${counts.original_matched} | ${counts.original_matched === EXPECTED_WAVE2 ? "YES" : "NO"} |`,
      `| missing_on_original | 0 | ${counts.missing_on_original} | ${counts.missing_on_original === 0 ? "YES" : "NO"} |`,
      `| conflicts | 0 | ${counts.conflicts} | ${counts.conflicts === 0 ? "YES" : "NO"} |`,
      `| unsafe | 0 | ${counts.unsafe} | ${counts.unsafe === 0 ? "YES" : "NO"} |`,
      `| original_dimensions_current | ${EXPECTED_ORIGINAL_CURRENT} | ${counts.original_dimensions_current} | ${counts.original_dimensions_current === EXPECTED_ORIGINAL_CURRENT ? "YES" : "NO"} |`,
      "",
      `**Overall parity:** ${parityPass ? "**PASS**" : "**FAIL**"}`,
      "",
      "## Original table totals",
      "",
      `| Table | Rows |`,
      `|-------|-----:|`,
      `| product_packaging_profiles | ${originalCounts.profiles} |`,
      `| product_packaging_profile_versions | ${originalCounts.versions} |`,
      `| product_packaging_dimensions_current | ${originalCounts.current} |`,
      "",
      "Pilot 191 + Wave 1 50 + Wave 2 200 = **441** on `dimensions_current` (not 641; prompt arithmetic typo).",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "staging-vs-original-wave2-diff.json"),
    JSON.stringify(
      {
        run_id: runId,
        staging_ref: STAGING_REF,
        original_ref: ORIGINAL_REF,
        wave2_batch_tag: BATCH_TAG,
        pc05f_execute_run: executeRunId,
        wave2_execute_run: WAVE2_EXECUTE_RUN,
        wave2_activate_run: WAVE2_ACTIVATE_RUN,
        original_table_counts: originalCounts,
        counts,
        parity_pass: parityPass,
        rows: diffRows,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "conflict-report.md"),
    [
      "# Conflict report — Wave 2 verify",
      "",
      `Conflicts: **${conflicts.length}**`,
      `Missing: **${missing.length}**`,
      `Unsafe: **${counts.unsafe}**`,
      "",
      conflicts.length
        ? conflicts.map((c) => `- \`${c.candidate_id}\`: ${c.reason}`).join("\n")
        : "No conflicts.",
      "",
      missing.length
        ? missing.map((c) => `- \`${c.candidate_id}\`: ${c.reason}`).join("\n")
        : "No missing rows.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "no-write-proof.md"),
    [
      "# No-write proof",
      "",
      "- Mode: **read-only verify**",
      "- No INSERT/UPDATE/DELETE on staging or original",
      "- No `products` changes",
      "- No Amazon API / no OpenAI",
      `- Script: \`scripts/pc05f-wave2-original-verify-census.ts\``,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      ...(blockers.length ? blockers.map((b) => `- ${b}`) : ["None."]),
      !parityPass && blockers.length === 0 ? "- Parity matrix did not meet 200/200 PASS criteria" : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const ok = blockers.length === 0 && parityPass;
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PC05F-ORIGINAL-VERIFY — WAVE 2 PACKAGING ORIGINAL PARITY CENSUS",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        original_ref: ORIGINAL_REF,
        wave2_batch_tag: BATCH_TAG,
        pc05f_execute_run: executeRunId,
        expected_dimensions_current: EXPECTED_ORIGINAL_CURRENT,
        read_only: true,
        counts,
        parity_pass: parityPass,
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
        counts,
        parity_pass: parityPass,
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
