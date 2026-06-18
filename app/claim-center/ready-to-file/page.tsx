import { ReadyToFileView } from "@/components/claim-center/ready-to-file/ReadyToFileView";

export const metadata = {
  title: "Ready to File · Claim Center",
  description:
    "Prepared claim packets ready for manual Seller Central filing. No Amazon submission is performed by MENORIX.",
};

export default function ClaimCenterReadyToFilePage() {
  return <ReadyToFileView />;
}
