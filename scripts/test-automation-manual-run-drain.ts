import assert from "node:assert/strict";

import {
  isTerminalManualRunState,
  manualRunNeedsClientDrain,
  manualRunCompletionMessage,
} from "../lib/platform-automation-manual-run-ui";

assert.equal(isTerminalManualRunState("complete"), true);
assert.equal(isTerminalManualRunState("synced"), true);
assert.equal(isTerminalManualRunState("failed"), true);
assert.equal(isTerminalManualRunState("synthetic_upload_ready"), false);

assert.equal(manualRunNeedsClientDrain({ needs_resume: true }), true);
assert.equal(manualRunNeedsClientDrain({ state: "synthetic_upload_ready" }), true);
assert.equal(manualRunNeedsClientDrain({ state: "complete" }), false);

const timeoutMsg = manualRunCompletionMessage({
  drain: {
    ok: false,
    error: "timed out",
    steps: 3,
    needs_manual_resume: true,
    state: "synthetic_upload_ready",
  },
  label: "Removal order",
});
assert.match(timeoutMsg, /Resume/);

const doneMsg = manualRunCompletionMessage({
  drain: {
    ok: true,
    final: {
      ok: true,
      data: { state: "complete" },
      httpStatus: 200,
      accepted: false,
      has_execution_evidence: true,
    },
    steps: 2,
    terminal_state: "complete",
  },
  label: "Removal shipment",
});
assert.match(doneMsg, /completed/);

console.log("ok automation-manual-run-drain");
