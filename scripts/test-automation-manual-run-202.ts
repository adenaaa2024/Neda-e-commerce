import assert from "node:assert/strict";

import {
  isAutomationManualRunHttpSuccess,
  manualRunAcceptanceMessage,
  manualRunHasExecutionEvidence,
} from "../lib/platform-automation-manual-run-ui";

assert.equal(isAutomationManualRunHttpSuccess(200), true);
assert.equal(isAutomationManualRunHttpSuccess(201), true);
assert.equal(isAutomationManualRunHttpSuccess(202), true);
assert.equal(isAutomationManualRunHttpSuccess(400), false);

const inProgress202 = {
  ok: false,
  upload_id: "11111111-1111-1111-1111-111111111111",
  state: "polling",
  needs_resume: true,
};

assert.equal(manualRunHasExecutionEvidence(inProgress202, 202), true);

const acceptedMsg = manualRunAcceptanceMessage({
  ok: true,
  data: inProgress202,
  httpStatus: 202,
  accepted: true,
  has_execution_evidence: true,
});
assert.match(acceptedMsg, /Run accepted \/ started/);

const localMsg = manualRunAcceptanceMessage(
  {
    ok: true,
    data: { ok: false, needs_resume: true, state: "requested" },
    httpStatus: 202,
    accepted: true,
    has_execution_evidence: false,
  },
  { localhostQueuedOnly: true },
);
assert.match(localMsg, /local dev/i);

console.log("ok automation-manual-run-202");
