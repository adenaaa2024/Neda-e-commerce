"use client";

import Link from "next/link";
import { AlertTriangle, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";

import {
  EDGE_TYPE_LABELS,
  type ClaimEvidenceDisplayMode,
  type ClaimEvidencePreview,
  type ClaimEvidencePreviewEdge,
  type ClaimEvidencePreviewGroup,
  type ClaimEvidenceWarning,
  type ClaimPersistedEdgesPayload,
} from "@/lib/claim-evidence-preview";
import {
  formatLinkageConfidence,
  resolutionStatusBadgeClass,
  resolutionStatusLabel,
} from "@/lib/scanner-product-linkage-ui";

type Props = {
  payload: Record<string, unknown> | null;
  organizationId: string;
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function displayModeLabel(mode: ClaimEvidenceDisplayMode): string {
  switch (mode) {
    case "persisted":
      return "Persisted evidence";
    case "persisted_with_live_preview":
      return "Persisted + live preview";
    default:
      return "Live preview only";
  }
}

function displayModeBadgeClass(mode: ClaimEvidenceDisplayMode): string {
  switch (mode) {
    case "persisted":
      return "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-100";
    case "persisted_with_live_preview":
      return "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-100";
    default:
      return "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-200";
  }
}

function WarningBanner({ w }: { w: ClaimEvidenceWarning }) {
  const cls =
    w.severity === "error"
      ? "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-100"
      : w.severity === "warn"
        ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
        : "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300";
  return (
    <div className={`flex gap-2 rounded-lg border px-2.5 py-2 text-[11px] ${cls}`}>
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-80" />
      <span>{w.message}</span>
    </div>
  );
}

function EdgeRow({ edge, organizationId }: { edge: ClaimEvidencePreviewEdge; organizationId: string }) {
  const typeLabel = EDGE_TYPE_LABELS[edge.edge_type] ?? edge.edge_type;
  const refLabel =
    edge.reference_kind === "internal_trid_key"
      ? `TRID ${edge.reference_value ?? "—"}`
      : edge.reference_value
        ? `${edge.reference_kind ?? "ref"}: ${edge.reference_value}`
        : null;
  const productId =
    edge.edge_type === "slip_line_to_product" && edge.to_source_row_id !== "unresolved"
      ? edge.to_source_row_id
      : null;
  const resStatus = edge.reference_kind === "identifier_resolution_status" ? edge.reference_value : null;

  return (
    <li className="rounded-md border border-slate-200/80 bg-white px-2 py-1.5 dark:border-slate-700 dark:bg-slate-950/40">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="font-medium text-slate-800 dark:text-slate-100">{typeLabel}</span>
        <span className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {edge.to_source_table}
        </span>
        <span className="text-slate-500">conf {pct(edge.confidence_score)}</span>
        {edge.ambiguity_group_key ? (
          <span className="rounded border border-violet-300/60 bg-violet-50 px-1 text-[10px] text-violet-800 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200">
            ambiguous #{edge.ambiguity_rank ?? "?"}
          </span>
        ) : null}
      </div>
      {refLabel ? <p className="mt-0.5 font-mono text-[10px] text-sky-700 dark:text-sky-300">{refLabel}</p> : null}
      {resStatus ? (
        <span
          className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${resolutionStatusBadgeClass(resStatus)}`}
        >
          {resolutionStatusLabel(resStatus)}
          {edge.confidence_score != null ? ` · ${formatLinkageConfidence(edge.confidence_score)}` : null}
        </span>
      ) : null}
      {productId ? (
        <Link
          href={`/dashboard/products?organization_id=${encodeURIComponent(organizationId)}&highlight=${encodeURIComponent(productId)}`}
          className="mt-1 inline-flex items-center gap-0.5 text-[10px] font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          Product {productId.slice(0, 8)}…
          <ExternalLink className="h-3 w-3" />
        </Link>
      ) : null}
      <p className="mt-1 text-[10px] text-muted-foreground">{edge.edge_reason}</p>
    </li>
  );
}

function GroupSection({
  group,
  organizationId,
  defaultOpen,
}: {
  group: ClaimEvidencePreviewGroup;
  organizationId: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-700">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs font-semibold text-slate-800 dark:text-slate-100"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        {group.label}
        <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-normal text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {group.edge_count}
        </span>
      </button>
      {open ? (
        <ul className="space-y-1.5 border-t border-slate-200 px-2 py-2 dark:border-slate-700">
          {group.items.map((edge) => (
            <EdgeRow key={edge.edge_id} edge={edge} organizationId={organizationId} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function ClaimEvidenceViewer({ payload, organizationId }: Props) {
  const graph = (payload?.graph_preview ?? payload) as ClaimEvidencePreview | undefined;
  const projection = payload?.projection as Record<string, unknown> | undefined;
  const persistedPayload = payload?.persisted_edges as ClaimPersistedEdgesPayload | undefined;

  const warnings = useMemo(() => graph?.warnings ?? [], [graph?.warnings]);
  const groups = graph?.groups ?? [];
  const persistedGroups = persistedPayload?.groups ?? [];
  const trids = graph?.trid_candidates ?? [];
  const draftDeepLink =
    graph?.draft_id != null
      ? `/claim-engine/evidence?draft_id=${encodeURIComponent(graph.draft_id)}`
      : null;

  if (!graph) {
    return <p className="text-xs text-muted-foreground">No evidence preview in response.</p>;
  }

  const displayMode =
    graph.evidence_display_mode ?? (graph.persisted_edges ? "persisted_with_live_preview" : "preview_only");
  const persistedCount = graph.enrichment.persisted_edge_count ?? 0;
  const hasPersisted = persistedCount > 0 || graph.persisted_edges;

  return (
    <div className="space-y-3 text-xs">
      <section
        className={`rounded-lg border px-2.5 py-2 ${hasPersisted ? "border-emerald-200 bg-emerald-50/80 dark:border-emerald-900 dark:bg-emerald-950/30" : "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900/40"}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded border px-1.5 py-0.5 text-[11px] font-semibold ${displayModeBadgeClass(displayMode)}`}
          >
            {displayModeLabel(displayMode)}
          </span>
          {hasPersisted ? (
            <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-medium text-white">
              {persistedCount} persisted edge{persistedCount === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        {hasPersisted ? (
          <dl className="mt-2 grid gap-1 text-[10px] text-slate-700 dark:text-slate-300">
            {graph.enrichment.latest_generation_id ? (
              <>
                <dt className="font-medium text-slate-500">generation_id</dt>
                <dd className="break-all font-mono">{graph.enrichment.latest_generation_id}</dd>
              </>
            ) : null}
            {graph.enrichment.latest_generation_number != null ? (
              <>
                <dt className="font-medium text-slate-500">generation</dt>
                <dd>#{graph.enrichment.latest_generation_number}</dd>
              </>
            ) : null}
            {graph.enrichment.lineage_event_count > 0 ? (
              <>
                <dt className="font-medium text-slate-500">lineage events</dt>
                <dd>{graph.enrichment.lineage_event_count}</dd>
              </>
            ) : null}
            {graph.enrichment.latest_status ? (
              <>
                <dt className="font-medium text-slate-500">status</dt>
                <dd>{graph.enrichment.latest_status}</dd>
              </>
            ) : null}
            {draftDeepLink ? (
              <>
                <dt className="font-medium text-slate-500">draft link</dt>
                <dd>
                  <Link href={draftDeepLink} className="text-sky-600 hover:underline dark:text-sky-400">
                    Open draft evidence page
                  </Link>
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            No rows in claim_reference_edges for this draft yet.
          </p>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-medium dark:border-slate-600 dark:bg-slate-900">
          Live query overlay
        </span>
        <span>
          {graph.edge_count_returned}
          {graph.truncated ? ` / ${graph.edge_count_total}` : ""} preview edges
        </span>
        {!graph.enrichment.graph_tables_configured ? <span>CCE tables unavailable</span> : null}
        {projection?.inbox_queue ? (
          <span className="rounded bg-slate-100 px-1.5 dark:bg-slate-800">queue: {String(projection.inbox_queue)}</span>
        ) : null}
      </div>

      {warnings.length > 0 ? (
        <div className="space-y-1.5">
          {warnings
            .filter((w) => !(hasPersisted && w.code === "preview_only"))
            .map((w) => (
              <WarningBanner key={w.code} w={w} />
            ))}
        </div>
      ) : null}

      {persistedGroups.length > 0 ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-200">
              Persisted edges (claim_reference_edges)
            </h4>
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100">
              {persistedPayload?.edge_count_returned ?? persistedGroups.reduce((n, g) => n + g.edge_count, 0)}
              {persistedPayload?.truncated ? ` / ${persistedPayload.edge_count_total}` : ""}
            </span>
          </div>
          {persistedGroups.map((g, i) => (
            <GroupSection key={`persisted:${g.group_key}`} group={g} organizationId={organizationId} defaultOpen={i < 2} />
          ))}
        </div>
      ) : null}

      {trids.length > 0 ? (
        <section>
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">TRID / FRR candidates</h4>
          <ul className="space-y-1">
            {trids.slice(0, 12).map((t) => (
              <li
                key={`${t.trid_key}:${t.source_row_id}`}
                className="flex flex-wrap items-center gap-2 rounded border border-slate-200 px-2 py-1 font-mono text-[10px] dark:border-slate-700"
              >
                <span className="text-sky-700 dark:text-sky-300">{t.trid_key || "—"}</span>
                <span className="text-slate-500">{t.source_table}</span>
                <span className="text-slate-500">conf {pct(t.confidence_score)}</span>
                {t.ambiguity_group_key ? (
                  <span className="text-violet-600 dark:text-violet-300">rank {t.ambiguity_rank ?? "?"}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {groups.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Evidence by source</h4>
          {groups.map((g, i) => (
            <GroupSection key={g.group_key} group={g} organizationId={organizationId} defaultOpen={i < 3} />
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground">No grouped evidence edges.</p>
      )}

      <details className="rounded border border-slate-200 dark:border-slate-700">
        <summary className="cursor-pointer px-2 py-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-400">
          Raw JSON (advanced)
        </summary>
        <pre className="max-h-48 overflow-auto border-t border-slate-200 p-2 text-[10px] dark:border-slate-700">
          {JSON.stringify(payload, null, 2)}
        </pre>
      </details>
    </div>
  );
}
