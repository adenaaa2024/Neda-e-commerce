/**
 * CLAIM-EVIDENCE-07 — Unit tests for edge review helpers (no DB).
 */

import {
  normalizeReviewNote,
  parseEdgeReviewStatus,
} from "../lib/claim-evidence-edge-review";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function testParseStatus(): void {
  assert(parseEdgeReviewStatus("accepted") === "accepted", "accepted");
  assert(parseEdgeReviewStatus("rejected") === "rejected", "rejected");
  assert(parseEdgeReviewStatus("needs_review") === "needs_review", "needs_review");
  assert(parseEdgeReviewStatus("invalid") === null, "invalid");
}

function testNote(): void {
  assert(normalizeReviewNote(null) === null, "null note");
  assert(normalizeReviewNote("  ok  ") === "ok", "trim");
  assert(normalizeReviewNote("x".repeat(600))!.length === 500, "cap");
}

async function main(): Promise<void> {
  const tests: [string, () => void][] = [
    ["parse status", testParseStatus],
    ["note normalize", testNote],
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
