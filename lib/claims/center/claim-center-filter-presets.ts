import type { ClaimCenterSectionEmptyConfig } from "./claim-center-ui-copy";
import { CLAIM_CENTER_SECTION_EMPTY } from "./claim-center-ui-copy";

export type ClaimCenterCandidateFilter = "needs_review" | "all";

export type ClaimCenterFilterPreset = {
  id: ClaimCenterCandidateFilter;
  title: string;
  description: string;
  apiPath: string;
  extraParams?: Record<string, string>;
  itemsKey?: string;
  emptyState: ClaimCenterSectionEmptyConfig;
};

export const CLAIM_CENTER_CANDIDATE_FILTERS: Record<ClaimCenterCandidateFilter, ClaimCenterFilterPreset> = {
  all: {
    id: "all",
    title: "All candidates",
    description: "Full opportunity pool from scheduled scans and live triggers.",
    apiPath: "/api/claims/inbox",
    extraParams: { view: "center_v1", include_legacy_seed: "0", include_quarantined: "0" },
    itemsKey: "items",
    emptyState: CLAIM_CENTER_SECTION_EMPTY.candidates,
  },
  needs_review: {
    id: "needs_review",
    title: "Review queue",
    description:
      "Opportunities needing human review — product match, reference conflicts, or incomplete evidence.",
    apiPath: "/api/claims/center/review",
    emptyState: CLAIM_CENTER_SECTION_EMPTY.review,
  },
};

export function parseCandidateFilter(raw: string | null | undefined): ClaimCenterCandidateFilter {
  if (raw === "needs_review") return "needs_review";
  return "all";
}
