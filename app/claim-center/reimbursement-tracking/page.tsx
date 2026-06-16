import { ReimbursementTrackingView } from "@/components/claim-center/reimbursement-tracking/ReimbursementTrackingView";

export const metadata = {
  title: "Reimbursement Tracking · Claim Center",
  description: "Read-only financial recovery tracking for pilot claim submissions.",
};

export default function ClaimCenterReimbursementTrackingPage() {
  return <ReimbursementTrackingView />;
}
