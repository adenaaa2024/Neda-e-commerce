/**
 * EXPECTED-PACKAGES-AMAZON-API-EVIDENCE-DRY-RUN-V202
 *
 * Read-only preflight for API-evidence cohort (no Amazon API calls, no DB writes).
 * Cohort source: V201 remaining-52 matrix (live classification) with V199 pack cross-check.
 *
 *   npx tsx scripts/expected-packages-amazon-api-evidence-dry-run-v202.ts --run-id=<id>
 *   npx tsx scripts/expected-packages-amazon-api-evidence-dry-run-v202.ts --v201-run-id=20260522T170000Z
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
const OUT_BASE = ".cursor/audit-reports/expected-packages-amazon-api-evidence-dry-run-v202";
const API_APPROVAL = ".cursor/operator-approvals/expected-packages-amazon-api-enrichment-v194-approval.md";
const V201_BASE = ".cursor/audit-reports/expected-packages-remaining-52-review-v201";
const V199_BASE = ".cursor/audit-reports/v199-expected-identifier-ambiguous-review-pack";

type CohortRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string;
  asin: string;
  fnsku?: string | null;
  sku?: string | null;
  classification?: string;
  source_evidence?: string;
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

function v201RunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--v201-run-id="));
  return a ? a.split("=")[1]!.trim() : "20260522T170000Z";
}

function v199RunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--v199-run-id="));
  return a ? a.split("=")[1]!.trim() : "20260522T130000Z";
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

function loadV201ApiCohort(v201RunId: string): CohortRow[] {
  const matrixPath = path.join(process.cwd(), V201_BASE, v201RunId, "remaining-52-matrix.json");
  if (!fs.existsSync(matrixPath)) {
    throw new Error(`Missing V201 matrix: ${matrixPath}`);
  }
  const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8")) as {
    rows: Array<Record<string, unknown>>;
  };
  return (matrix.rows ?? [])
    .filter((r) => r.classification === "api_evidence_needed")
    .map((r) => {
      const asin = String(r.asin ?? r.trusted_sample_asin ?? "").trim().toUpperCase();
      if (!asin) throw new Error(`api_evidence row missing asin: ${r.expected_package_id}`);
      return {
        expected_package_id: String(r.expected_package_id),
        organization_id: String(r.organization_id),
        store_id: String(r.store_id),
        asin,
        fnsku: r.fnsku ? String(r.fnsku) : null,
        sku: r.sku ? String(r.sku) : null,
        classification: "api_evidence_needed",
        source_evidence: r.source_evidence ? String(r.source_evidence) : undefined,
      };
    });
}

function loadV199ApiCohort(v199RunId: string): CohortRow[] {
  const p = path.join(process.cwd(), V199_BASE, v199RunId, "api-evidence-cohort.json");
  if (!fs.existsSync(p)) return [];
  const file = JSON.parse(fs.readFileSync(p, "utf8")) as { rows: CohortRow[] };
  return file.rows ?? [];
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const v201RunId = v201RunIdArg();
  const v199RunId = v199RunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const cohort = loadV201ApiCohort(v201RunId);
  const v199Cohort = loadV199ApiCohort(v199RunId);
  const v199Ids = new Set(v199Cohort.map((r) => r.expected_package_id));
  const v201Ids = new Set(cohort.map((r) => r.expected_package_id));
  const overlap = cohort.filter((r) => v199Ids.has(r.expected_package_id)).length;

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
  const org = cohort[0]?.organization_id ?? "00000000-0000-0000-0000-000000000001";
  const store = cohort[0]?.store_id ?? "509ee1f6-622c-46a5-8110-7b889ba46c2c";

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
    [org, store, distinctAsins],
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
      classification: row.classification,
      source_evidence: row.source_evidence ?? null,
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
  const status =
    cohort.length === 0
      ? "PASS_EMPTY_COHORT"
      : gatesPass && wouldCall > 0
        ? "READY_FOR_EXECUTE_REVIEW"
        : gatesPass
          ? "PASS_NO_API_NEEDED"
          : "BLOCKED";

  fs.writeFileSync(
    path.join(outDir, "api-evidence-cohort.json"),
    JSON.stringify({ count: cohort.length, rows: cohort, source: `v201:${v201RunId}` }, null, 2),
  );
  fs.writeFileSync(path.join(outDir, "dry-run-lines.json"), JSON.stringify(lineResults, null, 2));
  fs.writeFileSync(
    path.join(outDir, "cohort-cross-check.json"),
    JSON.stringify(
      {
        v201_run_id: v201RunId,
        v201_api_count: cohort.length,
        v199_run_id: v199RunId,
        v199_api_count: v199Cohort.length,
        overlap_expected_package_ids: overlap,
        only_in_v201: cohort.filter((r) => !v199Ids.has(r.expected_package_id)).map((r) => r.expected_package_id),
        only_in_v199: v199Cohort.filter((r) => !v201Ids.has(r.expected_package_id)).map((r) => r.expected_package_id),
      },
      null,
      2,
    ),
  );

  const blockers: string[] = [];
  if (!approval.approved) blockers.push(`Operator/API approval: ${approval.detail}`);
  if (!spApiEnabled) blockers.push("Set AMAZON_SP_API_ENABLED=true in server env for execute");
  if (!autoCreateEnabled) blockers.push("Set PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED=true for execute");
  if (cohort.length !== 8) blockers.push(`Cohort count ${cohort.length} (V201 expected 8)`);

  fs.writeFileSync(
    path.join(outDir, "dry-run-summary.md"),
    [
      "# Amazon API evidence dry-run (V202)",
      "",
      `**Run id:** \`${runId}\``,
      `**Cohort source:** V201 \`${v201RunId}\` (\`api_evidence_needed\`)`,
      `**V199 cross-check:** \`${v199RunId}\` — ${v199Cohort.length} rows, ${overlap} id overlap`,
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
      "| would_execute | Count |",
      "|---------------|------:|",
      `| WOULD_CALL_API | ${wouldCall} |`,
      `| SKIP_ALREADY_LINKED | ${skipLinked} |`,
      `| NO_EXECUTE | ${blocked} |`,
      "",
      `**Status:** ${status}`,
      "",
      blockers.length
        ? "## Blockers\n\n" + blockers.map((b) => `- ${b}`).join("\n") + "\n"
        : "## Blockers\n\nNone for dry-run (execute still requires all gates).\n",
      "",
      "Execute prompt (only if all gates pass and operator wants live SP-API):",
      "`EXPECTED-PACKAGES-AMAZON-API-EVIDENCE-EXECUTE-V202`",
      "",
      "Manual cohorts (not in this dry-run):",
      "- **38** identifier_manual_review — `expected-packages-remaining-52-review-v201/.../remaining-52-triage.csv`",
      "- **6** source_data_inconsistency — reconcile plan prompt in V201 `next-safe-waves.md`",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length
      ? ["# Blockers", "", ...blockers.map((b) => `- ${b}`)].join("\n") + "\n"
      : "# Blockers\n\nDry-run complete. Execute blocked until env gates enabled (approval file already true).\n",
  );

  const manifest = {
    prompt: "EXPECTED-PACKAGES-AMAZON-API-EVIDENCE-DRY-RUN-V202",
    run_id: runId,
    v201_run_id: v201RunId,
    v199_run_id: v199RunId,
    staging_ref: STAGING_REF,
    status,
    cohort_count: cohort.length,
    distinct_asins: distinctAsins.length,
    approval,
    env_gates: { spApiEnabled, autoCreateEnabled, stagingOk },
    outcomes: { wouldCall, skipLinked, blocked },
    cohort_cross_check: { v199_count: v199Cohort.length, overlap },
    amazon_api_called: false,
    db_writes: false,
    next_prompt:
      status === "READY_FOR_EXECUTE_REVIEW"
        ? "EXPECTED-PACKAGES-AMAZON-API-EVIDENCE-EXECUTE-V202"
        : status === "BLOCKED"
          ? "EXPECTED-PACKAGES-AMAZON-API-EVIDENCE-EXECUTE-V202 — enable AMAZON_SP_API_ENABLED + PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED on staging server first"
          : "EXPECTED-PACKAGES-IDENTIFIER-MANUAL-REVIEW-BATCH-V202",
    forbidden: {
      production_touched: false,
      package_items_created: false,
      expected_packages_updated: false,
      browser_amazon_api: false,
      fake_sp_api: false,
      ai_openai: false,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify(manifest, null, 2));
  process.exit(status === "PASS_EMPTY_COHORT" || status === "PASS_NO_API_NEEDED" ? 0 : status === "BLOCKED" ? 0 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
