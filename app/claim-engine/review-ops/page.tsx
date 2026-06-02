import { Suspense } from "react";
import { ClaimEngineFeatureDisabled } from "@/components/claim-engine/ClaimEngineFeatureDisabled";
import { isClaimDraftsReviewEnabled } from "../../../lib/claim-drafts-api";
import { isClaimReviewWorkflowEnabled } from "../../../lib/claim-review-workflow";
import { resolveOrganizationId } from "../../../lib/organization";
import { supabaseServer } from "../../../lib/supabase-server";
import { isUuidString } from "../../../lib/uuid";
import { ClaimReviewOperationsClient } from "./ClaimReviewOperationsClient";

export const dynamic = "force-dynamic";

export default async function ClaimReviewOperationsPage() {
  if (!isClaimDraftsReviewEnabled() || !isClaimReviewWorkflowEnabled()) {
    return (
      <ClaimEngineFeatureDisabled
        title="Claim review operations"
        description="Review manages TRID/import claim_candidate_drafts and operator work items (step 2 of the import path). This screen is disabled until both feature flags are enabled — the physical-scan path still works without it."
        envVars={[
          {
            name: "ENABLE_CLAIM_DRAFTS_REVIEW",
            description: "Read claim_candidate_drafts and draft review APIs.",
          },
          {
            name: "ENABLE_CLAIM_REVIEW_WORKFLOW",
            description: "Work-item queue, assignment, and bootstrap actions.",
          },
        ]}
        alternateHref={{ href: "/claim-engine/inbox", label: "Open import / Amazon candidate inbox →" }}
      />
    );
  }

  const organizationId = resolveOrganizationId();
  const { data: osRow } = await supabaseServer
    .from("organization_settings")
    .select("default_store_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const rawDefault = (osRow as { default_store_id?: string | null } | null)?.default_store_id;
  const defaultStoreId = typeof rawDefault === "string" && isUuidString(rawDefault) ? rawDefault : null;

  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-[1400px] p-4 text-sm text-slate-600 dark:text-slate-400">Loading review operations…</div>
      }
    >
      <ClaimReviewOperationsClient organizationId={organizationId} defaultStoreId={defaultStoreId} />
    </Suspense>
  );
}
