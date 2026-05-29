/**
 * Spreadsheet packaging import — staging execute (approval-gated).
 *
 *   npx tsx scripts/spreadsheet-packaging-import-staging-execute.ts
 *   npx tsx scripts/spreadsheet-packaging-import-staging-execute.ts --apply
 *   npx tsx scripts/spreadsheet-packaging-import-staging-execute.ts --apply --plan-run-id=20260528T010000Z
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
const PLAN_RUN_DEFAULT = "20260528T010000Z";
const PLAN_BASE = ".cursor/audit-reports/spreadsheet-governed-import-plan";
const APPROVAL_PATH = ".cursor/operator-approvals/spreadsheet-packaging-import-staging-approval.md";
const OUT_BASE = ".cursor/audit-reports/spreadsheet-packaging-import-staging-execute";
const EXPECTED_PLAN_ROWS = 80;
const EXPECTED_DIMENSIONS_CURRENT = 491;

type InsertPlanRow = {
  candidate_id: string;
  spreadsheet_row: number;
  organization_id: string;
  store_id: string;
  product_id: string;
  seller_sku: string;
  packaging_level: string;
  fulfillment_context: string;
  length_value: number;
  width_value: number;
  height_value: number;
  dimension_unit: string;
  weight_value: number | null;
  weight_unit: string | null;
  units_per_case: number | null;
  units_per_inner_pack: number | null;
  source_type: string;
  source_reference: string;
  profile_status: string;
  display_label: string;
  confidence_score: number;
  evidence_summary: Record<string, unknown>;
  recommended_action: string;
  blockers: string[];
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function planRunArg(): string {
  const a = process.argv.find((x) => x.startsWith("--plan-run-id="));
  return a ? a.split("=")[1]!.trim() : PLAN_RUN_DEFAULT;
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

function readApproval(): { valid: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runM = text.match(/APPROVED_TO_RUN_STAGING\s*=\s*(\S+)/);
  const execM = text.match(/APPROVED_SPREADSHEET_PACKAGING_IMPORT\s*=\s*(\S+)/);
  const runVal = runM?.[1] ?? "";
  const execVal = execM?.[1] ?? "";
  return {
    valid: runVal === "true" && execVal === "true",
    raw: {
      APPROVED_TO_RUN_STAGING: runVal,
      APPROVED_SPREADSHEET_PACKAGING_IMPORT: execVal,
    },
  };
}

async function runSmoke(
  client: pg.Client,
  batchTag: string,
  expectedBatchRows: number,
): Promise<{ pass: boolean; checks: string[]; failures: string[] }> {
  const checks: string[] = [];
  const failures: string[] = [];

  const cur = await client.query(`SELECT count(*)::int c FROM public.product_packaging_dimensions_current`);
  const curCount = Number(cur.rows[0]?.c ?? -1);
  checks.push(`dimensions_current=${curCount} (expect ${EXPECTED_DIMENSIONS_CURRENT})`);
  if (curCount !== EXPECTED_DIMENSIONS_CURRENT) {
    failures.push(`dimensions_current changed: ${curCount} !== ${EXPECTED_DIMENSIONS_CURRENT}`);
  }

  const batch = await client.query(
    `SELECT p.id::text AS profile_id, v.id::text AS version_id, v.profile_status, v.source_type,
            v.dimension_unit, v.weight_unit, v.length_value, v.width_value, v.height_value,
            c.profile_id AS current_profile_id
     FROM public.product_packaging_profiles p
     JOIN public.product_packaging_profile_versions v ON v.profile_id = p.id
     LEFT JOIN public.product_packaging_dimensions_current c ON c.profile_id = p.id
     WHERE p.display_label = $1`,
    [batchTag],
  );

  checks.push(`batch_rows=${batch.rowCount ?? 0} (expect ${expectedBatchRows})`);
  if ((batch.rowCount ?? 0) !== expectedBatchRows) {
    failures.push(`batch row count ${batch.rowCount} !== expected ${expectedBatchRows}`);
  }

  for (const row of batch.rows as Record<string, unknown>[]) {
    if (String(row.profile_status) !== "needs_review") {
      failures.push(`profile ${row.profile_id}: status=${row.profile_status}`);
    }
    if (String(row.source_type) !== "import") {
      failures.push(`profile ${row.profile_id}: source_type=${row.source_type}`);
    }
    if (String(row.dimension_unit) !== "in") {
      failures.push(`profile ${row.profile_id}: dimension_unit=${row.dimension_unit}`);
    }
    if (row.current_profile_id != null) {
      failures.push(`profile ${row.profile_id}: unexpected dimensions_current snapshot`);
    }
    const wu = row.weight_unit;
    if (wu != null && String(wu) !== "lb") {
      failures.push(`profile ${row.profile_id}: weight_unit=${wu}`);
    }
  }

  checks.push("all batch versions needs_review + import + in + no current snapshot");
  return { pass: failures.length === 0, checks, failures };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const planRunId = planRunArg();
  const apply = process.argv.includes("--apply");
  const planDir = path.join(process.cwd(), PLAN_BASE, planRunId);
  const planPath = path.join(planDir, "packaging-insert-plan.json");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = dbUrl ? refFromSupabaseUrl(dbUrl) || getStagingProjectRef({ loadEnv: false }) : STAGING_REF;

  const approval = readApproval();
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (!approval.valid) blockers.push("Approval flags not both true");
  if (!fs.existsSync(planPath)) blockers.push(`Missing ${planPath}`);
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else {
    if (ref !== STAGING_REF) blockers.push(`Target must be staging ${STAGING_REF}`);
    if (originalUrl && dbUrl === originalUrl) blockers.push("Must not use original URL as staging");
    const origRef = refFromSupabaseUrl(originalUrl);
    if (origRef === ORIGINAL_REF && dbUrl.includes(ORIGINAL_REF)) {
      blockers.push("DB URL targets original project");
    }
  }

  let planRows: InsertPlanRow[] = [];
  if (fs.existsSync(planPath)) {
    planRows = JSON.parse(fs.readFileSync(planPath, "utf8")) as InsertPlanRow[];
    if (planRows.length !== EXPECTED_PLAN_ROWS) {
      blockers.push(`Plan row count ${planRows.length}, expected ${EXPECTED_PLAN_ROWS}`);
    }
    const badUnit = planRows.filter((r) => r.dimension_unit !== "in");
    if (badUnit.length) blockers.push(`${badUnit.length} rows with dimension_unit !== in`);
    const badStatus = planRows.filter((r) => r.profile_status !== "needs_review");
    if (badStatus.length) blockers.push(`${badStatus.length} rows with profile_status !== needs_review`);
  }

  const batchTag =
    planRows[0]?.display_label ??
    planRows[0]?.evidence_summary?.batch_tag?.toString() ??
    `SPREADSHEET_DIMENSIONS_${planRunId}`;

  fs.copyFileSync(planPath, path.join(outDir, "packaging-insert-plan.json"));

  let insertedProfiles = 0;
  let insertedVersions = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};
  const insertErrors: string[] = [];
  const insertedIds: { candidate_id: string; profile_id: string; version_id: string }[] = [];
  let beforeSnap = { profiles: 0, versions: 0, dimensions_current: 0 };
  let afterSnap = { profiles: 0, versions: 0, dimensions_current: 0 };
  let smoke = { pass: false, checks: [] as string[], failures: [] as string[] };

  if (apply && blockers.length === 0) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    const snapBefore = await client.query(
      `SELECT
         (SELECT count(*)::int FROM public.product_packaging_profiles) AS profiles,
         (SELECT count(*)::int FROM public.product_packaging_profile_versions) AS versions,
         (SELECT count(*)::int FROM public.product_packaging_dimensions_current) AS dimensions_current`,
    );
    beforeSnap = snapBefore.rows[0] as typeof beforeSnap;

    const existing = new Set<string>();
    const ex = await client.query(
      `SELECT organization_id::text, store_id::text, product_id::text, packaging_level, fulfillment_context
       FROM public.product_packaging_profiles`,
    );
    for (const r of ex.rows as Record<string, string | null>[]) {
      existing.add(
        profileKey(
          String(r.organization_id),
          r.store_id ? String(r.store_id) : null,
          String(r.product_id),
          String(r.packaging_level),
          String(r.fulfillment_context),
        ),
      );
    }

    for (const row of planRows) {
      if (row.blockers?.length) {
        skipped++;
        skipReasons.plan_blockers = (skipReasons.plan_blockers ?? 0) + 1;
        continue;
      }

      const key = profileKey(
        row.organization_id,
        row.store_id,
        row.product_id,
        row.packaging_level,
        row.fulfillment_context,
      );
      if (existing.has(key)) {
        skipped++;
        skipReasons.profile_exists = (skipReasons.profile_exists ?? 0) + 1;
        continue;
      }

      const evidence = {
        ...row.evidence_summary,
        spreadsheet_execute_run_id: runId,
        spreadsheet_candidate_id: row.candidate_id,
        spreadsheet_plan_run_id: planRunId,
      };

      await client.query("BEGIN");
      try {
        const prof = await client.query(
          `INSERT INTO public.product_packaging_profiles (
             organization_id, store_id, product_id, packaging_level, fulfillment_context, display_label
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)
           RETURNING id`,
          [
            row.organization_id,
            row.store_id,
            row.product_id,
            row.packaging_level,
            row.fulfillment_context,
            batchTag,
          ],
        );
        const profileId = String(prof.rows[0].id);

        const ver = await client.query(
          `INSERT INTO public.product_packaging_profile_versions (
             profile_id, version_number, length_value, width_value, height_value, dimension_unit,
             weight_value, weight_unit, units_per_inner_pack, units_per_case,
             source_type, source_reference, confidence_score, profile_status, evidence_summary
           ) VALUES (
             $1::uuid, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb
           ) RETURNING id`,
          [
            profileId,
            row.length_value,
            row.width_value,
            row.height_value,
            row.dimension_unit,
            row.weight_value,
            row.weight_unit,
            row.units_per_inner_pack,
            row.units_per_case,
            row.source_type,
            row.source_reference,
            row.confidence_score,
            row.profile_status,
            JSON.stringify(evidence),
          ],
        );
        const versionId = String(ver.rows[0].id);
        await client.query("COMMIT");

        existing.add(key);
        insertedProfiles++;
        insertedVersions++;
        insertedIds.push({ candidate_id: row.candidate_id, profile_id: profileId, version_id: versionId });
      } catch (e) {
        await client.query("ROLLBACK");
        skipped++;
        skipReasons.insert_error = (skipReasons.insert_error ?? 0) + 1;
        insertErrors.push(`${row.candidate_id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const snapAfter = await client.query(
      `SELECT
         (SELECT count(*)::int FROM public.product_packaging_profiles) AS profiles,
         (SELECT count(*)::int FROM public.product_packaging_profile_versions) AS versions,
         (SELECT count(*)::int FROM public.product_packaging_dimensions_current) AS dimensions_current`,
    );
    afterSnap = snapAfter.rows[0] as typeof afterSnap;

    const allSkippedExisting =
      skipped === planRows.length &&
      (skipReasons.profile_exists ?? 0) === skipped &&
      insertErrors.length === 0;
    if (insertedProfiles > 0 || allSkippedExisting) {
      smoke = await runSmoke(client, batchTag, EXPECTED_PLAN_ROWS);
      if (allSkippedExisting && insertedProfiles === 0) {
        smoke.checks.push(`idempotent: batch ${batchTag} already present`);
      }
    }

    await client.end();
  }

  const idempotentComplete =
    apply &&
    planRows.length > 0 &&
    skipped === planRows.length &&
    (skipReasons.profile_exists ?? 0) === skipped &&
    insertErrors.length === 0;

  const ok =
    apply &&
    blockers.length === 0 &&
    insertErrors.length === 0 &&
    insertedProfiles === insertedVersions &&
    (insertedProfiles === EXPECTED_PLAN_ROWS || idempotentComplete) &&
    afterSnap.dimensions_current === EXPECTED_DIMENSIONS_CURRENT &&
    smoke.pass;

  fs.writeFileSync(path.join(outDir, "insert-summary.json"), JSON.stringify({ insertedIds, skipped, skipReasons }, null, 2));

  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      "-- Spreadsheet packaging import rollback — delete batch by display_label",
      `-- Execute run: ${runId}`,
      `-- Plan run: ${planRunId}`,
      `-- Tag: ${batchTag}`,
      "",
      "BEGIN;",
      `-- Expect ${insertedIds.length || EXPECTED_PLAN_ROWS} profiles; versions cascade via FK`,
      `DELETE FROM public.product_packaging_profiles WHERE display_label = '${batchTag.replace(/'/g, "''")}';`,
      "COMMIT;",
      "",
      `-- Verify: dimensions_current should remain ${EXPECTED_DIMENSIONS_CURRENT}`,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "smoke-result.md"),
    [
      "# Smoke validation",
      "",
      `Result: **${smoke.pass ? "PASS" : apply ? "FAIL" : "SKIPPED"}**`,
      "",
      "## Checks",
      "",
      ...smoke.checks.map((c) => `- ${c}`),
      "",
      smoke.failures.length ? "## Failures\n\n" + smoke.failures.map((f) => `- ${f}`).join("\n") : "## Failures\n\nNone.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "execute-result.md"),
    [
      "# Spreadsheet packaging import — execute result",
      "",
      `Run: \`${runId}\``,
      `Plan: \`${planRunId}\``,
      `Batch tag: \`${batchTag}\``,
      `Apply: **${apply ? "YES" : "NO"}**`,
      "",
      "| Metric | Value |",
      "|--------|------:|",
      `| Plan rows | ${planRows.length} |`,
      `| Profiles inserted | ${insertedProfiles} |`,
      `| Versions inserted | ${insertedVersions} |`,
      `| Skipped | ${skipped} |`,
      `| dimensions_current before | ${beforeSnap.dimensions_current} |`,
      `| dimensions_current after | ${afterSnap.dimensions_current} |`,
      `| Smoke | ${smoke.pass ? "PASS" : "FAIL/SKIP"} |`,
      idempotentComplete ? "| Idempotent | YES |" : "",
      "",
      "Skip reasons:",
      "",
      "```json",
      JSON.stringify(skipReasons, null, 2),
      "```",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      `File: \`${APPROVAL_PATH}\``,
      "",
      "```text",
      `APPROVED_TO_RUN_STAGING=${approval.raw.APPROVED_TO_RUN_STAGING}`,
      `APPROVED_SPREADSHEET_PACKAGING_IMPORT=${approval.raw.APPROVED_SPREADSHEET_PACKAGING_IMPORT}`,
      "```",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      ...(blockers.length ? blockers.map((b) => `- ${b}`) : ["None."]),
      ...(insertErrors.length ? ["", "## Insert errors", ...insertErrors.map((e) => `- ${e}`)] : []),
      ...(smoke.failures.length ? ["", "## Smoke failures", ...smoke.failures.map((f) => `- ${f}`)] : []),
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "SPREADSHEET PACKAGING IMPORT STAGING EXECUTE",
        run_id: runId,
        plan_run_id: planRunId,
        batch_tag: batchTag,
        branch,
        staging_ref: STAGING_REF,
        approval_valid: approval.valid,
        applied: apply && (insertedProfiles > 0 || idempotentComplete),
        ok,
        smoke_pass: smoke.pass,
        plan_rows: planRows.length,
        inserted_profiles: insertedProfiles,
        inserted_versions: insertedVersions,
        skipped,
        dimensions_current_before: beforeSnap.dimensions_current,
        dimensions_current_after: afterSnap.dimensions_current,
        idempotent_complete: idempotentComplete,
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
        apply,
        inserted_profiles: insertedProfiles,
        inserted_versions: insertedVersions,
        dimensions_current: afterSnap.dimensions_current,
        smoke_pass: smoke.pass,
        batch_tag: batchTag,
      },
      null,
      2,
    ),
  );

  if (apply && !ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
