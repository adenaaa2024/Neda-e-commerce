/**
 * Command center health import picker — static unit checks.
 */
import assert from "node:assert/strict";

import {
  healthImportErrorsHint,
  pickHealthImportRow,
} from "../lib/command-center-health";

assert.deepEqual(
  pickHealthImportRow([
    { created_at: "2026-05-28T19:49:19Z", report_type: "REMOVAL_SHIPMENT", status: "failed" },
    { created_at: "2026-05-28T19:45:48Z", report_type: "REMOVAL_ORDER", status: "synced" },
  ]),
  { created_at: "2026-05-28T19:45:48Z", report_type: "REMOVAL_ORDER", status: "synced" },
);

assert.equal(healthImportErrorsHint("failed"), "Last import status: failed");
assert.equal(healthImportErrorsHint("synced"), null);

console.log(JSON.stringify({ ok: true, prompt: "test-command-center-health-import-pick" }, null, 2));
