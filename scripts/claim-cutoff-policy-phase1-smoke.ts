/**
 * CLAIM-CUTOFF-POLICY-PHASE1 — unit smoke (no DB required for core rules).
 *
 *   npx tsx scripts/claim-cutoff-policy-phase1-smoke.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  evaluateClaimEligibilitySync,
  evaluateExpectedPackageClaimEligibilitySync,
  evaluateImportCandidateCutoffSync,
  normalizeClaimPolicy,
} from "../lib/claim-eligibility-policy";
import { DEFAULT_CLAIM_POLICY_V1 } from "../lib/claim-policy-types";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

type Check = { name: string; pass: boolean; detail: string };

function assert(name: string, cond: boolean, detail: string): Check {
  return { name, pass: cond, detail };
}

function main(): void {
  const rid = runId();
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/claim-cutoff-policy-phase1-implement",
    rid,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const emptyPolicy = normalizeClaimPolicy({});
  const configured = normalizeClaimPolicy({
    schema_version: 1,
    scan_go_live_date: "2026-01-15",
    claim_start_date: "2026-01-15",
    claim_eligibility_window_days: 90,
    claim_grouping_policy: "single_item",
    claim_hold_policy: ["hold_until_package_closed"],
  });

  const checks: Check[] = [
    assert(
      "unset_policy_blocks_scanner",
      !evaluateClaimEligibilitySync({
        policy: emptyPolicy,
        claimSource: "scanner_operator_issue",
        eventAt: "2026-02-01",
        hasScannerEvidence: true,
        packageClosed: true,
      }).allowed,
      "empty {} must block scanner auto-claim",
    ),
    assert(
      "unset_policy_default_window_90",
      emptyPolicy.claim_eligibility_window_days === 90,
      "default window is 90 days",
    ),
    assert(
      "scan_after_go_live_with_evidence",
      evaluateClaimEligibilitySync({
        policy: configured,
        claimSource: "scanner_operator_issue",
        eventAt: "2026-02-01",
        hasScannerEvidence: true,
        evaluationDate: "2026-02-10",
        packageClosed: true,
      }).allowed,
      "post go-live scan with evidence should pass when package closed",
    ),
    assert(
      "pre_cutoff_scan_blocked",
      evaluateClaimEligibilitySync({
        policy: configured,
        claimSource: "scanner_operator_issue",
        eventAt: "2025-09-01",
        hasScannerEvidence: true,
        evaluationDate: "2026-02-10",
        packageClosed: true,
      }).reason === "scan_not_live",
      "Sep 2025 scan blocked before scan_go_live_date",
    ),
    assert(
      "import_pre_cutoff_blocked",
      evaluateImportCandidateCutoffSync(
        configured,
        "amazon_removals",
        { shipment_date: "2025-09-01", created_at: "2025-09-01T00:00:00Z" },
        { created_at: "2025-09-01T00:00:00Z" },
        "2026-02-10",
      ).reason === "import_pre_cutoff",
      "historical removal import candidate blocked",
    ),
    assert(
      "import_post_start_allowed_window",
      evaluateImportCandidateCutoffSync(
        configured,
        "amazon_removals",
        { shipment_date: "2026-02-01", created_at: "2026-02-01T00:00:00Z" },
        { created_at: "2026-02-01T00:00:00Z" },
        "2026-02-10",
      ).allowed,
      "post claim_start_date import candidate allowed (no scanner evidence required)",
    ),
    assert(
      "expected_api_only_not_eligible",
      !evaluateExpectedPackageClaimEligibilitySync(
        configured,
        "2025-09-01",
        false,
        "2026-02-10",
      ).allowed,
      "API-only expected row without scan evidence blocked",
    ),
    assert(
      "hold_package_open_blocks",
      !evaluateClaimEligibilitySync({
        policy: configured,
        claimSource: "ready_for_claim",
        eventAt: "2026-02-01",
        hasScannerEvidence: true,
        evaluationDate: "2026-02-10",
        packageClosed: false,
      }).allowed,
      "open package blocks when hold_until_package_closed enabled",
    ),
    assert(
      "missing_scanner_evidence_blocks",
      evaluateClaimEligibilitySync({
        policy: configured,
        claimSource: "ready_for_claim",
        eventAt: "2026-02-01",
        hasScannerEvidence: false,
        evaluationDate: "2026-02-10",
        packageClosed: true,
      }).reason === "missing_scanner_evidence",
      "ready path requires scanner evidence",
    ),
  ];

  const failed = checks.filter((c) => !c.pass);
  const result = {
    run_id: rid,
    status: failed.length === 0 ? "PASS" : "FAIL",
    checks,
    defaults: DEFAULT_CLAIM_POLICY_V1,
  };

  fs.writeFileSync(path.join(outDir, "smoke-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "report.md"),
    [
      "# Claim Cutoff Policy — Phase 1 Implement",
      "",
      `Run: \`${rid}\``,
      `Status: **${result.status}**`,
      "",
      "## Checks",
      "",
      ...checks.map((c) => `- [${c.pass ? "x" : " "}] ${c.name} — ${c.detail}`),
      "",
      "## Files touched",
      "",
      "- `lib/claim-policy-types.ts`",
      "- `lib/claim-eligibility-policy.ts`",
      "- `lib/scanner-operator-claim-promote.ts`",
      "- `app/returns/actions.ts`",
      "- `app/claim-engine/logistics-sync-actions.ts`",
      "- `app/claim-engine/claim-submission-actions.ts`",
      "- `lib/claim-artifact-projection-core.ts`",
      "- `lib/claim-candidate-resolver-materialize.ts`",
      "- `app/settings/organization-claim-policy-actions.ts`",
      "- `app/settings/page.tsx`",
      "- `supabase/migrations/20260529120000_organization_settings_claim_policy.sql`",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        run_id: rid,
        task: "CLAIM-CUTOFF-POLICY-PHASE1-IMPLEMENT",
        status: result.status,
        failed_checks: failed.map((f) => f.name),
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify(result, null, 2));
  if (failed.length) process.exit(1);
}

main();
