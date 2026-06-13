"use client";

import type { ReactNode } from "react";

import { MenorixModuleAppShell } from "@/components/menorix";

import { CLAIM_CENTER_MAIN_CLASS } from "./claim-center-ui";
import { ClaimCenterFlowCountsProvider } from "./ClaimCenterFlowCountsProvider";
import { ClaimCenterMobileLifecycleHeader } from "./ClaimCenterMobileLifecycleHeader";
import { ClaimCenterMobileNav } from "./ClaimCenterMobileNav";
import { ClaimCenterWorkflowBar } from "./ClaimCenterWorkflowBar";

/**
 * Claim Center flow navigation shell — horizontal workflow bar, no inner desktop rail.
 * ERP AppShell sidebar remains the only vertical app navigation.
 */
export function ClaimCenterAppShell({
  scopeBar,
  detailDrawer,
  lockedOverlay,
  children,
}: {
  scopeBar?: ReactNode;
  detailDrawer?: ReactNode;
  lockedOverlay?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ClaimCenterFlowCountsProvider>
      <MenorixModuleAppShell
        namespaceClass={`${CLAIM_CENTER_MAIN_CLASS} claim-center-view claim-center-app-shell claim-center-flow-shell`}
        moduleTitle="Claim Center"
        lockedOverlay={lockedOverlay}
        scopeBar={scopeBar}
        sectionNav={[]}
        showSectionTabs={false}
        fullWidth
        hideRail
        mobileNavigation={<ClaimCenterMobileNav />}
        detailDrawer={detailDrawer}
      >
        <ClaimCenterWorkflowBar />
        <ClaimCenterMobileLifecycleHeader />
        {children}
      </MenorixModuleAppShell>
    </ClaimCenterFlowCountsProvider>
  );
}
