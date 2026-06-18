import { ClaimDataCoverageView } from "@/components/claim-center/data-coverage/ClaimDataCoverageView";

export const metadata = {
  title: "Data Coverage · Claim Center",
  description:
    "Read-only map of Amazon source files/tables/APIs powering each claim family, with coverage and live-sync plan. No Amazon calls.",
};

export default function ClaimCenterDataCoveragePage() {
  return <ClaimDataCoverageView />;
}
