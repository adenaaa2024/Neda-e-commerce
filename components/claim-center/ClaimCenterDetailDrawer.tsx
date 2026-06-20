"use client";

import { X } from "lucide-react";

import { MenorixModuleMobileDetailSheet } from "@/components/menorix";
import { MENORIX_TOUCH_MIN } from "@/components/menorix/menorix-module-ui";
import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

import { ClaimCenterBridgePhaseNotice } from "./ClaimCenterBridgePhaseNotice";
import { ClaimCenterDetailStory } from "./ClaimCenterDetailStoryBlocks";
import { ClaimCenterMobileDetailSummary } from "./ClaimCenterMobileDetailSummary";
import {
  ClaimCenterFlowStepPill,
  claimCenterFlowStepIdFromRow,
} from "./ClaimCenterWorkflowBar";

type Props = {
  row: ClaimCenterV1Row | null;
  onClose: () => void;
};

const DESKTOP_DRAWER_CLASS =
  "claim-center-drawer claim-center-detail-drawer fixed inset-y-0 right-0 z-[500] flex w-full max-w-3xl flex-col border-l bg-white shadow-2xl dark:bg-[#12161c] xl:max-w-5xl";

function sourceLabel(row: ClaimCenterV1Row): string {
  return row.badges.find((b) => b.kind === "source")?.label ?? row.source_kind ?? "";
}

export function ClaimCenterDetailDrawer({ row, onClose }: Props) {
  if (!row) return null;

  const footer = <ClaimCenterBridgePhaseNotice compact />;
  const flowStepId = claimCenterFlowStepIdFromRow(row);
  const family = row.claim_family?.replace(/_/g, " ") ?? "Opportunity";
  const subtitle = [family, sourceLabel(row)].filter(Boolean).join(" · ");

  return (
    <>
      <div className="lg:hidden" data-claim-center="mobile-detail-sheet">
        <MenorixModuleMobileDetailSheet
          open
          title={row.v1_status_label}
          subtitle={subtitle || "Read-only opportunity story"}
          onClose={onClose}
          footer={footer}
        >
          <ClaimCenterMobileDetailSummary row={row} />
          <div className="mb-4">
            <ClaimCenterFlowStepPill stepId={flowStepId} />
          </div>
          <ClaimCenterDetailStory row={row} variant="mobile" />
        </MenorixModuleMobileDetailSheet>
      </div>

      <div className="hidden lg:block">
        <button
          type="button"
          className="fixed inset-0 z-[490] bg-black/40"
          aria-label="Close detail"
          onClick={onClose}
        />
        <aside className={DESKTOP_DRAWER_CLASS} role="dialog" aria-label={row.v1_status_label}>
          <div className="flex items-start justify-between gap-3 border-b px-5 py-3">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide opacity-60">Claim opportunity</p>
              <h2 className="truncate text-lg font-bold">{row.v1_status_label}</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className={`rounded-lg p-2 hover:bg-black/10 dark:hover:bg-white/10 ${MENORIX_TOUCH_MIN}`}
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <ClaimCenterDetailStory row={row} variant="desktop" />
          </div>
          <div className="sticky bottom-0 border-t bg-inherit px-5 py-3">{footer}</div>
        </aside>
      </div>
    </>
  );
}
