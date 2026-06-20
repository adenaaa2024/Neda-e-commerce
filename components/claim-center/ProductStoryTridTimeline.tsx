"use client";

/**
 * PHASE-PRODUCT-STORY-TRID-EDGE-UI-WIRE-V1
 *
 * Product Story TRID Reference Timeline — renders chronological event view
 * for a claim candidate.
 *
 * Receives the read model's `edges` + `identity` as plain JSON from the
 * existing /api/claims/center/references endpoint (candidate_id branch).
 * Read-only display only — no writes, no Amazon calls, no scanner changes.
 */

import { useMemo, useState } from "react";

import {
  buildProductStoryTimeline,
  type ProductStoryIdentity,
  type ProductStoryTimelineEvent,
  type ReadModelLike,
} from "@/lib/claims/readmodel/product-story-trid-event-timeline-v1";

/* ---- helper ---- */
function pct(v: number | null): string {
  if (v == null) return "—";
  return `${Math.round(v * 100)}%`;
}

function ConfidencePip({ v }: { v: number | null }) {
  if (v == null) return <span className="opacity-40 text-[10px]">—</span>;
  const pct = Math.round(v * 100);
  const colour =
    pct >= 90
      ? "bg-emerald-500"
      : pct >= 70
        ? "bg-amber-400"
        : "bg-rose-400";
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-1.5 w-8 rounded-full ${colour}`} style={{ width: `${Math.max(pct * 0.32, 4)}px` }} />
      <span className="text-[10px] tabular-nums opacity-60">{pct}%</span>
    </span>
  );
}

function ProofBadge({ proof, internal }: { proof: boolean; internal: boolean }) {
  if (internal)
    return (
      <span className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-slate-500/15 text-slate-600 dark:text-slate-300">
        Internal
      </span>
    );
  if (proof)
    return (
      <span className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-emerald-500/20 text-emerald-700 dark:text-emerald-300">
        SC proof
      </span>
    );
  return (
    <span className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-sky-500/15 text-sky-700 dark:text-sky-300">
      Reference
    </span>
  );
}

function GatingBadge({ mode }: { mode: string }) {
  if (mode === "review_signal" || mode === "defer")
    return (
      <span className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-amber-400/20 text-amber-700 dark:text-amber-300">
        {mode.replace(/_/g, " ")}
      </span>
    );
  if (mode === "active")
    return null;
  return (
    <span className="rounded px-1 py-0.5 text-[9px] uppercase opacity-50">{mode}</span>
  );
}

function TimelineEventRow({ event }: { event: ProductStoryTimelineEvent }) {
  return (
    <li className="flex items-start gap-3 py-2 border-b last:border-b-0 border-black/5 dark:border-white/5">
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-black/10 dark:border-white/10 text-[10px] font-bold">
        {event.is_seller_central_proof ? "✓" : "○"}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold">{event.event_type}</span>
          <ProofBadge proof={event.is_seller_central_proof} internal={event.is_internal_only} />
          {event.is_ambiguous ? (
            <span className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-amber-500/20 text-amber-700 dark:text-amber-300">
              ambiguous
            </span>
          ) : null}
          {event.is_disputed ? (
            <span className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-rose-500/20 text-rose-700 dark:text-rose-300">
              disputed
            </span>
          ) : null}
          <GatingBadge mode={event.gating_mode} />
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] opacity-60">
          <span className="font-mono">{event.reference_id ?? "—"}</span>
          <span>·</span>
          <span>{event.source_table}</span>
          <span>·</span>
          <ConfidencePip v={event.confidence} />
        </div>
        {event.claim_family_hint !== "unknown" ? (
          <p className="mt-0.5 text-[10px] opacity-45 leading-tight">{event.claim_family_hint}</p>
        ) : null}
      </div>
    </li>
  );
}

type FilterMode = "all" | "sc_proof" | "internal" | "reference";

const FILTER_LABELS: Record<FilterMode, string> = {
  all: "All",
  sc_proof: "SC Proof",
  internal: "Internal",
  reference: "Reference",
};

export function ProductStoryTridTimeline({
  readModel,
  identity,
}: {
  readModel: ReadModelLike | null;
  identity: Partial<ProductStoryIdentity>;
}) {
  const [filter, setFilter] = useState<FilterMode>("all");

  const timeline = useMemo(
    () =>
      readModel
        ? buildProductStoryTimeline({ readModel, identity })
        : null,
    [readModel, identity],
  );

  if (!timeline) {
    return (
      <p className="text-xs opacity-60 py-2">No TRID edge data available.</p>
    );
  }

  const visibleEvents: ProductStoryTimelineEvent[] =
    filter === "sc_proof"
      ? timeline.seller_central_proof_events
      : filter === "internal"
        ? timeline.internal_only_events
        : filter === "reference"
          ? timeline.other_events
          : timeline.all_events;

  return (
    <div className="space-y-3">
      {/* Identity section */}
      <div className="rounded-lg border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.03] px-3 py-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-wide opacity-55 mb-2">
          Product identity
        </p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          {[
            ["SKU", timeline.identity.sku],
            ["FNSKU", timeline.identity.fnsku],
            ["ASIN", timeline.identity.asin],
            ["UPC", timeline.identity.upc],
          ].map(([label, val]) =>
            val ? (
              <div key={String(label)} className="flex gap-1.5">
                <dt className="shrink-0 opacity-50">{label}</dt>
                <dd className="font-mono truncate">{val}</dd>
              </div>
            ) : null,
          )}
        </dl>
        <p
          className={`mt-2 text-[10px] font-semibold ${
            timeline.identity.identity_status === "resolved"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-amber-600 dark:text-amber-400"
          }`}
        >
          {timeline.identity.identity_status === "resolved"
            ? "✓ Product identity resolved"
            : "○ Product identity unresolved — no auto-create from title/OCR"}
        </p>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-semibold uppercase opacity-50 mr-1">Show</span>
        {(["all", "sc_proof", "internal", "reference"] as FilterMode[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ${
              filter === f
                ? "border-black/30 bg-black/10 dark:border-white/30 dark:bg-white/10"
                : "border-black/10 dark:border-white/10 opacity-60 hover:opacity-90"
            }`}
          >
            {FILTER_LABELS[f]}
            {f === "sc_proof" ? (
              <span className="ml-1 opacity-70">({timeline.seller_central_proof_count})</span>
            ) : f === "internal" ? (
              <span className="ml-1 opacity-70">({timeline.internal_only_count})</span>
            ) : f === "all" ? (
              <span className="ml-1 opacity-70">({timeline.all_events.length})</span>
            ) : (
              <span className="ml-1 opacity-70">({timeline.other_events.length})</span>
            )}
          </button>
        ))}
        {timeline.ambiguous_count > 0 ? (
          <span className="ml-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
            {timeline.ambiguous_count} ambiguous
          </span>
        ) : null}
      </div>

      {/* Seller Central proof notice */}
      {filter === "sc_proof" || filter === "all" ? (
        <p className="text-[11px] opacity-60">
          <span className="font-semibold text-emerald-700 dark:text-emerald-400">SC Proof</span>{" "}
          = external Amazon reference ID usable in a Seller Central case (order_id, removal_order_id,
          tracking_number, reimbursement_id, settlement_id, …).{" "}
          <span className="font-semibold text-slate-600 dark:text-slate-400">Internal</span>{" "}
          = our own UUID — never cited as Seller Central proof.
        </p>
      ) : null}

      {/* Timeline */}
      {visibleEvents.length === 0 ? (
        <p className="text-xs opacity-60 py-1">No events for this filter.</p>
      ) : (
        <ul className="divide-y divide-transparent">
          {visibleEvents.map((e) => (
            <TimelineEventRow key={e.event_key} event={e} />
          ))}
        </ul>
      )}
    </div>
  );
}
