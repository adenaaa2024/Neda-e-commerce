/**
 * NEXT-CLAIM-CANONICAL-03 — smoke checks for claim artifact projection core (no DB).
 * Run: npx tsx scripts/claim-artifact-projection-core-smoke.ts
 */

import assert from "node:assert/strict";
import { computeFinalBucket, computeInboxQueueMeta } from "../lib/claim-artifact-projection-core";

assert.equal(
  computeFinalBucket({
    unsupported: false,
    missing: false,
    ambiguous: true,
    pimBlocked: false,
    proposedResolved: null,
    proposalFrom: "none",
    evidenceStatus: null,
  }),
  "ambiguous",
);

const q = computeInboxQueueMeta({
  finalBucket: "ambiguous",
  evidenceStatus: null,
  sourceTableRaw: "amazon_returns",
  sourceRowId: "x",
  sourceFound: false,
  pack: undefined,
});
assert.equal(q.inbox_queue, "needs_product_link");
assert.ok(q.badges.includes("conflict"));

console.log("[PASS] claim-artifact-projection-core-smoke");
