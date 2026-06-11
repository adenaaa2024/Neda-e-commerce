"use client";

import { ClaimCenterSectionView } from "@/components/claim-center/ClaimCenterSectionView";

export default function ClaimCenterProductLinkagePage() {
  return (
    <ClaimCenterSectionView
      title="Product linkage"
      description="Opportunities blocked or delayed because product identifiers do not resolve to catalog. Product Story links appear only when linkage is safe."
      apiPath="/api/claims/center/product-linkage"
    />
  );
}
