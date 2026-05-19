/**
 * CLAIM-EVIDENCE-08 — Unit tests for filing readiness gate (no DB).
 */

import { computeFilingReadiness, filterActionableWarnings } from "../lib/claim-evidence-filing-readiness";
import type { ClaimEvidenceEdgeReviewSummary } from "../lib/claim-evidence-edge-review";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const baseSummary: ClaimEvidenceEdgeReviewSummary = {
  total: 10,
  accepted: 8,
  rejected: 0,
  needs_review: 2,
};

function testAllReviewed(): void {
  const gate = computeFilingReadiness({
    reviewSummary: { ...baseSummary, needs_review: 0, accepted: 10 },
    warnings: [],
    operatorState: null,
  });
  assert(gate.all_edges_reviewed, "all reviewed");
  assert(gate.ready, "ready when no warnings and no rejected");
}

function testRejectedBlocks(): void {
  const gate = computeFilingReadiness({
    reviewSummary: { ...baseSummary, needs_review: 0, rejected: 1, accepted: 9 },
    warnings: [],
    operatorState: null,
  });
  assert(!gate.no_blocking_rejected, "rejected blocks");
  assert(gate.blockers.some((b) => b.includes("rejected")), "blocker mentions rejected");
}

function testWarningsAck(): void {
  const gate = computeFilingReadiness({
    reviewSummary: { ...baseSummary, needs_review: 0, accepted: 10 },
    warnings: [{ code: "cce_truncated", severity: "warn", message: "truncated" }],
    operatorState: null,
  });
  assert(!gate.warnings_clear_or_acknowledged, "warn needs ack");
  const acked = computeFilingReadiness({
    reviewSummary: { ...baseSummary, needs_review: 0, accepted: 10 },
    warnings: [{ code: "cce_truncated", severity: "warn", message: "truncated" }],
    operatorState: {
      warnings_acknowledged_at: new Date().toISOString(),
      warnings_acknowledged_by: "u",
      acknowledged_warning_codes: ["cce_truncated"],
    },
  });
  assert(acked.warnings_clear_or_acknowledged, "acked clears warn gate");
  assert(acked.ready, "fully ready");
}

function testNonActionableWarnings(): void {
  const actionable = filterActionableWarnings([
    { code: "preview_only", severity: "warn", message: "x" },
    { code: "persisted_edges_available", severity: "info", message: "y" },
    { code: "cce_truncated", severity: "warn", message: "z" },
  ]);
  assert(actionable.length === 1 && actionable[0]!.code === "cce_truncated", "filter");
}

async function main(): Promise<void> {
  const tests: [string, () => void][] = [
    ["all reviewed", testAllReviewed],
    ["rejected blocks", testRejectedBlocks],
    ["warnings ack", testWarningsAck],
    ["non-actionable filter", testNonActionableWarnings],
  ];
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      fn();
      console.log(`ok ${name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${name}:`, e instanceof Error ? e.message : e);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
