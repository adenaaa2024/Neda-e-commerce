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
        title="Review"
        description="Operator review for import/TRID claim_candidate_drafts: mixed groups, missing evidence, product link gaps, policy holds, and duplicate candidates. Disabled until feature flags are on — intake and physical-scan draft pool still work."
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
        previewSlices={[
          "Mixed groups needing split before case creation",
          "Missing evidence on import drafts",
          "Missing product link (PIM resolution)",
          "Policy / cutoff holds (claim_start_date, scan_go_live_date)",
          "Duplicate candidates across sources",
        ]}
        alternateHref={{ href: "/claim-engine/inbox", label: "Open claim intake →" }}
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
    <ClaimReviewOperationsClient organizationId={organizationId} defaultStoreId={defaultStoreId} />
  );
}
