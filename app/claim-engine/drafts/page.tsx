import { ClaimEngineFeatureDisabled } from "@/components/claim-engine/ClaimEngineFeatureDisabled";
import { isClaimDraftsReviewEnabled } from "../../../lib/claim-drafts-api";
import { resolveOrganizationId } from "../../../lib/organization";
import { ClaimDraftsReviewClient } from "./ClaimDraftsReviewClient";

export const dynamic = "force-dynamic";

export default function ClaimDraftsReviewPage() {
  if (!isClaimDraftsReviewEnabled()) {
    return (
      <ClaimEngineFeatureDisabled
        title="Claim drafts review"
        description="Read-only staging view for claim_candidate_drafts (legacy TRID/import path). Disabled until the drafts review flag is on."
        envVars={[
          {
            name: "ENABLE_CLAIM_DRAFTS_REVIEW",
            description: "Expose claim_candidate_drafts list and detail APIs.",
          },
        ]}
        alternateHref={{ href: "/claim-engine/review-ops", label: "Open Review Ops (requires both flags) →" }}
      />
    );
  }

  const organizationId = resolveOrganizationId();
  return <ClaimDraftsReviewClient organizationId={organizationId} />;
}
