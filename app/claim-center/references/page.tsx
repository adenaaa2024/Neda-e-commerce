"use client";

import { ClaimCenterSectionView } from "@/components/claim-center/ClaimCenterSectionView";
import { CLAIM_CENTER_SECTION_EMPTY } from "@/lib/claims/center/claim-center-ui-copy";

export default function ClaimCenterReferencesPage() {
  return (
    <ClaimCenterSectionView
      pageId="references"
      apiPath="/api/claims/center/references"
      emptyState={CLAIM_CENTER_SECTION_EMPTY.references}
      defaultViewMode="card"
    />
  );
}
