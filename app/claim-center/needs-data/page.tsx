import { NeedsDataView } from "@/components/claim-center/needs-data/NeedsDataView";

export const metadata = {
  title: "Needs Data · Claim Center",
  description: "Read-only view of claim candidates blocked by missing data, grouped by blocker.",
};

export default function ClaimCenterNeedsDataPage() {
  return <NeedsDataView />;
}
