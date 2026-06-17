/**
 * Server-only manual filing write approval gate (reads operator approval file).
 */
import "server-only";

import fs from "node:fs";
import path from "node:path";

export const MANUAL_FILING_WRITE_APPROVAL_PATH =
  ".cursor/operator-approvals/manual-filing-status-entry-write-v1-approval.md";

export const MANUAL_FILING_WRITE_APPROVAL_KEY = "APPROVED_MANUAL_FILING_STATUS_ENTRY_WRITE_V1";

export type ManualFilingWriteApprovalStatus = {
  write: "approved" | "denied" | "missing";
  write_enabled: boolean;
  default_mode: "dry_run_preview";
};

function readApprovalKey(filePath: string, key: string): "approved" | "missing" | "denied" {
  const p = path.join(process.cwd(), filePath);
  if (!fs.existsSync(p)) return "missing";
  const raw = fs.readFileSync(p, "utf8");
  if (new RegExp(`^${key}\\s*=\\s*yes\\s*$`, "im").test(raw)) return "approved";
  return "denied";
}

export function readManualFilingWriteApprovalStatus(
  approvalPath = MANUAL_FILING_WRITE_APPROVAL_PATH,
): ManualFilingWriteApprovalStatus {
  const write = readApprovalKey(approvalPath, MANUAL_FILING_WRITE_APPROVAL_KEY);
  return {
    write,
    write_enabled: write === "approved",
    default_mode: "dry_run_preview",
  };
}
