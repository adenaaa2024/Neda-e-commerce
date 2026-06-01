/**
 * CLAIM-DRAFT-POLICY-GATE-VERIFY-AND-HARDEN — unit tests (no DB).
 *
 *   npx tsx scripts/test-claim-draft-policy-gate.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { normalizeClaimPolicy } from "../lib/claim-eligibility-policy";
import { isBackfillClaimLineExcludedFromQueue } from "../lib/returns-claims-work-queue";
import {
  assertImportReferenceNotAttachedToDraft,
  evaluateManualDraftPolicyGate,
  filterAmazonReturnsReferenceLines,
  isBlockedGrainForManualDraftCreation,
  manualClaimLinePatchFromReturnItem,
  validateManualGroupingSelection,
  type ManualGroupingReturnItemInput,
} from "../lib/returns-manual-claim-grouping";

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

const policyOn = normalizeClaimPolicy({
  scan_go_live_date: "2026-01-15",
  claim_start_date: "2026-01-15",
  claim_eligibility_window_days: 90,
  enabled_claim_domains: { returns: true },
  claim_hold_policy: ["hold_until_package_closed"],
});

function physicalRow(overrides: Partial<ManualGroupingReturnItemInput> = {}): ManualGroupingReturnItemInput {
  return {
    return_item_id: "ri-1",
    organization_id: "org-1",
    store_id: null,
    package_id: "pkg-1",
    pallet_id: null,
    expected_item_id: null,
    conditions: ["damaged_product"],
    photo_evidence: { item_url: "https://example.com/p.jpg" },
    resolved_product_id: "prod-1",
    order_id: "111-999",
    sku: "SKU-A",
    notes: null,
    created_at: "2026-05-10T12:00:00Z",
    ...overrides,
  };
}

function main(): void {
  const rid = runId();
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/claim-draft-policy-gate-verify-and-harden",
    rid,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const pkgClosedCtx = {
    packageClosedByReturnItemId: { "ri-1": true },
    evaluationDate: "2026-06-01",
  };

  const preCutoff = evaluateManualDraftPolicyGate(
    physicalRow({ created_at: "2025-12-01T00:00:00Z" }),
    policyOn,
    pkgClosedCtx,
  );

  const outsideWindow = evaluateManualDraftPolicyGate(
    physicalRow({ created_at: "2026-03-01T00:00:00Z" }),
    policyOn,
    { ...pkgClosedCtx, evaluationDate: "2026-06-15" },
  );

  const noEvidence = evaluateManualDraftPolicyGate(
    physicalRow({ photo_evidence: {}, conditions: ["damaged_product"] }),
    policyOn,
    pkgClosedCtx,
  );

  const eligible = evaluateManualDraftPolicyGate(physicalRow(), policyOn, pkgClosedCtx);

  const packageOpen = evaluateManualDraftPolicyGate(physicalRow(), policyOn, {
    packageClosedByReturnItemId: { "ri-1": false },
    evaluationDate: "2026-06-01",
  });

  const refs = filterAmazonReturnsReferenceLines(
    [
      {
        id: "cl-ar",
        line_grain: "import_source",
        source_table: "amazon_returns",
        source_row_id: "x",
        order_id: "111-999",
        sku: "SKU-A",
        status: "detected",
      },
    ],
    { order_ids: ["111-999"], skus: [] },
  );

  const linePatch = manualClaimLinePatchFromReturnItem(
    physicalRow(),
    "case-1",
    "damaged_product",
    "damaged_product",
  );

  const checks: Check[] = [
    assert("pre_cutoff_blocked", !preCutoff.allowed && preCutoff.reason === "scan_not_live", "before scan_go_live"),
    assert(
      "outside_window_blocked",
      !outsideWindow.allowed && outsideWindow.reason === "outside_window",
      "claim eligibility window enforced",
    ),
    assert(
      "no_evidence_blocked",
      !noEvidence.allowed && noEvidence.reason === "missing_scanner_evidence",
      "photo evidence required",
    ),
    assert(
      "package_hold_blocked",
      !packageOpen.allowed && packageOpen.reason === "hold_package_open",
      "hold_until_package_closed respected",
    ),
    assert(
      "eligible_physical_creates_draft",
      eligible.allowed && validateManualGroupingSelection([physicalRow()], policyOn, pkgClosedCtx).ok,
      "physical RI with evidence passes all gates",
    ),
    assert(
      "expected_group_blocked",
      isBackfillClaimLineExcludedFromQueue("expected_group") &&
        isBlockedGrainForManualDraftCreation("expected_group"),
      "expected_group cannot seed manual draft",
    ),
    assert(
      "removal_financial_blocked",
      isBlockedGrainForManualDraftCreation("import_source", "amazon_removals"),
      "removal import_source blocked",
    ),
    assert(
      "import_reference_not_attached",
      refs.every((r) => r.read_only) && assertImportReferenceNotAttachedToDraft(refs, "case-new"),
      "amazon_returns reference stays read-only",
    ),
    assert(
      "line_patch_return_item_grain_only",
      linePatch.line_grain === "return_item" && linePatch.metadata.policy_gate === "returns_manual_draft_v1",
      "inserts only return_item grain with policy metadata",
    ),
  ];

  const failed = checks.filter((c) => !c.pass);
  const result = { run_id: rid, status: failed.length === 0 ? "PASS" : "FAIL", checks };

  fs.writeFileSync(path.join(outDir, "test-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "REPORT.md"),
    [
      "# CLAIM-DRAFT-POLICY-GATE-VERIFY-AND-HARDEN",
      "",
      `**Status:** ${result.status}`,
      "",
      "## Policy gates found (centralized in `evaluateManualDraftPolicyGate`)",
      "",
      "1. Returns module enabled (`module_scope_disabled`)",
      "2. Scan go-live / cutoff (`scan_not_live`)",
      "3. Claim eligibility window (`outside_window`)",
      "4. Physical scan (`not_physical_scan`)",
      "5. Claimable scanner issue (`not_claimable`)",
      "6. Resolved product (unless `allow_manual_override`)",
      "7. Scanner photo evidence (`missing_scanner_evidence`)",
      "8. Operator note for `operator_other` (`missing_operator_note`)",
      "9. Package/pallet holds via `evaluateClaimEligibilitySync`",
      "10. `manual_review_required` hold flag",
      "",
      "## Patches",
      "",
      "- `lib/returns-manual-claim-grouping.ts` — `evaluateManualDraftPolicyGate`, fixed package hold in validation",
      "- `app/returns/returns-manual-claim-grouping-actions.ts` — package closed map + gate before insert",
      "- `app/returns/returns-claims-work-queue-actions.ts` — expose `claim_policy` to UI",
      "- `app/returns/claims/ReturnsClaimsWorkQueueClient.tsx` — selection uses policy gate",
      "",
      "## Tests",
      "",
      ...checks.map((c) => `- ${c.pass ? "PASS" : "FAIL"} **${c.name}** — ${c.detail}`),
      "",
      "## SAFE_TO_CONTINUE",
      "",
      failed.length === 0 ? "**YES**" : "**NO**",
    ].join("\n") + "\n",
  );

  console.log(JSON.stringify(result, null, 2));
  if (failed.length) process.exit(1);
}

main();
