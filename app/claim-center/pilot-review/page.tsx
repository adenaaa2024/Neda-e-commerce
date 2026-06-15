import { ClaimPilotReviewView } from "@/components/claim-center/pilot/ClaimPilotReviewView";

export const metadata = {
  title: "Pilot review · Claim Center",
  description: "Read-only review of original emit pilot claim candidates.",
};

export default function ClaimCenterPilotReviewPage() {
  return <ClaimPilotReviewView />;
}
