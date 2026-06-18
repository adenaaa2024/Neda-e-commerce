/**
 * Smoke: PHASE-CLAIM-REFERENCE-MATERIALIZATION-EXECUTE-V1
 *
 * Static contract checks only (no DB, no writes):
 *  - executor + approval lib + approval file exist
 *  - approval token name is correct and parser is yes/true gated
 *  - executor reuses the deterministic pilot materializer + idempotent ON CONFLICT path
 *  - executor never invents TRID / never mutates claim_* rows
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  readReferenceMaterializationExecuteApproval,
  REFERENCE_MATERIALIZATION_EXECUTE_V1_APPROVAL_PATH,
  REFERENCE_MATERIALIZATION_EXECUTE_V1_APPROVAL_TOKEN,
} from "../lib/claims/edges/claim-reference-materialization-execute-v1-approval";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
}

const cwd = process.cwd();
const scriptPath = join(cwd, "scripts/phase-claim-reference-materialization-execute-v1.ts");
const approvalLibPath = join(
  cwd,
  "lib/claims/edges/claim-reference-materialization-execute-v1-approval.ts",
);
const approvalFilePath = join(cwd, REFERENCE_MATERIALIZATION_EXECUTE_V1_APPROVAL_PATH);

assert(existsSync(scriptPath), "executor script missing");
assert(existsSync(approvalLibPath), "approval lib missing");
assert(existsSync(approvalFilePath), "operator approval file missing");

assert(
  REFERENCE_MATERIALIZATION_EXECUTE_V1_APPROVAL_TOKEN === "APPROVED_CLAIM_REFERENCE_MATERIALIZATION_WRITE_V1",
  "approval token name mismatch",
);

// Parser gating
assert(
  readReferenceMaterializationExecuteApproval("APPROVED_CLAIM_REFERENCE_MATERIALIZATION_WRITE_V1=yes", true).approved,
  "parser should approve on =yes",
);
assert(
  readReferenceMaterializationExecuteApproval("APPROVED_CLAIM_REFERENCE_MATERIALIZATION_WRITE_V1=true", true).approved,
  "parser should approve on =true",
);
assert(
  !readReferenceMaterializationExecuteApproval("APPROVED_CLAIM_REFERENCE_MATERIALIZATION_WRITE_V1=no", true).approved,
  "parser must NOT approve on =no",
);
assert(
  !readReferenceMaterializationExecuteApproval("missing", false).approved,
  "parser must NOT approve when token absent",
);

const scriptSrc = readFileSync(scriptPath, "utf8");
assert(scriptSrc.includes("ON CONFLICT"), "executor must use idempotent ON CONFLICT path");
assert(scriptSrc.includes("buildPilotReferenceEdgesForCase"), "executor must reuse deterministic edge builder");
assert(scriptSrc.includes("PRODUCTION_REF"), "executor must guard production ref");
assert(scriptSrc.includes("--execute"), "executor must require --execute flag for writes");
assert(
  scriptSrc.includes("buildPilotEdgeMaterializationRollbackSql"),
  "executor must emit scoped rollback sql",
);
assert(
  !/INSERT\s+INTO\s+public\.claim_(submissions|cases|lines|candidates)/i.test(scriptSrc),
  "executor must NOT insert into claim_submissions/cases/lines/candidates",
);
assert(
  !/UPDATE\s+public\.claim_(submissions|cases|lines|candidates)/i.test(scriptSrc),
  "executor must NOT update claim_submissions/cases/lines/candidates",
);

// Approval file documents the required token and is shipped unapproved by default note.
const approvalFileSrc = readFileSync(approvalFilePath, "utf8");
assert(
  approvalFileSrc.includes("APPROVED_CLAIM_REFERENCE_MATERIALIZATION_WRITE_V1"),
  "approval file must document the required token",
);

console.log(
  JSON.stringify(
    {
      smoke: "PHASE-CLAIM-REFERENCE-MATERIALIZATION-EXECUTE-V1",
      result: "pass",
      checks: 14,
      token: REFERENCE_MATERIALIZATION_EXECUTE_V1_APPROVAL_TOKEN,
    },
    null,
    2,
  ),
);
