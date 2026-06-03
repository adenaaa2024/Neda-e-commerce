"use client";

import Link from "next/link";

import { ClaimEnginePageShell } from "@/components/claim-engine/ClaimEnginePageShell";
import { ClaimReviewReadOnlyQueue } from "@/components/claim-engine/ClaimReviewReadOnlyQueue";
import {
  CLAIM_ENGINE_BANNER_WARNING_CLASS,
  CLAIM_ENGINE_MAIN_CLASS,
} from "@/components/claim-engine/claim-engine-ui";
import { useUserRole } from "@/components/UserRoleContext";

export function ClaimReviewReadOnlyPage() {
  const { actorUserId, organizationId, role } = useUserRole();

  return (
    <main className={CLAIM_ENGINE_MAIN_CLASS}>
    <ClaimEnginePageShell
      title="Review"
      description="Holds, missing product links, evidence gaps, and grouping warnings. Read-only until review workflow flags are enabled."
    >
      <div className={CLAIM_ENGINE_BANNER_WARNING_CLASS}>
        <p className="font-semibold">Full review workflow disabled</p>
        <p className="mt-1 text-xs leading-relaxed">
          Set <code className="rounded bg-amber-100/80 px-1 dark:bg-amber-900/50">ENABLE_CLAIM_DRAFTS_REVIEW=true</code> and{" "}
          <code className="rounded bg-amber-100/80 px-1 dark:bg-amber-900/50">ENABLE_CLAIM_REVIEW_WORKFLOW=true</code>, then
          redeploy. Until then, use the read-only queue below (physical scans) or{" "}
          <Link href="/claim-engine/inbox" className="claim-engine-link">
            Intake
          </Link>{" "}
          for import candidates.
        </p>
      </div>

      <ClaimReviewReadOnlyQueue
        actorProfileId={actorUserId}
        filterOrganizationId={role === "super_admin" ? organizationId : undefined}
      />
    </ClaimEnginePageShell>
    </main>
  );
}
