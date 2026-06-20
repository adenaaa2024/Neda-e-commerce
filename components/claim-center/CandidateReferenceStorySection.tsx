"use client";

/**
 * PHASE-PRODUCT-STORY-TRID-EDGE-UI-WIRE-V1
 *
 * Reference Story narrative section for the Claim Candidate drawer.
 * Shows: why this candidate exists, what supports it, what's missing,
 * whether it can become a claim, exact blocker, and a compact link for
 * other family opportunities.
 *
 * Read-only. No DB access. No claim mutation. No Amazon calls.
 * Seller Central proof filter is enforced — internal UUIDs are never
 * shown as proof.
 */

import Link from "next/link";
import type { ReactElement } from "react";
import { useMemo } from "react";
import { ChevronRight, CheckCircle, XCircle, AlertCircle, Info } from "lucide-react";

import {
  buildReferenceStorySummary,
  type ReadModelLike,
} from "@/lib/claims/readmodel/product-story-trid-event-timeline-v1";

type GatingState = "ready" | "blocked" | "review_signal_only" | "unknown_family";

const GATING_ICON: Record<GatingState, ReactElement> = {
  ready: <CheckCircle className="h-4 w-4 text-emerald-500" />,
  blocked: <XCircle className="h-4 w-4 text-amber-500" />,
  review_signal_only: <Info className="h-4 w-4 text-sky-500" />,
  unknown_family: <AlertCircle className="h-4 w-4 text-slate-400" />,
};

const GATING_LABEL: Record<GatingState, string> = {
  ready: "Claim-ready lineage complete",
  blocked: "Claim lineage blocked",
  review_signal_only: "Review signal only — never claim-ready",
  unknown_family: "Family not in requirements matrix",
};

const GATING_TONE: Record<GatingState, string> = {
  ready: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
  blocked: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200",
  review_signal_only: "border-sky-500/30 bg-sky-500/10 text-sky-800 dark:text-sky-200",
  unknown_family: "border-slate-500/25 bg-slate-500/5 text-slate-700 dark:text-slate-300",
};

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wide opacity-55 mb-1.5">{children}</p>
  );
}

export function CandidateReferenceStorySection({
  readModel,
  opportunitiesHref = "/claim-center/opportunities",
}: {
  readModel: ReadModelLike | null;
  opportunitiesHref?: string;
}) {
  const story = useMemo(
    () => (readModel ? buildReferenceStorySummary(readModel) : null),
    [readModel],
  );

  if (!story) {
    return (
      <p className="text-xs opacity-60 py-2">
        Reference story unavailable — load references first.
      </p>
    );
  }

  const gatingState = story.claim_ready_state;

  return (
    <div className="space-y-4">
      {/* Why this candidate exists */}
      <div>
        <SectionHeading>Why this candidate exists</SectionHeading>
        <p className="text-xs leading-relaxed opacity-80">{story.why_exists}</p>
        {story.family_display_name ? (
          <p className="mt-1 text-[11px] opacity-55">
            Family: <span className="font-medium">{story.family_display_name}</span>
            {story.family_key && story.family_key !== story.family_display_name
              ? ` (${story.family_key})`
              : ""}
          </p>
        ) : null}
      </div>

      {/* Supporting references (SC proof only) */}
      <div>
        <SectionHeading>Seller Central proof references</SectionHeading>
        {story.supporting_references.length === 0 ? (
          <p className="text-xs opacity-55 italic">
            No Seller Central proof references materialized yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {story.supporting_references.map((ref, i) => (
              <li
                key={`ref-${i}`}
                className="flex items-start gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2 py-1.5 text-xs"
              >
                <CheckCircle className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
                <span className="font-mono leading-snug">{ref}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1.5 text-[10px] opacity-40 leading-tight">
          Internal UUIDs (product_id, package_id, expected_package_id) are excluded from Seller Central
          proof — they are operational only.
        </p>
      </div>

      {/* Missing references */}
      {story.missing_references.length > 0 ? (
        <div>
          <SectionHeading>Missing required references</SectionHeading>
          <ul className="space-y-1">
            {story.missing_references.map((m, i) => (
              <li
                key={`miss-${i}`}
                className="flex items-start gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-xs"
              >
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
                <span>{m}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Claim readiness verdict */}
      <div>
        <SectionHeading>Can this become a claim?</SectionHeading>
        <div
          className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs ${GATING_TONE[gatingState]}`}
        >
          <span className="mt-0.5 shrink-0">{GATING_ICON[gatingState]}</span>
          <div className="min-w-0">
            <p className="font-semibold">{GATING_LABEL[gatingState]}</p>
            {story.exact_blocker ? (
              <p className="mt-1 opacity-90">
                <span className="font-medium">Exact blocker:</span> {story.exact_blocker}
              </p>
            ) : gatingState === "ready" ? (
              <p className="mt-1 opacity-80">
                All required edges are present. Proceed to claim review.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* Other opportunities compact link */}
      {story.other_opportunities_hint ? (
        <div className="rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] px-3 py-2">
          <p className="text-[11px] opacity-70 leading-snug">
            Other opportunities for this product (damaged / lost / reversal / customer return) are
            evaluated as separate, independent claims.
          </p>
          <Link
            href={opportunitiesHref}
            className="mt-1.5 inline-flex items-center gap-0.5 text-xs font-medium underline opacity-80 hover:opacity-100"
          >
            View all product opportunities <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      ) : null}
    </div>
  );
}
