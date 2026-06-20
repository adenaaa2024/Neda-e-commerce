"use client";

import { useEffect, useMemo, useState } from "react";
import { GitBranch } from "lucide-react";

import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";
import { ProductStoryTridTimeline } from "./ProductStoryTridTimeline";
import { CandidateReferenceStorySection } from "./CandidateReferenceStorySection";

type EdgeGroup = Record<string, unknown[]>;

type EdgeItem = {
  edge_kind_id?: string | null;
  edge_type?: string | null;
  reference_value?: string | null;
  to_source_table?: string | null;
  confidence_score?: number | null;
  is_seller_central_proof?: boolean;
  is_internal_only?: boolean;
  is_ambiguous?: boolean;
  is_disputed?: boolean;
  gating_mode?: string | null;
};

type CoverageItem = {
  edge_kind_id: string;
  present: boolean;
  edge_count: number;
  missing_behavior: string;
  is_seller_central_proof: boolean;
};

type TridReadModel = {
  family_key: string | null;
  family_display_name: string | null;
  family_classification: string | null;
  resolved_product: boolean;
  edge_total: number;
  ambiguous_total: number;
  seller_central_proof_total: number;
  internal_only_total: number;
  /** Enriched per-edge detail (includes is_seller_central_proof, gating_mode, etc.) */
  edges?: EdgeItem[];
  claim_ready_coverage: CoverageItem[];
  product_story_coverage: CoverageItem[];
  money_coverage: CoverageItem[];
  gating: {
    claim_ready_state: "ready" | "blocked" | "review_signal_only" | "unknown_family";
    blocking_edge_kinds: string[];
    product_story_ready: boolean;
    product_story_gaps: string[];
    money_ready: boolean;
    money_gaps: string[];
    product_link_deferred_unresolved: boolean;
    has_disputed_edges: boolean;
    notes: string[];
  };
};

type StoryTab = "overview" | "timeline" | "story";

const CLAIM_READY_TONE: Record<TridReadModel["gating"]["claim_ready_state"], string> = {
  ready: "border-emerald-500/35 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
  blocked: "border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-200",
  review_signal_only: "border-sky-500/35 bg-sky-500/10 text-sky-800 dark:text-sky-200",
  unknown_family: "border-slate-500/35 bg-slate-500/10 text-slate-700 dark:text-slate-200",
};

const CLAIM_READY_LABEL: Record<TridReadModel["gating"]["claim_ready_state"], string> = {
  ready: "Claim-ready lineage complete",
  blocked: "Claim-ready lineage blocked",
  review_signal_only: "Review signal only",
  unknown_family: "Family not in matrix",
};

