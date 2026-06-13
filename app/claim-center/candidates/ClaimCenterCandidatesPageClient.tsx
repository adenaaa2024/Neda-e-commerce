"use client";

import { useSearchParams } from "next/navigation";

import { ClaimCenterHiddenRowsNotice } from "@/components/claim-center/ClaimCenterHiddenRowsNotice";
import { ClaimCenterSectionView } from "@/components/claim-center/ClaimCenterSectionView";
import {
  CLAIM_CENTER_CANDIDATE_FILTERS,
  parseCandidateFilter,
} from "@/lib/claims/center/claim-center-filter-presets";

export default function ClaimCenterCandidatesPageClient() {
  const searchParams = useSearchParams();
  const filter = parseCandidateFilter(searchParams.get("filter"));
  const preset = CLAIM_CENTER_CANDIDATE_FILTERS[filter];

  return (
    <ClaimCenterSectionView
      pageId={filter === "needs_review" ? "review" : "pool"}
      apiPath={preset.apiPath}
      extraParams={preset.extraParams}
      itemsKey={preset.itemsKey}
      emptyState={preset.emptyState}
      defaultViewMode="card"
      banner={filter === "all" ? <ClaimCenterHiddenRowsNotice /> : undefined}
    />
  );
}
