"use client";

import { X } from "lucide-react";
import Link from "next/link";

import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

import { CLAIM_CENTER_DISABLED_BTN, CLAIM_CENTER_DRAWER_CLASS, claimCenterBadgeTone } from "./claim-center-ui";
import { EvidenceChecklistPanel } from "./EvidenceChecklistPanel";
import { OrbitFraCarryForwardBanner } from "./OrbitFraCarryForwardBanner";
import { ProductLinkagePanel } from "./ProductLinkagePanel";
import { TridReferenceGraphPanel } from "./TridReferenceGraphPanel";

type Props = {
  row: ClaimCenterV1Row | null;
  onClose: () => void;
};

export function ClaimCenterDetailDrawer({ row, onClose }: Props) {
  if (!row) return null;

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-[490] bg-black/40"
        aria-label="Close detail"
        onClick={onClose}
      />
      <aside className={CLAIM_CENTER_DRAWER_CLASS} role="dialog" aria-label="Claim opportunity detail">
        <div className="flex h-full flex-col overflow-y-auto p-4 sm:p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide opacity-60">Claim opportunity</p>
              <h2 className="text-lg font-bold">{row.v1_status_label}</h2>
              <p className="mt-1 text-xs opacity-70">{row.id}</p>
            </div>
            <button type="button" onClick={onClose} className="rounded-lg p-1 hover:bg-black/10 dark:hover:bg-white/10">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="mb-4 flex flex-wrap gap-1.5">
            {row.badges.map((b, i) => (
              <span key={`${b.kind}-${i}`} className={claimCenterBadgeTone(b.tone)}>
                {b.label}
              </span>
            ))}
          </div>

          {row.source_kind === "orbit_fra" ? <OrbitFraCarryForwardBanner row={row} /> : null}

          <dl className="mb-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs opacity-60">Recovery value</dt>
              <dd className="font-semibold">
                {row.recovery_value != null
                  ? new Intl.NumberFormat("en-US", { style: "currency", currency: row.currency ?? "USD" }).format(row.recovery_value)
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs opacity-60">Filing deadline</dt>
              <dd>{row.canonical_window.deadline ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs opacity-60">Claim reason</dt>
              <dd>{row.claim_reason ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs opacity-60">Amazon reference</dt>
              <dd>{row.amazon_reference_id ?? row.reference_id ?? "—"}</dd>
            </div>
          </dl>

          <ProductLinkagePanel row={row} />
          <TridReferenceGraphPanel row={row} organizationId={row.organization_id} />
          <EvidenceChecklistPanel row={row} />

          {row.product_story_href ? (
            <Link href={row.product_story_href} className="mt-4 text-sm font-medium underline opacity-80">
              Open product story
            </Link>
          ) : null}

          <div className="mt-6 space-y-2 border-t pt-4">
            <p className="text-xs opacity-60">Actions (bridge phase required)</p>
            <button type="button" disabled className={CLAIM_CENTER_DISABLED_BTN}>
              File claim — requires bridge phase
            </button>
            <button type="button" disabled className={CLAIM_CENTER_DISABLED_BTN}>
              Promote to case — requires bridge phase
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
