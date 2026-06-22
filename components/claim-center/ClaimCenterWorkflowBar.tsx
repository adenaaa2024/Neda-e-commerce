"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MoreHorizontal } from "lucide-react";

import {
  CLAIM_CENTER_PRIMARY_SECTIONS,
  primaryNavToneClass,
  primarySectionBadgeCount,
  resolveActivePrimarySection,
} from "@/lib/claims/center/claim-center-primary-nav";
import { CLAIM_CENTER_FLOW_STEPS } from "@/lib/claims/center/claim-center-flow-nav";
import { ClaimCenterMoreMenu } from "./ClaimCenterMoreMenu";
import { useClaimCenterFlowCounts } from "./ClaimCenterFlowCountsProvider";

/**
 * Unified primary navigation — the 10 top-level Claim Center sections.
 * (Workflow-bar markers + classes preserved for shell smoke checks.)
 */
export function ClaimCenterWorkflowBar() {
  const pathname = usePathname();
  const { counts, loading } = useClaimCenterFlowCounts();
  const activeId = resolveActivePrimarySection(pathname ?? "");

  return (
    <div
      className="claim-center-workflow-bar claim-center-primary-nav hidden lg:block sticky top-0 z-20 -mx-4 border-b border-black/5 bg-inherit/95 px-4 py-3 backdrop-blur-sm dark:border-white/10 sm:-mx-6 sm:px-6 xl:-mx-8 xl:px-8"
      data-claim-center="workflow-bar"
      role="navigation"
      aria-label="Claim Center sections"
    >
      <div className="flex items-center gap-2">
        <div className="claim-center-workflow-bar__track flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto overscroll-x-contain pb-0.5 [-webkit-overflow-scrolling:touch]">
          {CLAIM_CENTER_PRIMARY_SECTIONS.map((section) => {
            const Icon = section.icon;
            const active = activeId === section.id;
            const count = primarySectionBadgeCount(section.id, counts);
            const showBadge = !loading && count > 0;

            return (
              <Link
                key={section.id}
                href={section.href}
                title={section.description}
                className={`claim-center-primary-nav__item claim-center-workflow-bar__step group flex min-h-[44px] min-w-[5rem] shrink-0 flex-col items-center justify-center rounded-xl px-2 py-1.5 text-center transition-all duration-150 sm:min-w-[6rem] sm:px-3 ${
                  active
                    ? `claim-center-workflow-bar__step--active ${primaryNavToneClass(section.tone, true)}`
                    : "opacity-80 hover:opacity-100 hover:-translate-y-px"
                }`}
                aria-current={active ? "page" : undefined}
              >
                <Icon className="h-4 w-4 shrink-0 opacity-80" aria-hidden />
                <span className="mt-0.5 text-[10px] font-bold leading-tight sm:text-[11px]">
                  {section.shortLabel}
                </span>
                {showBadge ? (
                  <span className="mt-0.5 rounded-full bg-amber-500/20 px-1.5 py-px text-[9px] font-bold tabular-nums text-amber-900 dark:text-amber-100">
                    {count > 99 ? "99+" : count}
                  </span>
                ) : (
                  <span className="mt-0.5 h-[14px]" aria-hidden />
                )}
              </Link>
            );
          })}
        </div>

        <ClaimCenterMoreMenu
          trigger={
            <button
              type="button"
              className="claim-center-workflow-bar__more flex min-h-[44px] shrink-0 items-center gap-1 rounded-xl border px-2.5 text-xs font-semibold opacity-80 transition-opacity hover:opacity-100"
              aria-label="More Claim Center tools (legacy / power user)"
            >
              <MoreHorizontal className="h-4 w-4" />
              <span className="hidden sm:inline">More</span>
            </button>
          }
        />
      </div>
    </div>
  );
}

/** Compact step pill for mobile detail surfaces (kept for detail drawers). */
export function ClaimCenterFlowStepPill({ stepId }: { stepId: string | null }) {
  const step = CLAIM_CENTER_FLOW_STEPS.find((s) => s.id === stepId);
  if (!step) return null;
  const Icon = step.icon;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-900 dark:text-amber-100">
      <Icon className="h-3 w-3" aria-hidden />
      {step.label}
    </span>
  );
}

export function claimCenterFlowStepIdFromRow(row: {
  v1_status_group?: string;
  evidence_status?: string | null;
  product_linkage?: { is_resolved?: boolean } | null;
}): string | null {
  if (row.v1_status_group === "blocked_product_link") return "product";
  if (row.v1_status_group === "blocked_reference_conflict") return "references";
  if (row.evidence_status === "missing" || row.evidence_status === "partial") return "proof";
  if (row.v1_status_group === "needs_review") return "review";
  if (row.v1_status_group === "filed" || row.v1_status_group === "reimbursed") return "recovery";
  return "find_money";
}
