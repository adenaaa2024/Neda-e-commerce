"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import Link from "next/link";

import { getOrganizationClaimSettingsBundle } from "@/app/settings/organization-claim-policy-actions";
import {
  buildClaimSettingsOverviewRows,
  ClaimSettingsOverviewPanel,
} from "@/components/claim-center/ClaimSettingsOverviewPanel";
import { ClaimCenterPageShell } from "@/components/claim-center/ClaimCenterPageShell";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";

export default function ClaimCenterSettingsPage() {
  const { organizationId, moduleAccess } = useClaimCenter();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ReturnType<typeof buildClaimSettingsOverviewRows>>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await getOrganizationClaimSettingsBundle({ organizationId });
    setRows(
      buildClaimSettingsOverviewRows({
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

  return (
    <ClaimCenterPageShell
      title="Settings overview"
      description="Read-only policy snapshot for Claim Center. No writes in V1."
      showHub={false}
    >
      <p className="text-sm">
        <Link href="/settings" className="font-medium underline opacity-80">
          Open workspace settings
        </Link>
      </p>
      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <ClaimSettingsOverviewPanel rows={rows} />
      )}
    </ClaimCenterPageShell>
  );
}
