/**
 * Unit checks for lib/pipeline/removal-carrier-normalize.ts
 *
 *   npm run verify:removal-carrier-normalize
 */
import {
  normalizeRemovalCarrierOperational,
  isDirtyRemovalCarrierOperational,
} from "../lib/pipeline/removal-carrier-normalize";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function main(): void {
  const dedupe = normalizeRemovalCarrierOperational("UPS, UPS, UPS");
  assert(dedupe.status === "deduped_repeated", `dedupe status: ${dedupe.status}`);
  assert(dedupe.operational === "UPS", `dedupe operational: ${dedupe.operational}`);

  const caseDedupe = normalizeRemovalCarrierOperational("ups, UPS");
  assert(caseDedupe.status === "deduped_repeated", `case dedupe: ${caseDedupe.status}`);
  assert(caseDedupe.operational === "ups", `case operational: ${caseDedupe.operational}`);

  const conflict = normalizeRemovalCarrierOperational("UPS, FedEx");
  assert(conflict.status === "multi_conflict", `conflict status: ${conflict.status}`);
  assert(conflict.operational === null, "conflict must not pick first");

  assert(isDirtyRemovalCarrierOperational("UPS, UPS"), "dirty repeated");
  assert(!isDirtyRemovalCarrierOperational("UPS"), "clean not dirty");

  console.log("verify:removal-carrier-normalize — all checks passed");
}

main();
