"use client";

import { ChevronRight } from "lucide-react";

import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

import { ClaimCenterTwinSourceChips } from "./ClaimCenterTwinSourceChips";
import { claimCenterBadgeTone } from "./claim-center-ui";

type Props = {
  rows: ClaimCenterV1Row[];
  onSelect?: (row: ClaimCenterV1Row) => void;
  emptyLabel?: string;
  layout?: "list" | "board";
};

function moneyLabel(row: ClaimCenterV1Row): string {
  return row.money_display?.amount_display_label ?? "Cost unknown";
}

function sourceLabel(row: ClaimCenterV1Row): string {
  return row.badges.find((b) => b.kind === "source")?.label ?? row.source_kind ?? "—";
}

function productState(row: ClaimCenterV1Row): { label: string; tone: "success" | "warning" | "neutral" } {
  if (row.product_linkage?.is_resolved) {
    return { label: "Matched", tone: "success" };
  }
  return { label: "Product not matched", tone: "warning" };
}

function evidenceState(row: ClaimCenterV1Row): { label: string; tone: "success" | "warning" | "neutral" } {
  const ev = row.badges.find((b) => b.kind === "evidence");
  const status = row.evidence_status ?? "unknown";
  if (status === "complete") return { label: ev?.label ?? "Complete", tone: "success" };
  if (status === "missing") return { label: ev?.label ?? "Proof missing", tone: "warning" };
  if (status === "partial") return { label: ev?.label ?? "Partial proof", tone: "warning" };
  return { label: ev?.label ?? "Unknown", tone: "neutral" };
}

function blockerBadge(row: ClaimCenterV1Row) {
  return (
    row.badges.find((b) => b.kind === "trid" && b.tone === "danger") ??
    row.badges.find((b) => b.kind === "conflict") ??
    (row.v1_status_group === "blocked_product_link"
      ? row.badges.find((b) => b.kind === "product")
      : null) ??
    (row.evidence_status === "missing" ? row.badges.find((b) => b.kind === "evidence") : null)
  );
}

export function ClaimCenterMobileCards({ rows, onSelect, emptyLabel = "No items in scope.", layout = "list" }: Props) {
  if (!rows.length) {
    return (
      <p className="claim-center-mobile-empty py-10 text-center text-sm opacity-60" data-claim-center="mobile-cards-empty">
        {emptyLabel}
      </p>
    );
  }

  const gridClass = layout === "board" ? "grid gap-3 sm:grid-cols-2" : "space-y-3";

  return (
    <div className={`claim-center-mobile-cards ${gridClass}`} data-claim-center="mobile-cards">
      {rows.map((row) => {
        const product = productState(row);
        const evidence = evidenceState(row);
        const blocker = blockerBadge(row);

        return (
          <button
            key={row.id}
            type="button"
            className="claim-center-mobile-card claim-center-mobile-card--rich group w-full min-h-[44px] text-left transition-all duration-150 active:scale-[0.99]"
            onClick={() => onSelect?.(row)}
            aria-label={`Open ${row.v1_status_label}, ${moneyLabel(row)}`}
            title={row.money_display?.amount_tooltip}
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold leading-snug">{row.v1_status_label}</p>
                  {blocker ? (
                    <span className={claimCenterBadgeTone(blocker.tone)}>{blocker.label}</span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs font-medium opacity-75">
                  {row.physical_return_display?.physical_family_label ??
                    row.claim_family?.replace(/_/g, " ") ??
                    "Physical return issue"}
                </p>
                <ClaimCenterTwinSourceChips row={row} className="mt-2" />
              </div>
              <div className="shrink-0 text-right">
                <p className="text-base font-bold tabular-nums">{moneyLabel(row)}</p>
                <p className="mt-0.5 text-[10px] opacity-50">exposure</p>
              </div>
            </div>

            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
              <div>
                <dt className="opacity-50">Eligibility</dt>
                <dd className="font-medium">{row.eligibility_display?.label ?? row.canonical_window.status}</dd>
              </div>
              <div>
                <dt className="opacity-50">Deadline</dt>
                <dd className="font-medium">{row.canonical_window.deadline ?? "—"}</dd>
              </div>
              <div>
                <dt className="opacity-50">Source</dt>
                <dd className="truncate font-medium">{sourceLabel(row)}</dd>
              </div>
              <div>
                <dt className="opacity-50">Product</dt>
                <dd>
                  <span className={claimCenterBadgeTone(product.tone)}>{product.label}</span>
                </dd>
              </div>
              <div>
                <dt className="opacity-50">Proof</dt>
                <dd>
                  <span className={claimCenterBadgeTone(evidence.tone)}>{evidence.label}</span>
                </dd>
              </div>
            </dl>

            <div className="mt-3 flex items-center justify-between border-t border-black/5 pt-2 text-xs opacity-60 dark:border-white/10">
              <span>Tap for full story</span>
              <ChevronRight className="h-4 w-4 opacity-50 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </div>
          </button>
        );
      })}
    </div>
  );
}
