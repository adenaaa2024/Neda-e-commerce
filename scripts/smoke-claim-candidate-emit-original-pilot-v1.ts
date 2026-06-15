/**
 * Smoke — claim candidate emit original pilot V1 (static checks)
 *   npx tsx scripts/smoke-claim-candidate-emit-original-pilot-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  readOriginalPilotApprovalStatus,
  selectPreviewsForOriginalPilotEmit,
  resolveOriginalFamilyCaps,
} from "../lib/claims/intake/claim-preview-emit-v1";

const OUT = ".cursor/audit-reports/smoke-claim-candidate-emit-original-pilot-v1";

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

  const emitSrc = fs.readFileSync(
    path.join(process.cwd(), "lib/claims/intake/claim-preview-emit-v1.ts"),
    "utf8",
  );
  const approval = readOriginalPilotApprovalStatus();

  const previews = [
    {
      family_key: "removal_order_discrepancy",
      duplicate_key: "a",
      quantity_claimed: 1,
    },
    {
      family_key: "removal_shipment_missing",
      duplicate_key: "b",
      quantity_claimed: 2,
    },
    {
      family_key: "removal_shipment_missing",
      duplicate_key: "c",
      quantity_claimed: 3,
    },
  ] as Parameters<typeof selectPreviewsForOriginalPilotEmit>[0];

  const selected = selectPreviewsForOriginalPilotEmit(previews, new Set(), 50);
  const caps = resolveOriginalFamilyCaps(50);
  const originalOrderOk =
    selected[0]?.family_key === "removal_shipment_missing" &&
    selected.filter((p) => p.family_key === "removal_shipment_missing").length <= caps.shipment;

  const checks = {
    emit_module_exists: fs.existsSync(
      path.join(process.cwd(), "lib/claims/intake/claim-preview-emit-v1.ts"),
    ),
    phase_script_exists: fs.existsSync(
      path.join(process.cwd(), "scripts/phase-claim-candidate-emit-original-pilot-v1.ts"),
    ),
    approval_file_exists: fs.existsSync(
      path.join(
        process.cwd(),
        ".cursor/operator-approvals/claim-candidate-emit-original-pilot-v1-approval.md",
      ),
    ),
    approval_signed: approval.approved,
    original_export: emitSrc.includes("runClaimPreviewEmitOriginalPilotV1"),
    original_select: emitSrc.includes("selectPreviewsForOriginalPilotEmit"),
    original_ref_guard: emitSrc.includes("assertOriginalPilotClient"),
    original_ref_constant:
      emitSrc.includes("kxsvedvpjldygtdbylsy") || emitSrc.includes("PRODUCTION_REF"),
    blocks_staging_ref: emitSrc.includes("must not be used for original emit"),
    family_cap_distribution: originalOrderOk,
    uses_apply_drafts: emitSrc.includes("applyDrafts"),
    max_rows_cap: emitSrc.includes("DEFAULT_PILOT_MAX_ROWS = 50"),
    no_hard_delete_rollback: emitSrc.includes("quarantine") && !emitSrc.includes(".delete("),
    date_gate_wired: emitSrc.includes("evaluateClaimPreviewEmitDateGate"),
    emit_origin_tag: emitSrc.includes("preview_emit_v1"),
    no_scanner_import: !emitSrc.includes("operator-mobile"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-V1",
    run_id: id,
    checks,
    pass: failures.length === 0,
    smoke_result: failures.length === 0 ? "PASS" : "FAIL",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));

  if (failures.length) {
    console.error("FAIL:", failures.join(", "));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, run_id: id, smoke: "PASS" }));
}

main();
