"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, Layers, Package } from "lucide-react";

import { ClaimCenterBridgePhaseNotice } from "@/components/claim-center/ClaimCenterBridgePhaseNotice";
import { ClaimCenterSectionEmptyState } from "@/components/claim-center/ClaimCenterSectionEmptyState";
import { ClaimCenterV2PageShell } from "@/components/claim-center/ClaimCenterV2PageShell";
import { buildQueueClearState } from "@/lib/claims/center/claim-center-ui-copy";

const NOT_BUILT = buildQueueClearState("group_builder", {
  title: "Native grouping not built",
  appearsHere: "Physical-return grouping launcher — legacy path only.",
  whyEmpty: "Native grouping is not part of Claim Center V2 workflow navigation.",
  nextSteps: [
    "Use Returns draft pool via Legacy tools when physical-return grouping is required.",
    "Native grouping will ship in a future Claim Center release.",
  ],
});

export default function ClaimCenterGroupBuilderPage() {
  return (
    <ClaimCenterV2PageShell
      contract={{
        id: "pool",
        route: "/claim-center/group-builder",
        navLabel: "Returns grouping",
        question: "How should physical returns be grouped for filing?",
        dataSource: "Legacy returns draft pool — not native Claim Center",
        appearsHere: "Launcher links to the legacy returns grouping workflow.",
        whatToDoNext: "Use Legacy tools → Returns draft pool when physical-return grouping is required.",
        whyEmpty: "Native grouping is hidden from workflow until a future release ships it here.",
        helper: "This route is hidden from workflow navigation until native grouping exists.",
      }}
    >
      <div className="claim-center-card mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs">
        <p className="font-semibold text-amber-900 dark:text-amber-100">Legacy launcher</p>
        <p className="mt-1 opacity-90">
          Reach legacy grouping via <strong>Legacy tools → Returns draft pool</strong> when needed.
        </p>
      </div>

      <ClaimCenterSectionEmptyState config={NOT_BUILT} />

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <Link
          href="/returns/claims"
          className="claim-center-card flex items-center gap-3 rounded-xl p-4 transition-shadow hover:shadow-md"
        >
          <Package className="h-5 w-5 opacity-60" />
          <div className="flex-1">
            <p className="font-medium">Returns draft pool</p>
            <p className="text-xs opacity-65">Legacy physical-return grouping</p>
          </div>
          <ArrowRight className="h-4 w-4 opacity-50" />
        </Link>
        <div className="claim-center-card flex items-start gap-3 rounded-xl p-4 opacity-80">
          <Layers className="h-5 w-5 opacity-60" />
          <div>
            <p className="font-medium">Native grouping</p>
            <p className="text-xs opacity-65">Coming in a future Claim Center release</p>
          </div>
        </div>
      </div>

      <div className="claim-center-card mt-4 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
        <ul className="list-inside list-disc space-y-1 text-xs opacity-90">
          <li>Promote and case creation require the write bridge phase.</li>
          <li>Event-based scan opportunities are not grouped on this screen.</li>
        </ul>
      </div>

      <div className="mt-4">
        <ClaimCenterBridgePhaseNotice compact />
      </div>
    </ClaimCenterV2PageShell>
  );
}
