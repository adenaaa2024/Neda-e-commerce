/**
 * EXPECTED-PACKAGES-AMAZON-API-EVIDENCE-DRY-RUN-V199
 *
 * Read-only preflight for V199 API evidence cohort (no Amazon API calls, no DB writes).
 *
 *   npx tsx scripts/expected-packages-amazon-api-evidence-dry-run-v199.ts --run-id=<id> --v199-run-id=20260519T230000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/expected-packages-amazon-api-evidence-dry-run-v199";
const API_APPROVAL = ".cursor/operator-approvals/expected-packages-amazon-api-enrichment-v194-approval.md";
const V199_BASE = ".cursor/audit-reports/v199-expected-identifier-ambiguous-review-pack";

type CohortRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string;
  asin: string;
  fnsku?: string | null;
  sku?: string | null;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function v199RunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--v199-run-id="));
  return a ? a.split("=")[1]!.trim() : "20260519T230000Z";
}

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function readApiApproval(): { approved: boolean; detail: string } {
  const p = path.join(process.cwd(), API_APPROVAL);
  if (!fs.existsSync(p)) return { approved: false, detail: "approval_file_missing" };
  const text = fs.readFileSync(p, "utf8");
  const run = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const api = /APPROVED_EXPECTED_PACKAGES_AMAZON_API_ENRICHMENT_V194\s*=\s*true/i.test(text);
  if (run && api) return { approved: true, detail: "operator_approval_true" };
  if (run && !api) return { approved: false, detail: "api_flag_not_true" };
  return { approved: false, detail: "not_approved" };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const v199RunId = v199RunIdArg();
  const cohortPath = path.join(process.cwd(), V199_BASE, v199RunId, "api-evidence-cohort.json");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  if (!fs.existsSync(cohortPath)) {
    throw new Error(`Missing ${cohortPath}`);
  }
  const cohortFile = JSON.parse(fs.readFileSync(cohortPath, "utf8")) as {
    rows: CohortRow[];
    count: number;
  };
  const cohort = cohortFile.rows ?? [];

  const approval = readApiApproval();
  const spApiEnabled = envFlag("AMAZON_SP_API_ENABLED");
  const autoCreateEnabled = envFlag("PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED");
  const stagingUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const stagingOk = supabaseUrlMatchesStagingRef(stagingUrl, STAGING_REF);

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (!dbUrl || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error("Staging ref guard failed");
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`SET statement_timeout = '120s'`);

  const distinctAsins = [...new Set(cohort.map((r) => r.asin.trim().toUpperCase()))];
  const productsByAsin = await client.query(
    `
    SELECT id::text, organization_id::text, store_id::text, asin, product_name
    FROM public.products
    WHERE organization_id = $1::uuid
      AND store_id = $2::uuid
      AND UPPER(TRIM(asin)) = ANY($3::text[])
      AND (deleted_at IS NULL)
      AND (merge_status IS NULL OR merge_status <> 'merged')
  `,
    [
      cohort[0]?.organization_id ?? "00000000-0000-0000-0000-000000000001",
      cohort[0]?.store_id ?? "509ee1f6-622c-46a5-8110-7b889ba46c2c",
      distinctAsins,
    ],
  );
  const productByAsin = new Map<string, Record<string, unknown>[]>();
  for (const p of productsByAsin.rows as Record<string, unknown>[]) {
    const a = String(p.asin ?? "").trim().toUpperCase();
    const list = productByAsin.get(a) ?? [];
    list.push(p);
    productByAsin.set(a, list);
  }

  const lineResults = [];
  for (const row of cohort) {
    const asin = row.asin.trim().toUpperCase();
    const existing = productByAsin.get(asin) ?? [];
    const mapCheck = await client.query(
      `
      SELECT COUNT(DISTINCT product_id)::int AS c
      FROM public.product_identifier_map
      WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
        AND UPPER(TRIM(asin)) = $3
    `,
      [row.organization_id, row.store_id, asin],
    );
    const mapCount = Number(mapCheck.rows[0]?.c ?? 0);

    let would_execute: "NO_EXECUTE" | "WOULD_CALL_API" | "SKIP_ALREADY_LINKED" = "NO_EXECUTE";
    let reason = "";

    if (!approval.approved) {
      reason = `blocked:${approval.detail}`;
    } else if (!stagingOk) {
      reason = "blocked_non_staging";
    } else if (!spApiEnabled) {
      reason = "amazon_sp_api_disabled";
    } else if (!autoCreateEnabled) {
      reason = "product_enrichment_auto_create_disabled";
    } else if (existing.length === 1 && mapCount >= 1) {
      would_execute = "SKIP_ALREADY_LINKED";
      reason = "product_and_map_already_present";
    } else if (existing.length > 1) {
      would_execute = "NO_EXECUTE";
      reason = "ambiguous_multiple_products_for_asin";
    } else {
      would_execute = "WOULD_CALL_API";
      reason = "governed_catalog_items_lookup_then_optional_product_create_per_e2_gates";
    }

    lineResults.push({
      expected_package_id: row.expected_package_id,
      asin,
      fnsku: row.fnsku ?? null,
      sku: row.sku ?? null,
      existing_product_count: existing.length,
      existing_product_ids: existing.map((p) => p.id),
      map_rows_for_asin: mapCount,
      would_execute,
      reason,
      amazon_api_called_in_dry_run: false,
    });
  }

  await client.end();

  const wouldCall = lineResults.filter((r) => r.would_execute === "WOULD_CALL_API").length;
  const skipLinked = lineResults.filter((r) => r.would_execute === "SKIP_ALREADY_LINKED").length;
  const blocked = lineResults.filter((r) => r.would_execute === "NO_EXECUTE").length;

  const gatesPass = approval.approved && stagingOk && spApiEnabled && autoCreateEnabled;
  const status = gatesPass && wouldCall > 0 ? "READY_FOR_EXECUTE_REVIEW" : gatesPass ? "PASS_NO_API_NEEDED" : "BLOCKED";

  fs.writeFileSync(path.join(outDir, "dry-run-lines.json"), JSON.stringify(lineResults, null, 2));
  fs.writeFileSync(
    path.join(outDir, "dry-run-summary.md"),
    [
      "# Amazon API evidence dry-run (V199)",
      "",
      `**Run id:** \`${runId}\``,
      `**V199 pack:** \`${v199RunId}\``,
      `**Cohort rows:** ${cohort.length}`,
      "",
      "## Gates (no API called)",
      "",
      "| Gate | Value |",
      "|------|-------|",
      `| Operator approval | ${approval.approved} (${approval.detail}) |`,
      `| Staging URL | ${stagingOk} |`,
      `| AMAZON_SP_API_ENABLED | ${spApiEnabled} |`,
      `| PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED | ${autoCreateEnabled} |`,
      "",
      "## Outcomes",
      "",
      `| would_execute | Count |`,
      `|---------------|------:|`,
      `| WOULD_CALL_API | ${wouldCall} |`,
      `| SKIP_ALREADY_LINKED | ${skipLinked} |`,
      `| NO_EXECUTE | ${blocked} |`,
      "",
      "**Status:** " + status,
      "",
      "Execute prompt (only if gates pass and operator wants live API):",
      "`EXPECTED-PACKAGES-AMAZON-API-EVIDENCE-EXECUTE` — not run in this dry-run.",
    ].join("\n") + "\n",
  );

  const manifest = {
    prompt: "EXPECTED-PACKAGES-AMAZON-API-EVIDENCE-DRY-RUN-V199",
    run_id: runId,
    v199_run_id: v199RunId,
    staging_ref: STAGING_REF,
    status,
    cohort_count: cohort.length,
    distinct_asins: distinctAsins.length,
    approval,
    env_gates: { spApiEnabled, autoCreateEnabled, stagingOk },
    outcomes: { wouldCall, skipLinked, blocked },
    amazon_api_called: false,
    db_writes: false,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const manualPath = path.join(process.cwd(), V199_BASE, v199RunId, "manual-review-queue.csv");
  const manualNote = [
    "# Manual review (not executed)",
    "",
    "Per operator prompt, these cohorts remain manual-only:",
    "",
    "- **6** `source_data_inconsistency` — see `ambiguous-candidates.md`",
    "- **38** `identifier_manual_review` — see `manual-review-queue.csv`",
    "",
    `Queue file: \`${manualPath}\``,
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(outDir, "manual-review-pointer.md"), manualNote);

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
