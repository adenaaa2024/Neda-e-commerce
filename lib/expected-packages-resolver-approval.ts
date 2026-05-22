/**
 * EXPECTED-PACKAGES-RESOLVER-BACKFILL-V180 — operator approval gate (staging only).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EXPECTED_PACKAGES_RESOLVER_V180_APPROVAL_PATH = join(
  process.cwd(),
  ".cursor/operator-approvals/expected-packages-resolver-backfill-v180-approval.md",
);

const APPROVAL_FLAG =
  /^APPROVED_TO_RUN_EXPECTED_PACKAGES_RESOLVER_BACKFILL_V180_STAGING\s*=\s*true\s*$/im;

export function isExpectedPackagesResolverBackfillV180Approved(): boolean {
  if (!existsSync(EXPECTED_PACKAGES_RESOLVER_V180_APPROVAL_PATH)) return false;
  return APPROVAL_FLAG.test(readFileSync(EXPECTED_PACKAGES_RESOLVER_V180_APPROVAL_PATH, "utf8"));
}
