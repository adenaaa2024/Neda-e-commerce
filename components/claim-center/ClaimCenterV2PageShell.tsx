import type { ReactNode } from "react";

import type { ClaimCenterV2PageContract } from "@/lib/claims/center/claim-center-v2-page-contract";

import { CLAIM_CENTER_PAGE_CLASS } from "./claim-center-ui";
import { ClaimCenterFlowPositionHeader } from "./ClaimCenterFlowPositionHeader";

export function ClaimCenterV2PageShell({
  contract,
  children,
  banner,
  dataBanner,
}: {
  contract: ClaimCenterV2PageContract;
  children: ReactNode;
  banner?: ReactNode;
  dataBanner?: ReactNode;
}) {
  return (
    <div className={`${CLAIM_CENTER_PAGE_CLASS} claim-center-v2-page`}>
      <ClaimCenterFlowPositionHeader contract={contract} />
      {dataBanner}
      {banner}
      <div className="claim-center-v2-page__body mt-6 space-y-6">{children}</div>
    </div>
  );
}
