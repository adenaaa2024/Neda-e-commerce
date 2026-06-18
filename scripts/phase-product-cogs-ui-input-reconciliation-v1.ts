/**
 * PHASE-PRODUCT-COGS-UI-INPUT-RECONCILIATION-V1
 *   npx tsx scripts/phase-product-cogs-ui-input-reconciliation-v1.ts [--run-id=<UTC>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  PRODUCT_COGS_UI_INPUT_RECONCILIATION_V1,
  composeProductCogsUiInputReconciliationV1,
} from "../lib/claims/submission/product-cogs-ui-input-reconciliation-v1";
import { bindProductionSupabaseEnv, PRODUCTION_REF } from "../lib/production-db-bind";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const OUT = ".cursor/audit-reports/phase-product-cogs-ui-input-reconciliation-v1";
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

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const { ref, url } = bindProductionSupabaseEnv();
  if (ref !== PRODUCTION_REF) throw new Error(`BLOCKED: expected ${PRODUCTION_REF}, got ${ref}`);

  const client = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false },
  });

  const scannerBefore = scannerGitStatus();
  const recon = await composeProductCogsUiInputReconciliationV1(client, ORG, STORE);
  const scannerAfter = scannerGitStatus();
  recon.no_scanner_change_verification = scannerBefore === scannerAfter;

  let buildResult = "fail";
  try {
    execSync("npx tsc --noEmit", { encoding: "utf8", stdio: "pipe", timeout: 300_000 });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${String(e).slice(0, 400)}`;
  }

  let smokeResult = "fail";
  try {
    execSync("npx tsx scripts/smoke-product-cogs-ui-input-reconciliation-v1.ts", {
      stdio: "pipe",
      encoding: "utf8",
    });
    smokeResult = "pass";
  } catch (e) {
    smokeResult = `fail: ${String(e).slice(0, 400)}`;
  }

  const result = {
    phase: "PHASE-PRODUCT-COGS-UI-INPUT-RECONCILIATION-V1",
    run_id: rid,
    db_ref: ref,
    mode: "read-only-reconciliation",
    ...recon,
    build_result: buildResult,
    smoke_result: smokeResult,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "per-entry-validation.json"),
    JSON.stringify(recon.per_entry_validation, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# PHASE-PRODUCT-COGS-UI-INPUT-RECONCILIATION-V1

- Run: \`${rid}\` · Mode: **read-only**
- cogs_overrides: **${recon.cogs_overrides_current_count}**
- Operator input unit costs: **${recon.operator_input_json_has_unit_costs_count}**
- Operator input source notes: **${recon.operator_input_json_has_source_notes_count}**
- Maysam values location: ${recon.exact_location_of_maysam_values}
- Reason previous execute failed: ${recon.reason_previous_execute_failed}
- Exact manual fix: ${recon.exact_manual_fix_needed}
- execute_prompt_needed: **${recon.execute_prompt_needed}**
- SAFE_TO_EXECUTE_COGS_WITH_EXISTING_INPUT: **${recon.SAFE_TO_EXECUTE_COGS_WITH_EXISTING_INPUT}**

## NEXT_PROMPT
\`${recon.NEXT_PROMPT}\`
`,
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
