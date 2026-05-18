/**
 * NEXT-CLAIM-EVIDENCE-04 — Operator approval gate for CCE graph writes (dev/staging only).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CLAIM_EVIDENCE_04_APPROVAL_PATH = join(
  process.cwd(),
  ".cursor/operator-approvals/claim-evidence-04-dev-staging-write-approval.md",
);

export const CLAIM_EVIDENCE_04_STAGING_REF = "kxsvedvpjldygtdbylsy";

const APPROVAL_FLAG = /^APPROVED_TO_WRITE_CLAIM_EVIDENCE_04_DEV_STAGING\s*=\s*true\s*$/im;

export function isClaimEvidence04WriteApproved(): boolean {
  if (!existsSync(CLAIM_EVIDENCE_04_APPROVAL_PATH)) return false;
  const content = readFileSync(CLAIM_EVIDENCE_04_APPROVAL_PATH, "utf8");
  return APPROVAL_FLAG.test(content);
}

export function assertClaimEvidence04StagingUrl(supabaseUrl: string): void {
  if (!supabaseUrl.includes(CLAIM_EVIDENCE_04_STAGING_REF)) {
    throw new Error(
      `BLOCKED: Supabase URL must target dev/staging project ${CLAIM_EVIDENCE_04_STAGING_REF}.`,
    );
  }
}
