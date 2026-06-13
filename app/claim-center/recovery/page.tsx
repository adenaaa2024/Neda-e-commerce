"use client";

import { ClaimCenterSectionView } from "@/components/claim-center/ClaimCenterSectionView";
import { CLAIM_CENTER_SECTION_EMPTY } from "@/lib/claims/center/claim-center-ui-copy";

export default function ClaimCenterRecoveryPage() {
  return (
    <ClaimCenterSectionView
      pageId="recovery"
      apiPath="/api/claims/center/recovery"
      emptyState={CLAIM_CENTER_SECTION_EMPTY.recovery}
      defaultViewMode="card"
    />
  );
}
