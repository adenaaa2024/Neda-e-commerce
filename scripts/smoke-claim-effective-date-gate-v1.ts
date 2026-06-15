/**
 * Smoke — effective date gate V1 (static + pure logic)
 *   npx tsx scripts/smoke-claim-effective-date-gate-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  evaluateClaimEffectiveDateGate,
  previewItemPassesDateFilter,
  resolveEffectiveDateForSource,
} from "../lib/claims/effective-date/claim-effective-date-gate-v1";
import type { PreviewGeneratorItem } from "../lib/claims/center/claim-first-safe-families-preview-generators-v1";

const OUT = ".cursor/audit-reports/smoke-claim-effective-date-gate-v1";

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
  const root = process.cwd();

  const policy = {
    claim_start_date: "2026-01-15",
    scan_go_live_date: "2026-01-15",
    claim_eligibility_window_days: 90,
  };

  const removalCutoff = resolveEffectiveDateForSource("delayed_not_received", policy);
  const scannerCutoff = resolveEffectiveDateForSource("scanner_physical_review", policy);

  const preCutoff = evaluateClaimEffectiveDateGate({
    source_kind: "delayed_not_received",
    event_date: "2026-01-10",
    policy,
  });
  const missingDate = evaluateClaimEffectiveDateGate({
    source_kind: "delayed_not_received",
    event_date: null,
    policy,
  });
  const passGate = evaluateClaimEffectiveDateGate({
    source_kind: "delayed_not_received",
    event_date: "2026-04-01",
    policy,
  });
  const scannerPre = evaluateClaimEffectiveDateGate({
    source_kind: "scanner_physical_review",
    event_date: "2026-01-10",
    policy,
  });

  const previewSrc = fs.readFileSync(
    path.join(root, "lib/claims/center/claim-first-safe-families-preview-generators-v1.ts"),
    "utf8",
  );
  const groupingSrc = fs.readFileSync(
    path.join(root, "lib/claims/grouping/claim-grouping-readmodel.ts"),
    "utf8",
  );
  const emitSrc = fs.readFileSync(path.join(root, "lib/claims/intake/claim-preview-emit-v1.ts"), "utf8");

  const dateFilterItem = {
    event_date: "2026-05-01",
    source_event_date: "2026-05-01",
  } as PreviewGeneratorItem;
  const dateFilterExcluded = !previewItemPassesDateFilter(dateFilterItem, "2026-05-15", null);
  const dateFilterIncluded = previewItemPassesDateFilter(dateFilterItem, "2026-04-01", "2026-06-01");

  const checks = {
    removal_uses_claim_start: removalCutoff.effective_date_source === "claim_start_date",
    scanner_uses_scan_go_live: scannerCutoff.effective_date_source === "scan_go_live_date",
    pre_cutoff_fails: !preCutoff.pass && preCutoff.pre_cutoff,
    missing_date_fails: !missingDate.pass && missingDate.missing_event_date,
    pass_gate_ok: passGate.pass && passGate.date_gate_passed,
    scanner_pre_cutoff_fails: !scannerPre.pass && scannerPre.pre_cutoff,
    preview_has_event_date_field: previewSrc.includes("event_date:") && previewSrc.includes("pre_cutoff"),
    preview_derive_action_gates: previewSrc.includes("missing_event_date") && previewSrc.includes("pre_cutoff"),
    grouping_date_filter: groupingSrc.includes("previewItemPassesDateFilter"),
    grouping_effective_context: groupingSrc.includes("effective_date_context"),
    emit_recheck: emitSrc.includes("evaluateClaimPreviewEmitDateGate"),
    date_filter_works: dateFilterExcluded && dateFilterIncluded,
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = { prompt: "PHASE-CLAIM-EFFECTIVE-DATE-GATE-V1", run_id: id, checks, pass: failures.length === 0 };
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));

  if (failures.length) {
    console.error("FAIL:", failures.join(", "));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, run_id: id, smoke: "PASS" }));
}

main();
