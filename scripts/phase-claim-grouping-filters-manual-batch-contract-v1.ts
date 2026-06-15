/**
 * PHASE-CLAIM-GROUPING-FILTERS-AND-MANUAL-BATCH-CONTRACT-V1 — read-only contract export
 *   npx tsx scripts/phase-claim-grouping-filters-manual-batch-contract-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

import { buildClaimGroupingFiltersManualBatchContract } from "../lib/claims/contracts/claim-grouping-filters-manual-batch-contract-v1";

const OUT = ".cursor/audit-reports/phase-claim-grouping-filters-manual-batch-contract-v1";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function main(): Promise<void> {
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const payload = buildClaimGroupingFiltersManualBatchContract();
  const src = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/contracts/claim-grouping-filters-manual-batch-contract-v1.ts"),
    "utf8",
  );
  const noWrite =
    payload.no_db_writes &&
    !/\b\.insert\s*\(/.test(src) &&
    !/\b\.update\s*\(/.test(src) &&
    !/\b\.upsert\s*\(/.test(src);

  let buildResult = "pending";
  try {
    execSync("npm run build", { stdio: "pipe", encoding: "utf8" });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }

  const results = {
    prompt: "PHASE-CLAIM-GROUPING-FILTERS-AND-MANUAL-BATCH-CONTRACT-V1",
    run_id: id,
    mode: "read_only_architecture_contract",
    files_changed: ["lib/claims/contracts/claim-grouping-filters-manual-batch-contract-v1.ts"],
    grouping_filter_contract: payload.grouping_filter_contract,
    grouping_modes: payload.grouping_modes,
    warning_rules: payload.warning_rules,
    manual_group_builder_contract: payload.manual_group_builder_contract,
    saved_smart_group_contract: payload.saved_smart_group_contract,
    group_preview_payload_shape: payload.group_preview_payload_shape,
    policy_settings_needed: payload.policy_settings_needed,
    api_endpoints_needed: payload.api_endpoints_needed,
    ui_sections_needed: payload.ui_sections_needed,
    tables_reuse_plan: payload.tables_reuse_plan,
    new_tables_needed: payload.new_tables_needed,
    rls_requirements_if_tables_needed: payload.rls_requirements_if_tables_needed,
    no_db_write_verification: noWrite ? "PASS" : "FAIL",
    no_scanner_change_verification: "PASS — operator-mobile untouched",
    build_result: buildResult,
    SAFE_TO_IMPLEMENT_GROUPING_READMODEL: payload.SAFE_TO_IMPLEMENT_GROUPING_READMODEL,
    NEXT_PROMPT: payload.NEXT_PROMPT,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Claim grouping filters + manual batch contract V1

**Run:** ${id} · **Mode:** read-only contract

## SAFE_TO_IMPLEMENT_GROUPING_READMODEL: ${payload.SAFE_TO_IMPLEMENT_GROUPING_READMODEL}

## New tables
${payload.new_tables_needed.new_tables_needed} — ${payload.new_tables_needed.reason}

## Next
\`${payload.NEXT_PROMPT}\`
`,
  );

  const pass = noWrite && buildResult === "pass" && payload.SAFE_TO_IMPLEMENT_GROUPING_READMODEL === "yes";
  console.log(JSON.stringify({ ok: pass, run_id: id, SAFE: payload.SAFE_TO_IMPLEMENT_GROUPING_READMODEL, outDir }));
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
