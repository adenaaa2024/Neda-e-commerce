"use client";

import { ClaimCenterSectionView } from "@/components/claim-center/ClaimCenterSectionView";

export default function ClaimCenterRecoveryPage() {
  return (
    <ClaimCenterSectionView
      title="Recovery"
      description="Financial recovery signals — reimbursements, settlements, transactions, and ORBIT-FRA carry-forward rows."
      apiPath="/api/claims/center/recovery"
    />
  );
}
