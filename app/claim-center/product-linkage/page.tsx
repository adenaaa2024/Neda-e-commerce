"use client";

import { ClaimCenterSectionView } from "@/components/claim-center/ClaimCenterSectionView";
import { CLAIM_CENTER_SECTION_EMPTY } from "@/lib/claims/center/claim-center-ui-copy";

export default function ClaimCenterProductLinkagePage() {
  return (
    <ClaimCenterSectionView
      pageId="product_match"
      apiPath="/api/claims/center/product-linkage"
      emptyState={CLAIM_CENTER_SECTION_EMPTY.product_linkage}
      defaultViewMode="card"
    />
  );
}
