import { ClaimCaseReviewView } from "@/components/claim-center/case-review/ClaimCaseReviewView";

export const metadata = {
  title: "Case review · Claim Center",
  description: "Read-only review of pilot-created claim cases.",
};

export default function ClaimCenterCaseReviewPage() {
  return <ClaimCaseReviewView />;
}
