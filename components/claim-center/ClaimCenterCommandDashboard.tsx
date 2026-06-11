"use client";

import {
  DollarSign,
  FileCheck,
  FileText,
  Link2,
  PlayCircle,
  Search,
  Settings,
  ShieldAlert,
  Workflow,
} from "lucide-react";

import {
  MenorixModuleAiAssistCard,
  MenorixModuleAutomationHealthCard,
  MenorixModuleCommandHome,
  MenorixModuleKpiStrip,
  MenorixModuleTileGrid,
  type MenorixAiAssistState,
  type MenorixAutomationHealth,
  type MenorixKpiItem,
  type MenorixModuleTile,
} from "@/components/menorix";
import type { ClaimCenterDashboardKpis, ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

import { ClaimCenterMobileCards } from "./ClaimCenterMobileCards";

type Props = {
  kpis: ClaimCenterDashboardKpis;
  opportunities: ClaimCenterV1Row[];
  referenceConflictCount?: number;
  aiState?: MenorixAiAssistState;
  automationHealth?: MenorixAutomationHealth;
  onSelectRow?: (row: ClaimCenterV1Row) => void;
};

function money(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

const AI_SLOTS = [
  { id: "insight", label: "AI insight", hint: "Summarize recoverable exposure by store and family." },
  { id: "evidence_gap", label: "Evidence gap suggestion", hint: "Highlight missing photos or notes before filing." },
  { id: "draft_claim", label: "Draft claim", hint: "Assistive narrative draft — operator approves all text." },
  { id: "product_qa", label: "Product image QA", hint: "Flag mismatched catalog images vs scan evidence." },
  { id: "reference_explain", label: "Reference explanation", hint: "Explain TRID/FRR ambiguity in plain language." },
];

export function ClaimCenterCommandDashboard({
  kpis,
  opportunities,
  referenceConflictCount = 0,
  aiState = "locked",
  automationHealth,
  onSelectRow,
}: Props) {
  const kpiItems: MenorixKpiItem[] = [
    { id: "recoverable", label: "Recoverable", value: money(kpis.recoverable_amount), href: "/claim-center/opportunities", icon: <DollarSign className="h-3.5 w-3.5" /> },
    { id: "ready", label: "Ready for review", value: String(kpis.ready_for_review_count), href: "/claim-center/review", icon: <FileCheck className="h-3.5 w-3.5" /> },
    { id: "evidence", label: "Evidence missing", value: String(kpis.evidence_missing_count), href: "/claim-center/evidence", icon: <ShieldAlert className="h-3.5 w-3.5" /> },
    { id: "product", label: "Product link blocked", value: String(kpis.blocked_product_link_count), href: "/claim-center/product-linkage", icon: <Link2 className="h-3.5 w-3.5" /> },
    { id: "refs", label: "Reference conflicts", value: String(referenceConflictCount), href: "/claim-center/references", icon: <Workflow className="h-3.5 w-3.5" /> },
    { id: "expiring", label: "Expiring soon", value: String(kpis.expiring_soon_count), href: "/claim-center/opportunities", icon: <Search className="h-3.5 w-3.5" /> },
    { id: "filed", label: "Filed claims", value: String(kpis.filed_count), href: "/claim-center/submissions", icon: <FileText className="h-3.5 w-3.5" /> },
    { id: "reimbursed", label: "Reimbursed", value: String(kpis.reimbursed_count), href: "/claim-center/recovery", icon: <DollarSign className="h-3.5 w-3.5" /> },
  ];

  const tiles: MenorixModuleTile[] = [
    { id: "find_money", title: "Find Money", description: "Highest-value recoverable opportunities.", href: "/claim-center/opportunities", count: kpis.total_active, urgency: kpis.expiring_soon_count > 0 ? "high" : "medium", nextAction: "Review top rows" },
    { id: "review", title: "Review Claims", description: "Operator review queue for blocked or ambiguous items.", href: "/claim-center/review", count: kpis.ready_for_review_count, urgency: kpis.ready_for_review_count > 5 ? "medium" : "low", nextAction: "Open review queue" },
    { id: "evidence", title: "Build Evidence", description: "Missing photos, notes, or source snapshots.", href: "/claim-center/evidence", count: kpis.evidence_missing_count, urgency: kpis.evidence_missing_count > 0 ? "medium" : "low", nextAction: "Check evidence gaps" },
    { id: "refs", title: "Track Amazon References", description: "TRID, FRR, and shipment reference graph.", href: "/claim-center/references", count: referenceConflictCount, urgency: referenceConflictCount > 0 ? "high" : "low", nextAction: "Resolve conflicts" },
    { id: "pim", title: "Fix Product Links", description: "Unresolved catalog linkage blocking recovery.", href: "/claim-center/product-linkage", count: kpis.blocked_product_link_count, urgency: kpis.blocked_product_link_count > 0 ? "high" : "low", nextAction: "Open linkage queue" },
    { id: "file", title: "File Claims", description: "Submission queue and filing readiness (read-only).", href: "/claim-center/submissions", count: kpis.filed_count, nextAction: "View submissions" },
    { id: "recovery", title: "Match Reimbursements", description: "Financial recovery and reimbursement alignment.", href: "/claim-center/recovery", count: kpis.reimbursed_count, nextAction: "Open recovery" },
    { id: "runs", title: "Source Runs", description: "Generator and discovery run history.", href: "/claim-center/runs", icon: <PlayCircle className="h-4 w-4" />, nextAction: "Inspect runs" },
    { id: "settings", title: "Settings", description: "Effective policy snapshot — edits in workspace settings.", href: "/claim-center/settings", icon: <Settings className="h-4 w-4" />, nextAction: "View policy" },
  ];

  const defaultAutomation: MenorixAutomationHealth = {
    status: "unknown",
    label: "Loading",
    detail: "Automation status unavailable.",
  };

  return (
    <div className="space-y-8">
      <MenorixModuleCommandHome
        title="Claim Center"
        subtitle="Recovery command dashboard — review opportunities before any case or filing action. Read-only V1."
        kpis={<MenorixModuleKpiStrip items={kpiItems} />}
        tiles={<MenorixModuleTileGrid tiles={tiles} />}
        sidePanels={
          <>
            <MenorixModuleAutomationHealthCard health={automationHealth ?? defaultAutomation} />
            <MenorixModuleAiAssistCard state={aiState} slots={AI_SLOTS} />
          </>
        }
      />

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Top opportunities</h2>
        <div className="hidden md:block claim-center-table-card overflow-hidden">
          <table className="claim-center-table w-full text-sm">
            <thead className="text-xs uppercase opacity-70">
              <tr>
                <th className="px-4 py-3 text-left">Source</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-right">Recovery</th>
              </tr>
            </thead>
            <tbody>
              {opportunities.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center opacity-60">
                    No active opportunities in scope.
                  </td>
                </tr>
              ) : (
                opportunities.map((r) => (
                  <tr
                    key={r.id}
                    className="cursor-pointer border-t hover:bg-black/5 dark:hover:bg-white/5"
                    onClick={() => onSelectRow?.(r)}
                  >
                    <td className="px-4 py-3">{r.badges.find((b) => b.kind === "source")?.label ?? "—"}</td>
                    <td className="px-4 py-3">{r.v1_status_label}</td>
                    <td className="px-4 py-3 text-right font-medium">
                      {r.recovery_value != null ? money(r.recovery_value) : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="md:hidden">
          <ClaimCenterMobileCards rows={opportunities} onSelect={onSelectRow} emptyLabel="No active opportunities in scope." />
        </div>
      </section>
    </div>
  );
}
