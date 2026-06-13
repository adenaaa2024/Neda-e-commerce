"use client";

import { ClaimCenterSectionView } from "@/components/claim-center/ClaimCenterSectionView";
import { CLAIM_CENTER_CANDIDATE_FILTERS } from "@/lib/claims/center/claim-center-filter-presets";

const REVIEW_PRESET = CLAIM_CENTER_CANDIDATE_FILTERS.needs_review;

/**
 * Backward-compatible /claim-center/review alias — same data as candidates?filter=needs_review.
 */
export default function ClaimCenterReviewAliasClient() {
  return (
    <>
      <p className="mb-4 rounded-xl border border-slate-500/20 bg-slate-500/5 px-4 py-2 text-xs opacity-80">
        Backward-compatible review alias. Primary navigation uses{" "}
        <span className="font-mono">/claim-center/candidates?filter=needs_review</span>.
      </p>
      <ClaimCenterSectionView
        pageId="review"
        apiPath={REVIEW_PRESET.apiPath}
        extraParams={REVIEW_PRESET.extraParams}
        itemsKey={REVIEW_PRESET.itemsKey}
        emptyState={REVIEW_PRESET.emptyState}
        defaultViewMode="card"
      />
    </>
  );
}
