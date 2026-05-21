/**
 * smoke:expected-packages-ui-wire-v179 — static + staging read probes (no writes).
 */
import { runExpectedPackagesSmoke } from "./lib/neda-read-model-smoke-v181";

void runExpectedPackagesSmoke().then((r) => {
  console.log(`smoke:expected-packages-ui-wire-v179 → ${r.overall}`);
  if (!r.pass) {
    for (const s of r.steps.filter((x) => !x.pass)) {
      console.error(`  FAIL ${s.id}: ${s.detail}`);
    }
  }
  process.exit(r.pass ? 0 : 1);
});
