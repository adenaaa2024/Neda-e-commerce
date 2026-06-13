"use client";

import { MenorixModuleAutomationHealthCard, type MenorixAutomationHealth } from "@/components/menorix";
import type { ClaimCenterDashboardKpis, ClaimCenterQueryMeta, ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";
import { getClaimCenterV2Page } from "@/lib/claims/center/claim-center-v2-page-contract";
import {
  CLAIM_CENTER_SECTION_EMPTY,
  resolveSectionEmptyState,
} from "@/lib/claims/center/claim-center-ui-copy";

import { ClaimCenterAttentionList } from "./ClaimCenterAttentionList";
import { ClaimCenterBridgePhaseNotice } from "./ClaimCenterBridgePhaseNotice";
import { ClaimCenterCommandBoard } from "./ClaimCenterCommandBoard";
import { ClaimCenterCommandHomeTiles } from "./ClaimCenterCommandHomeTiles";
import { ClaimCenterDataReadinessBanner } from "./ClaimCenterDataReadinessBanner";
import { ClaimCenterSampleWarningBanner } from "./ClaimCenterSampleWarningBanner";
import { ClaimCenterSectionEmptyState } from "./ClaimCenterSectionEmptyState";
import { ClaimCenterV2PageShell } from "./ClaimCenterV2PageShell";

type Props = {
  kpis: ClaimCenterDashboardKpis;
  opportunities: ClaimCenterV1Row[];
  meta?: ClaimCenterQueryMeta | null;
  referenceConflictCount?: number;
  automationHealth?: MenorixAutomationHealth;
  onSelectRow?: (row: ClaimCenterV1Row) => void;
};

export function ClaimCenterCommandDashboard({
  kpis,
  opportunities,
  meta,
  referenceConflictCount = 0,
  automationHealth,
  onSelectRow,
}: Props) {
  const home = getClaimCenterV2Page("home");
  const poolEmpty = kpis.total_active === 0;

  const defaultAutomation: MenorixAutomationHealth = {
    status: "unknown",
    label: "Loading",
    detail: "Automation status unavailable.",
  };

  const attentionEmpty = resolveSectionEmptyState(CLAIM_CENTER_SECTION_EMPTY.dashboard_opportunities, {
    poolEmpty,
  });

  return (
    <ClaimCenterV2PageShell
      contract={home}
      dataBanner={
        <ClaimCenterDataReadinessBanner
          meta={meta}
          totalActive={kpis.total_active}
          automationHealth={automationHealth}
        />
      }
    >
      <ClaimCenterSampleWarningBanner meta={meta} />

      <ClaimCenterCommandBoard kpis={kpis} referenceConflictCount={referenceConflictCount} />

      <ClaimCenterCommandHomeTiles kpis={kpis} referenceConflictCount={referenceConflictCount} />

      <div className="grid gap-6 lg:grid-cols-[1fr_minmax(260px,320px)]">
        <section className="space-y-3">
          <h2 className="text-base font-semibold">Attention list</h2>
          <p className="text-xs opacity-60">
            Trusted opportunities — ranked by deadline, exposure, and blockers. No duplicate scanner/ORBIT twins.
          </p>
          {opportunities.length === 0 ? (
            <ClaimCenterSectionEmptyState config={attentionEmpty} />
          ) : (
            <ClaimCenterAttentionList rows={opportunities} onSelect={onSelectRow} />
          )}
        </section>

        <aside className="space-y-4">
          <MenorixModuleAutomationHealthCard health={automationHealth ?? defaultAutomation} />
          <div className="claim-center-card rounded-xl p-4 text-sm transition-shadow hover:shadow-sm">
            <h3 className="font-semibold">Source health</h3>
            <p className="mt-1 text-xs opacity-70">
              {automationHealth?.last_run_at
                ? `Last generator activity ${new Date(automationHealth.last_run_at).toLocaleString()}`
                : "No recent generator activity recorded."}
            </p>
            {automationHealth?.enabled_sources?.length ? (
              <p className="mt-2 text-xs opacity-65">
                {automationHealth.enabled_sources.length} trusted source
                {automationHealth.enabled_sources.length === 1 ? "" : "s"} enabled
              </p>
            ) : null}
            {automationHealth?.warnings?.map((w) => (
              <p key={w} className="mt-1 text-xs text-amber-800 dark:text-amber-200">
                {w}
              </p>
            ))}
            <a href="/claim-center/sources" className="mt-2 inline-block text-xs font-semibold underline opacity-80">
              View Sources →
            </a>
          </div>
        </aside>
      </div>

      <ClaimCenterBridgePhaseNotice />

      <p className="text-xs opacity-60">
        Money totals include only known positive amounts at intake. Missing unit cost shows as &quot;Cost unknown&quot; or
        &quot;Unpriced&quot; — never summed as zero. Observed reimbursement reflects imports, not Menorix filing.
      </p>
    </ClaimCenterV2PageShell>
  );
}
