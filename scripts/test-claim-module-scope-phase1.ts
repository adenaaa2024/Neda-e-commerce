/**
 * CLAIM-MODULE-SCOPE-PHASE1 — unit tests (no DB).
 *
 *   npx tsx scripts/test-claim-module-scope-phase1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  evaluateClaimEligibilitySync,
  evaluateImportCandidateCutoffSync,
  normalizeClaimPolicy,
} from "../lib/claim-eligibility-policy";
import { isMarketplaceClaimPermission } from "../lib/claim-module-scope";
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

function policyWithReturnsEnabled(): ReturnType<typeof normalizeClaimPolicy> {
  return normalizeClaimPolicy({
    schema_version: 1,
    scan_go_live_date: "2026-01-15",
    claim_start_date: "2026-01-15",
    claim_eligibility_window_days: 90,
    claim_grouping_policy: "single_item",
    claim_hold_policy: ["hold_until_package_closed"],
    enabled_claim_domains: {
      returns: true,
      warehouse_inventory: false,
      carrier_shipments: false,
      removals: false,
      financial: false,
      expected_mismatch: false,
      marketplace: false,
    },
  });
}

function main(): void {
  const rid = runId();
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/claim-module-scope-phase1-implement",
    rid,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const emptyPolicy = normalizeClaimPolicy({});
  const returnsOn = policyWithReturnsEnabled();
  const returnsOff = normalizeClaimPolicy({
    ...returnsOn,
    enabled_claim_domains: { ...returnsOn.enabled_claim_domains, returns: false },
  });

  const checks: Check[] = [
    assert(
      "defaults_all_domains_disabled",
      !emptyPolicy.enabled_claim_domains.returns &&
        !emptyPolicy.enabled_claim_domains.marketplace,
      "empty {} policy keeps all module domains disabled",
    ),
    assert(
      "returns_disabled_blocks_scanner",
      !evaluateClaimEligibilitySync({
        policy: returnsOff,
        claimSource: "scanner_operator_issue",
        eventAt: "2026-05-10",
        hasScannerEvidence: true,
        evaluationDate: "2026-05-18",
        packageClosed: true,
      }).allowed,
      "returns off blocks scanner return_item path",
    ),
    assert(
      "returns_disabled_reason",
      evaluateClaimEligibilitySync({
        policy: returnsOff,
        claimSource: "scanner_operator_issue",
        eventAt: "2026-05-10",
        hasScannerEvidence: true,
        evaluationDate: "2026-05-18",
        packageClosed: true,
      }).reason === "module_scope_disabled",
      "returns off yields module_scope_disabled",
    ),
    assert(
      "returns_enabled_allows_eligible_return_scan",
      evaluateClaimEligibilitySync({
        policy: returnsOn,
        claimSource: "scanner_operator_issue",
        eventAt: "2026-05-10",
        hasScannerEvidence: true,
        evaluationDate: "2026-05-18",
        packageClosed: true,
      }).allowed,
      "returns on + post-cutoff + evidence allows scanner promote eligibility",
    ),
    assert(
      "removals_domain_disabled_blocks_import",
      !evaluateImportCandidateCutoffSync(
        returnsOn,
        "amazon_removals",
        { shipment_date: "2026-05-01", created_at: "2026-05-01" },
        null,
        "2026-05-18",
      ).allowed,
      "removals off blocks removal import candidates even post cutoff",
    ),
    assert(
      "marketplace_permission_key_detected",
      isMarketplaceClaimPermission("claims.marketplace.submit"),
      "marketplace permission keys recognized",
    ),
    assert(
      "marketplace_domain_disabled_in_default_policy",
      !returnsOn.enabled_claim_domains.marketplace,
      "configured pilot-style policy keeps marketplace off",
    ),
    assert(
      "pre_cutoff_still_blocks_with_returns_on",
      !evaluateClaimEligibilitySync({
        policy: returnsOn,
        claimSource: "scanner_operator_issue",
        eventAt: "2026-01-10",
        hasScannerEvidence: true,
        evaluationDate: "2026-05-18",
        packageClosed: true,
      }).allowed &&
        evaluateClaimEligibilitySync({
          policy: returnsOn,
          claimSource: "scanner_operator_issue",
          eventAt: "2026-01-10",
          hasScannerEvidence: true,
          evaluationDate: "2026-05-18",
          packageClosed: true,
        }).reason === "scan_not_live",
      "cutoff still applies when returns module enabled",
    ),
    assert(
      "warehouse_qc_blocked_when_warehouse_off",
      !evaluateClaimEligibilitySync({
        policy: returnsOn,
        claimSource: "warehouse_qc_issue",
        eventAt: "2026-05-10",
        hasScannerEvidence: true,
        evaluationDate: "2026-05-18",
        packageClosed: true,
      }).allowed,
      "warehouse domain off blocks warehouse_qc_issue",
    ),
  ];

  const failed = checks.filter((c) => !c.pass);
  const result = {
    run_id: rid,
    status: failed.length === 0 ? "PASS" : "FAIL",
    checks,
    defaults: DEFAULT_CLAIM_POLICY_V1.enabled_claim_domains,
  };

  fs.writeFileSync(path.join(outDir, "smoke-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "SUMMARY.md"),
    [
      "# CLAIM-MODULE-SCOPE-PHASE1-IMPLEMENT — tests",
      "",
      `**Status:** ${result.status}`,
      `**Run ID:** ${rid}`,
      "",
      ...checks.map((c) => `- ${c.pass ? "PASS" : "FAIL"} **${c.name}** — ${c.detail}`),
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      { run_id: rid, task: "CLAIM-MODULE-SCOPE-PHASE1-IMPLEMENT", status: result.status },
      null,
      2,
    ),
  );

  console.log(JSON.stringify(result, null, 2));
  if (failed.length) process.exit(1);
}

main();
