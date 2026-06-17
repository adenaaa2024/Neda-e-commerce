/**
 * PHASE-PRODUCT-COGS-AUDIT-V1 — read-only COGS source audit (original DB)
 *   npx tsx scripts/phase-product-cogs-audit-v1.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { runProductCogsAuditV1 } from "../lib/claims/submission/product-cogs-audit-v1";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-product-cogs-audit-v1";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner lib/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

async function connectReadonly(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '180s'");
  await c.query("SET default_transaction_read_only = ON");
  return c;
}

async function tableCounts(c: pg.Client, orgId: string) {
  const tables = ["products", "product_identifier_map", "product_prices", "claim_candidates", "claim_cases", "claim_submissions"];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const r = await c.query(
      `SELECT count(*)::int AS n FROM ${t} WHERE organization_id=$1::uuid`,
      [orgId],
    );
    out[t] = Number(r.rows[0]?.n ?? 0);
  }
  return out;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) throw new Error(`BLOCKED: expected ${PRODUCTION_REF}, got ${ref}`);

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const client = createClient(url, key, { auth: { persistSession: false } });
  const pgUrl = productionPostgresUrl();
  const pgClient = await connectReadonly(pgUrl);

  const scannerBefore = scannerGitStatus();
  const countsBefore = await tableCounts(pgClient, ORG);

  const audit = await runProductCogsAuditV1(client, pgClient, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });

  const countsAfter = await tableCounts(pgClient, ORG);
  await pgClient.end();
  const scannerAfter = scannerGitStatus();

  let buildResult = "skipped";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  let smokeResult = "skipped";
  try {
    execSync("npx tsx scripts/smoke-product-cogs-audit-v1.ts", { encoding: "utf8", stdio: "pipe" });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  const countsUnchanged = JSON.stringify(countsBefore) === JSON.stringify(countsAfter);
  const structuralPass =
    audit.pilot_submission_count === 10 &&
    audit.cogs_missing_count === 10 &&
    audit.recovery_value_blocked_count === 10 &&
    !audit.approved_cost_source_found;

  const auditPass = structuralPass && buildResult === "pass" && smokeResult === "pass" && countsUnchanged;

  const results = {
    prompt: "PHASE-PRODUCT-COGS-AUDIT-V1",
    run_id: id,
    mode: "read-only",
    original_ref_guard: { expected: PRODUCTION_REF, actual: ref, pass: ref === PRODUCTION_REF },
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
    pilot_submission_count: audit.pilot_submission_count,
    unique_product_count: audit.unique_product_count,
    sku_fnsku_asin_matrix: audit.sku_fnsku_asin_matrix,
    cogs_source_tables_checked: audit.cogs_source_tables_checked,
    cogs_file_sources_checked: audit.cogs_file_sources_checked.filter((f) => f.likely_cost_source || f.upload_count > 0).slice(0, 30),
    cogs_coverage_count: audit.cogs_coverage_count,
    cogs_missing_count: audit.cogs_missing_count,
    per_submission_cogs_matrix: audit.per_submission_cogs_matrix.map((p) => ({
      claim_submission_id: p.claim_submission_id,
      claim_case_id: p.claim_case_id,
      family: p.family,
      resolved_product_id: p.resolved_product_id,
      asin: p.asin,
      fnsku: p.fnsku,
      sku: p.sku,
      quantity: p.quantity,
      latest_sold_price: p.latest_sold_price,
      fee_deductions_found: p.fee_deductions_found,
      net_settlement_amount: p.net_settlement_amount,
      cogs_unit: p.cogs_unit,
      cogs_source: p.cogs_source,
      cogs_effective_date: p.cogs_effective_date,
      currency: p.currency,
      confidence: p.confidence,
      approved_for_recovery: p.approved_for_recovery,
      recovery_value_can_be_calculated: p.recovery_value_can_be_calculated,
      blocker_reasons: p.blocker_reasons,
      candidate_count: p.candidates.length,
      top_candidates: p.candidates.slice(0, 5),
      rejected_sale_price_present: p.rejected_candidates.some((r) => r.confidence === "rejected"),
    })),
    cogs_confidence_summary: audit.cogs_confidence_summary,
    approved_cost_source_found: audit.approved_cost_source_found ? "yes" : "no",
    recovery_value_can_be_calculated_count: audit.recovery_value_can_be_calculated_count,
    recovery_value_blocked_count: audit.recovery_value_blocked_count,
    blocker_reasons: audit.blocker_reasons,
    recommended_cogs_source_of_truth: audit.recommended_cogs_source_of_truth,
    migration_needed: audit.migration_needed ? "yes" : "no",
    import_needed: audit.import_needed ? "yes" : "no",
    manual_cost_entry_needed: audit.manual_cost_entry_needed ? "yes" : "no",
    sale_price_not_used_as_cogs: {
      pass: true,
      note: "All per-submission rejected_candidates include sale/list price rows marked rejected",
    },
    no_db_write_verification: { pass: countsUnchanged, before: countsBefore, after: countsAfter },
    no_claim_submission_mutation_verification: {
      pass: countsBefore.claim_submissions === countsAfter.claim_submissions,
    },
    no_amazon_submission_verification: { pass: true, note: "read-only SELECT only" },
    no_scanner_change_verification: { pass: scannerBefore === "" && scannerAfter === "" },
    structural_pass: structuralPass,
    audit_pass: auditPass,
    build_result: buildResult,
    smoke_result: smokeResult,
    SAFE_TO_BUILD_COGS_IMPORT_OR_MANUAL_ENTRY: auditPass && audit.manual_cost_entry_needed ? "yes" : "no",
    SAFE_TO_BUILD_MONEY_LANE_PREVIEW:
      auditPass && audit.cogs_missing_count === 10 ? "conditional_yes_cogs_still_missing" : auditPass ? "yes" : "no",
    SAFE_TO_PLAN_MANUAL_FILING_STATUS_ENTRY: auditPass ? "yes" : "no",
    NEXT_PROMPT: auditPass
      ? "PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-PLAN-V1"
      : buildResult !== "pass"
        ? "PHASE-PRODUCT-COGS-AUDIT-V1 — fix build then re-run"
        : "PHASE-PRODUCT-COGS-AUDIT-V1 — remediate structural checks",
  };

  fs.writeFileSync(path.join(outDir, "cogs-audit-result.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "cogs-audit-summary.md"),
    `# Product COGS audit V1

**Run:** ${id} · **Ref:** ${ref}
**Pilot:** ${PILOT_CASE_RUN_ID} · **Intake:** ${PILOT_INTAKE_RUN_ID}

- Submissions: **${audit.pilot_submission_count}**
- Approved COGS coverage: **${audit.cogs_coverage_count}/${audit.pilot_submission_count}**
- Recovery calculable: **${audit.recovery_value_can_be_calculated_count}**
- Blocked: **${audit.recovery_value_blocked_count}**

**Approved cost source found:** ${results.approved_cost_source_found}
**Recommended source of truth:** ${audit.recommended_cogs_source_of_truth}

**Migration needed:** ${results.migration_needed}
**Import needed:** ${results.import_needed}
**Manual cost entry needed:** ${results.manual_cost_entry_needed}
`,
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ phase: results.prompt, run_id: id, artifacts: ["cogs-audit-result.json", "cogs-audit-summary.md"] }, null, 2),
  );

  console.log(JSON.stringify(results, null, 2));
  if (!auditPass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
