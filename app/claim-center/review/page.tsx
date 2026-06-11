"use client";

import { ClaimCenterSectionView } from "@/components/claim-center/ClaimCenterSectionView";

export default function ClaimCenterReviewPage() {
  return (
    <ClaimCenterSectionView
      title="Review queue"
      description="Opportunities that need human review — product linkage, reference conflicts, or incomplete evidence."
      apiPath="/api/claims/center/review"
    />
  );
}
