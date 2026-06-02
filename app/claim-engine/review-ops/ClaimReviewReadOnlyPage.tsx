"use client";

import Link from "next/link";

import { ClaimEnginePageShell } from "@/components/claim-engine/ClaimEnginePageShell";
import { ClaimReviewReadOnlyQueue } from "@/components/claim-engine/ClaimReviewReadOnlyQueue";
import { useUserRole } from "@/components/UserRoleContext";

export function ClaimReviewReadOnlyPage() {
  const { actorUserId, organizationId, role } = useUserRole();

  return (
    <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-slate-50 dark:bg-slate-950">
    <ClaimEnginePageShell
      title="Review"
      description="Holds, missing product links, evidence gaps, and grouping warnings. Read-only until review workflow flags are enabled."
    >
      <div className="rounded-xl border border-amber-200 bg-amber-50/90 px-4 py-3 text-sm text-amber-950 dark:border-amber-800/50 dark:bg-amber-950/25 dark:text-amber-100">
        <p className="font-semibold">Full review workflow disabled</p>
        <p className="mt-1 text-xs leading-relaxed">
          Set <code className="rounded bg-amber-100/80 px-1 dark:bg-amber-900/50">ENABLE_CLAIM_DRAFTS_REVIEW=true</code> and{" "}
          <code className="rounded bg-amber-100/80 px-1 dark:bg-amber-900/50">ENABLE_CLAIM_REVIEW_WORKFLOW=true</code>, then
          redeploy. Until then, use the read-only queue below (physical scans) or{" "}
          <Link href="/claim-engine/inbox" className="font-medium underline">
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