function CoverageRow({ item }: { item: CoverageItem }) {
  return (
    <li className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5">
      <span className="min-w-0 truncate">
        <span className={item.present ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
          {item.present ? "✓" : "○"}
        </span>{" "}
        <span className="font-medium">{item.edge_kind_id}</span>
        {item.is_seller_central_proof ? (
          <span className="ml-1 text-[10px] uppercase opacity-60">proof</span>
        ) : null}
      </span>
      <span className="shrink-0 text-[10px] opacity-60">
        {item.present ? `${item.edge_count}×` : item.missing_behavior.replace(/_/g, " ")}
      </span>
    </li>
  );
}

function edgeAmbiguityKey(edge: unknown): string | null {
  if (!edge || typeof edge !== "object") return null;
  const o = edge as Record<string, unknown>;
  const key = String(o.ambiguity_group_key ?? o.group_key ?? "").trim();
  return key || null;
}

function edgeLabel(edge: unknown): string {
  if (!edge || typeof edge !== "object") return "edge";
  const o = edge as Record<string, unknown>;
  return (
    String(o.reference_value ?? o.amazon_reference_id ?? o.target_id ?? o.id ?? "edge").trim() || "edge"
  );
}

export function TridReferenceGraphPanel({
  row,
  organizationId,
  embedded = false,
}: {
  row: ClaimCenterV1Row;
  organizationId?: string;
  /** When true, omit outer card chrome (used inside detail story block 4). */
  embedded?: boolean;
}) {
  const [grouped, setGrouped] = useState<EdgeGroup | null>(null);
  const [readModel, setReadModel] = useState<TridReadModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<StoryTab>("overview");

  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ organization_id: organizationId, candidate_id: row.id, limit: "50" });
    if (row.store_id) params.set("store_id", row.store_id);
    fetch(`/api/claims/center/references?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setError(data.error);
          return;
        }
        setGrouped((data.grouped as EdgeGroup) ?? {});
        setReadModel((data.read_model as TridReadModel) ?? null);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load references.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId, row.id, row.store_id]);

  const identity = useMemo(
    () => ({
      sku: row.sku ?? null,
      fnsku: row.fnsku ?? null,
      asin: row.asin ?? null,
      upc: null,
      resolved_product_id: row.product_linkage?.resolved_product_id ?? null,
      product_title: row.product_linkage?.product_name ?? null,
    }),
    [row],
  );

  const ambiguityGroups = useMemo(() => {
    if (!grouped) return [];
    const byKey = new Map<string, { kind: string; labels: string[] }>();
    for (const [kind, edges] of Object.entries(grouped)) {
      for (const edge of edges) {
        const key = edgeAmbiguityKey(edge);
        if (!key) continue;
        const entry = byKey.get(key) ?? { kind, labels: [] };
        entry.labels.push(edgeLabel(edge));
        byKey.set(key, entry);
      }
    }
    return [...byKey.entries()].map(([key, v]) => ({ key, ...v }));
  }, [grouped]);

  const TAB_LABELS: Array<{ key: StoryTab; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "timeline", label: "Reference Timeline" },
    { key: "story", label: "Reference Story" },
  ];

  const inner = (
    <>
      {!embedded ? (
        <div className="flex items-center gap-2 mb-2">
          <GitBranch className="h-4 w-4 opacity-60" />
          <h3 className="text-sm font-semibold">Amazon references &amp; product story</h3>
        </div>
      ) : null}
      <p className={`text-xs opacity-70 ${embedded ? "" : "mt-1"}`}>
        Read-only TRID graph — shipment, order, removal, reimbursement, and tracking edges with
        Seller Central proof vs internal classification. No writes.
      </p>

      {/* Tab bar */}
      <div className="mt-3 flex gap-1 border-b border-black/10 dark:border-white/10 pb-0">
        {TAB_LABELS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            className={`px-2.5 pb-1.5 text-xs font-medium transition-colors border-b-2 -mb-px ${
              activeTab === t.key
                ? "border-black dark:border-white opacity-100"
                : "border-transparent opacity-50 hover:opacity-80"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ---- Overview tab ---- */}
      {activeTab === "overview" ? (
        <div className="mt-3 space-y-2">
          {row.ambiguity_pending ? (
            <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-200">
              <p className="font-semibold">Reference ambiguity (read-only)</p>
              <p className="mt-1 opacity-90">
                Multiple edges match. Resolve in Claim Engine review-ops when the write bridge opens.
              </p>
            </div>
          ) : null}
          <p className="text-xs opacity-70">
            {row.reference_edge_count} materialized edge{row.reference_edge_count === 1 ? "" : "s"}
            {row.amazon_reference_id ? ` · Primary: ${row.amazon_reference_id}` : ""}
            {row.reference_type ? ` · Type: ${row.reference_type}` : ""}
          </p>
          {readModel ? (
            <>
              <div className={`flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2 text-xs ${CLAIM_READY_TONE[readModel.gating.claim_ready_state]}`}>
                <span className="font-semibold">{CLAIM_READY_LABEL[readModel.gating.claim_ready_state]}</span>
                {readModel.family_display_name ? (
                  <span className="opacity-70">· {readModel.family_display_name}</span>
                ) : null}
                <span className="ml-auto opacity-80">
                  {readModel.seller_central_proof_total} SC proof · {readModel.internal_only_total} internal
                </span>
              </div>
              {readModel.gating.product_link_deferred_unresolved ? (
                <p className="rounded-md border border-amber-500/25 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-200">
                  Product link deferred — catalog identity unresolved (no title/OCR auto-create).
                </p>
              ) : null}
              {readModel.claim_ready_coverage.length > 0 ? (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide opacity-55">
                    Claim-ready edges
                    {readModel.gating.blocking_edge_kinds.length > 0
                      ? ` · ${readModel.gating.blocking_edge_kinds.length} missing`
                      : ""}
                  </p>
                  <ul className="mt-1 space-y-1">
                    {readModel.claim_ready_coverage.map((c) => (
                      <CoverageRow key={`cr-${c.edge_kind_id}`} item={c} />
                    ))}
                  </ul>
                </div>
              ) : null}
              {readModel.product_story_coverage.length > 0 ? (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide opacity-55">
                    Product Story edges {readModel.gating.product_story_ready ? "· complete" : "· gaps"}
                  </p>
                  <ul className="mt-1 space-y-1">
                    {readModel.product_story_coverage.map((c) => (
                      <CoverageRow key={`ps-${c.edge_kind_id}`} item={c} />
                    ))}
                  </ul>
                </div>
              ) : null}
              {readModel.gating.notes.length > 0 ? (
                <ul className="list-disc space-y-0.5 pl-4 text-[11px] opacity-70">
                  {readModel.gating.notes.map((n, i) => (
                    <li key={`note-${i}`}>{n}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
          {ambiguityGroups.length > 0 ? (
            <ul className="mt-2 space-y-2 text-xs">
              {ambiguityGroups.map((g) => (
                <li key={g.key} className="rounded-md border border-amber-500/25 px-2 py-1.5">
                  <span className="font-medium">Conflict group</span> ({g.kind}) · {g.labels.length} edge
                  {g.labels.length === 1 ? "" : "s"}
                  <span className="mt-0.5 block truncate opacity-70">{g.labels.join(" · ")}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {grouped && Object.keys(grouped).length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs">
              {Object.entries(grouped).map(([kind, edges]) => (
                <li key={kind} className="flex items-center gap-2">
                  <span className="font-medium">{kind}</span>
                  <span className="opacity-50">({(edges as unknown[]).length})</span>
                </li>
              ))}
            </ul>
          ) : !loading && !error ? (
            <p className="mt-2 text-xs opacity-60">No reference edges materialized yet for this candidate.</p>
          ) : null}
        </div>
      ) : null}

      {/* ---- Reference Timeline tab ---- */}
      {activeTab === "timeline" ? (
        <div className="mt-3">
          <ProductStoryTridTimeline readModel={readModel} identity={identity} />
        </div>
      ) : null}

      {/* ---- Reference Story tab ---- */}
      {activeTab === "story" ? (
        <div className="mt-3">
          <CandidateReferenceStorySection readModel={readModel} />
        </div>
      ) : null}

      {loading ? <p className="mt-2 text-xs opacity-60">Loading…</p> : null}
      {error ? <p className="mt-2 text-xs text-red-500">{error}</p> : null}
    </>
  );

  if (embedded) return <div className="mt-2">{inner}</div>;

  return (
    <section className="claim-center-card mb-4 rounded-xl p-3">
      {inner}
    </section>
  );
}
