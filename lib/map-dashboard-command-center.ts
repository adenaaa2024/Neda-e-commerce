import type {
  CommandCenterSnapshot,
  DashboardSnapshot,
  ReturnsAnalyticsPayload,
} from "@/app/returns/returns-action-types";

/**
 * Maps existing dashboard loaders into {@link CommandCenterSnapshot} for the command center UI.
 * Chart/action-queue fields stay empty until a dedicated loader exists — KPIs still render.
 */
export function mapDashboardToCommandCenter(
  snap: DashboardSnapshot | null,
  analytics: ReturnsAnalyticsPayload | null,
): CommandCenterSnapshot | null {
  if (!snap) return null;
  return {
    returnsToday: snap.returnsToday,
    openPackageCount: snap.packageCount,
    openPalletCount: snap.palletCount,
    expectedItemsTotal: 0,
    scannedItemsTotal: analytics?.totalReturns ?? 0,
    readyClaimsValueUsd: 0,
    missingEvidenceCount: 0,
    needsProductLinkCount: 0,
    returnsTrend7d: [],
    returnsTrend30d: [],
    productLinkage: { resolved: 0, unresolved: 0 },
    claimFunnel: [],
    actionQueue: [],
    health: {
      lastSyncAt: null,
      lastProductUpdateAt: null,
      apiAutomationStatus: "Use Returns / Claim Engine links below for live workflows.",
      importErrorsCount: 0,
    },
    claimsReadyToSend: snap.claimsReadyToSend,
    returnsEstimatedValueUsd: snap.returnsEstimatedValueUsd,
  };
}
