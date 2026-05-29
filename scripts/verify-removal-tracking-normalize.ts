/**
 * Unit checks for lib/pipeline/removal-tracking-normalize.ts
 *
 *   npm run verify:removal-tracking-normalize
 */
import {
  normalizeRemovalTrackingOperational,
  isDirtyRemovalTrackingOperational,
} from "../lib/pipeline/removal-tracking-normalize";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function main(): void {
  const dedupe = normalizeRemovalTrackingOperational("2221311171, 2221311171");
  assert(dedupe.status === "deduped_repeated", `dedupe status: ${dedupe.status}`);
  assert(dedupe.operational === "2221311171", `dedupe operational: ${dedupe.operational}`);

  const brackets = normalizeRemovalTrackingOperational('["T12345"]');
  assert(brackets.operational === "T12345", `brackets: ${brackets.operational}`);

  const conflict = normalizeRemovalTrackingOperational("AAA111, BBB222");
  assert(conflict.status === "multi_conflict", `conflict status: ${conflict.status}`);
  assert(conflict.operational === null, "conflict must not pick first");

  const single = normalizeRemovalTrackingOperational("  TN999  ");
  assert(single.status === "single" && single.operational === "TN999", "trim single");

  assert(isDirtyRemovalTrackingOperational("a, a"), "dirty repeated");
  assert(!isDirtyRemovalTrackingOperational("clean"), "clean not dirty");

  console.log("verify:removal-tracking-normalize — all checks passed");
}

main();
