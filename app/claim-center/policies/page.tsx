"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { getOrganizationClaimSettingsBundle } from "@/app/settings/organization-claim-policy-actions";
import { ClaimCenterBridgePhaseNotice } from "@/components/claim-center/ClaimCenterBridgePhaseNotice";
import { ClaimCenterV2PageShell } from "@/components/claim-center/ClaimCenterV2PageShell";
import { getClaimCenterV2Page } from "@/lib/claims/center/claim-center-v2-page-contract";
import { ClaimCenterPolicySnapshotPanel } from "@/components/claim-center/ClaimCenterPolicySnapshotPanel";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import { buildPolicySnapshotGroups } from "@/lib/claims/center/claim-center-policy-ownership";

export default function ClaimCenterPolicySnapshotPage() {
  const { organizationId, moduleAccess } = useClaimCenter();
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<ReturnType<typeof buildPolicySnapshotGroups>>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await getOrganizationClaimSettingsBundle({ organizationId });
    setGroups(
      buildPolicySnapshotGroups({
        policy: data.policy,
        workflow: data.workflow,
        autoCreateDrafts: data.auto_create_drafts_on_scan,
        claimRecoveryEnabled: moduleAccess?.enabled,
        moduleAccessReason: moduleAccess?.reason,
      }),
    );
    setLoading(false);
  }, [organizationId, moduleAccess]);

  useEffect(() => {
    void load();
  }, [load]);

  const contract = getClaimCenterV2Page("policies");

  return (
    <ClaimCenterV2PageShell contract={contract}>
      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading effective rules…
        </div>
      ) : (
        <ClaimCenterPolicySnapshotPanel groups={groups} />
      )}

      <div className="mt-4">
        <ClaimCenterBridgePhaseNotice compact />
      </div>
    </ClaimCenterV2PageShell>
  );
}
