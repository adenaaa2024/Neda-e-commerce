"use server";

import { isClaimDraftsReviewEnabled } from "@/lib/claim-drafts-api";
import { isClaimReviewWorkflowEnabled } from "@/lib/claim-review-workflow";

export async function getClaimEngineFeatureFlags(): Promise<{
  enable_claim_drafts_review: boolean;
  enable_claim_review_workflow: boolean;
}> {
  return {
    enable_claim_drafts_review: isClaimDraftsReviewEnabled(),
    enable_claim_review_workflow: isClaimReviewWorkflowEnabled(),
  };
}
