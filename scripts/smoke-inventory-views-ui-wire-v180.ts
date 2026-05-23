/**
 * smoke:inventory-views-ui-wire-v180 — static + staging read probes (no writes).
 */
import { runInventoryViewsSmoke } from "./lib/neda-read-model-smoke-v181";

void runInventoryViewsSmoke().then((r) => {
  console.log(`smoke:inventory-views-ui-wire-v180 → ${r.overall}`);
  if (!r.pass) {
    for (const s of r.steps.filter((x) => !x.pass)) {
      console.error(`  FAIL ${s.id}: ${s.detail}`);
    }
  }
  process.exit(r.pass ? 0 : 1);
});
