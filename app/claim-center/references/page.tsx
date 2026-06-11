"use client";

import { ClaimCenterSectionView } from "@/components/claim-center/ClaimCenterSectionView";

export default function ClaimCenterReferencesPage() {
  return (
    <ClaimCenterSectionView
      title="Amazon references"
      description="TRID and financial reference edges materialized per opportunity. Reference conflicts are surfaced explicitly."
      apiPath="/api/claims/center/references"
    />
  );
}
