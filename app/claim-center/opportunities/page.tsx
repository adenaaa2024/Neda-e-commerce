"use client";

import { ClaimCenterSectionView } from "@/components/claim-center/ClaimCenterSectionView";

export default function ClaimCenterOpportunitiesPage() {
  return (
    <ClaimCenterSectionView
      title="Opportunities"
      description="High-value claim opportunities sorted by recoverable amount and filing deadline urgency."
      apiPath="/api/claims/center/opportunities"
    />
  );
}
