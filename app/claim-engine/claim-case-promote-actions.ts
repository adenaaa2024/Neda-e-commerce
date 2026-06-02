"use server";

import { promoteClaimCaseToSubmissionPackage } from "@/lib/claim-case-promote-submission";
import { resolveTenantListScope, type TenantQueryOpts } from "@/lib/server-tenant";
import { isUuidString } from "@/lib/uuid";

export async function promoteClaimCaseToSubmission(
  claimCaseId: string,
  opts?: {
    tenant?: TenantQueryOpts;
    actorProfileId?: string | null;
    generatePdf?: boolean;
  },
) {
  const scope = await resolveTenantListScope(opts?.tenant);
  if (scope.mode !== "single") {
    return { ok: false, error: "Select a single organization." };
  }
  if (!isUuidString(claimCaseId)) {
    return { ok: false, error: "Invalid claim case id." };
  }
  return promoteClaimCaseToSubmissionPackage(claimCaseId, {
    organizationId: scope.organizationId,
    actorProfileId: opts?.actorProfileId ?? null,
    generatePdf: opts?.generatePdf,
  });
}
