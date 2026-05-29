import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APPROVAL_PATH = join(
  process.cwd(),
  ".cursor/operator-approvals/async-job-orchestration-phase1-approval.md",
);

export function readAsyncJobPhase1Approval(): {
  approved: boolean;
  staging: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (!existsSync(APPROVAL_PATH)) {
    return { approved: false, staging: false, reasons: ["approval_file_missing"] };
  }
  const text = readFileSync(APPROVAL_PATH, "utf8");
  const staging = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const phase1 = /APPROVED_ASYNC_JOB_ORCHESTRATION_PHASE1\s*=\s*true/i.test(text);
  if (!staging) reasons.push("APPROVED_TO_RUN_STAGING_not_true");
  if (!phase1) reasons.push("APPROVED_ASYNC_JOB_ORCHESTRATION_PHASE1_not_true");
  return { approved: staging && phase1, staging, reasons };
}

export function assertAsyncJobPhase1Approved(): void {
  const gate = readAsyncJobPhase1Approval();
  if (!gate.approved) {
    throw new Error(
      `Async job phase 1 blocked: ${gate.reasons.join(", ")} — set flags in ${APPROVAL_PATH}`,
    );
  }
}
