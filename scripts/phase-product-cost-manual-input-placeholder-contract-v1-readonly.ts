/**
 * PHASE-PRODUCT-COST-MANUAL-INPUT-PLACEHOLDER-CONTRACT-V1 — smoke (no DB writes)
 *   npx tsx scripts/phase-product-cost-manual-input-placeholder-contract-v1-readonly.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  AUDIT_RULES,
  CLAIM_MONEY_INTEGRATION,
  CONFLICT_RULES,
  COST_INPUT_CONTRACT,
  CSV_UPLOAD_COLUMNS,
  FEE_ADJUSTED_READMODEL_INTEGRATION,
  FUTURE_DATA_MODEL_OPTIONS,
  FUTURE_PURCHASE_MODULE_INTEGRATION,
  MANUAL_FIELDS,
  NEXT_PROMPT,
  NO_SCHEMA_CHANGE_VERIFICATION,
  PRECEDENCE_RULES,
  SAFE_TO_IMPLEMENT_COST_INPUT_UI_CONDITIONS,
  SAFE_TO_IMPLEMENT_COST_INPUT_UI_LATER,
  VALIDATION_RULES,
  resolveUnitCostBasisFromSources,
} from "../lib/products/contracts/product-cost-manual-input-placeholder-contract-v1";

const OUT = ".cursor/audit-reports/phase-product-cost-manual-input-placeholder-contract-v1";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function main(): void {
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const contractPath = path.join(
    process.cwd(),
    "lib/products/contracts/product-cost-manual-input-placeholder-contract-v1.ts",
  );
  const contractSrc = fs.readFileSync(contractPath, "utf8");

  const precedenceDemo = resolveUnitCostBasisFromSources({
    upload_batch_fallback: { unit_cost: 4.5 },
    manual_override: { unit_cost: 6.25 },
    sellersnap_cogs: { unit_cost: 5.0 },
    purchase_module_unit_cost: { unit_cost: 7.1 },
  });

  const nullDemo = resolveUnitCostBasisFromSources({});

  const checks = {
    contract_defined: COST_INPUT_CONTRACT.phase.includes("PLACEHOLDER"),
    manual_fields_count: MANUAL_FIELDS.fields.length >= 4,
    csv_required_columns: CSV_UPLOAD_COLUMNS.required.length >= 5,
    csv_forbidden_sale_price: CSV_UPLOAD_COLUMNS.forbidden_columns.some((c) => c.includes("sale_price")),
    precedence_chain_length: PRECEDENCE_RULES.chain.length === 6,
    purchase_beats_manual: precedenceDemo.source_code === "purchase_module_unit_cost",
    null_when_empty: nullDemo.unit_cost_basis === null && nullDemo.source_code === "unavailable",
    validation_rejects_zero: VALIDATION_RULES.unit_cost.zero_forbidden.includes("0"),
    audit_soft_delete: AUDIT_RULES.soft_delete.includes("deleted_at"),
    future_model_options: Object.keys(FUTURE_DATA_MODEL_OPTIONS).length >= 3,
    fee_adjusted_integration: FEE_ADJUSTED_READMODEL_INTEGRATION.endpoint.includes("fee-adjusted-estimate"),
    claim_money_integration: CLAIM_MONEY_INTEGRATION.formula_lane.includes("unit_cost_basis"),
    no_ddl_in_contract: !/\bCREATE\s+TABLE\b/i.test(contractSrc),
    no_insert_in_contract: !/\b\.insert\s*\(/.test(contractSrc),
    safe_flag: SAFE_TO_IMPLEMENT_COST_INPUT_UI_LATER === "yes_with_conditions",
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-PRODUCT-COST-MANUAL-INPUT-PLACEHOLDER-CONTRACT-V1",
    run_id: id,
    cost_input_contract: COST_INPUT_CONTRACT,
    manual_fields: MANUAL_FIELDS,
    CSV_upload_columns: CSV_UPLOAD_COLUMNS,
    validation_rules: VALIDATION_RULES,
    precedence_rules: PRECEDENCE_RULES,
    conflict_rules: CONFLICT_RULES,
    audit_rules: AUDIT_RULES,
    future_purchase_module_integration: FUTURE_PURCHASE_MODULE_INTEGRATION,
    future_data_model_options: FUTURE_DATA_MODEL_OPTIONS,
    fee_adjusted_readmodel_integration: FEE_ADJUSTED_READMODEL_INTEGRATION,
    claim_money_integration: CLAIM_MONEY_INTEGRATION,
    precedence_demo: precedenceDemo,
    no_schema_change_verification: NO_SCHEMA_CHANGE_VERIFICATION,
    SAFE_TO_IMPLEMENT_COST_INPUT_UI_LATER: SAFE_TO_IMPLEMENT_COST_INPUT_UI_LATER,
    SAFE_TO_IMPLEMENT_COST_INPUT_UI_CONDITIONS,
    checks,
    pass: failures.length === 0,
    NEXT_PROMPT,
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Product cost manual input placeholder contract V1

**Run:** ${id}
**Pass:** ${results.pass ? "YES" : "NO"}

## Precedence (winning demo)
purchase_module_unit_cost=$7.10 beats manual/upload/SellerSnap

## SAFE_TO_IMPLEMENT_COST_INPUT_UI_LATER: ${SAFE_TO_IMPLEMENT_COST_INPUT_UI_LATER}

## No schema change: verified (contract-only)
`,
  );

  if (failures.length) {
    console.error("FAIL:", failures.join(", "));
    process.exit(1);
  }
  console.log(`PASS cost input placeholder contract — run ${id}`);
}

main();
