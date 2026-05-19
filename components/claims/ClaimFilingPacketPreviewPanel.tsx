"use client";

import { ChevronDown, ChevronRight, Download, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { ClaimFilingPacketPreview } from "@/lib/claim-filing-packet-preview";
import { packetSourceLabel } from "@/lib/claim-filing-packet-preview";

type Props = {
  organizationId: string;
  draftId: string;
};

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ClaimFilingPacketPreviewPanel({ organizationId, draftId }: Props) {
  const [packet, setPacket] = useState<ClaimFilingPacketPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/claims/drafts/${encodeURIComponent(draftId)}/filing-packet-preview?organization_id=${encodeURIComponent(organizationId)}&log_view=true`,
        { credentials: "include" },
      );
      const j = (await res.json()) as { packet?: ClaimFilingPacketPreview; error?: string };
      if (!res.ok) {
        setPacket(null);
        setError(typeof j.error === "string" ? j.error : `HTTP ${res.status}`);
        return;
      }
      setPacket(j.packet ?? null);
    } catch (e) {
      setPacket(null);
      setError(e instanceof Error ? e.message : "Failed to load packet preview");
    } finally {
      setLoading(false);
    }
  }, [draftId, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <section className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs dark:border-slate-700">
        <Loader2 className="h-4 w-4 animate-spin text-sky-500" />
        Loading filing packet preview…
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-100">
        Packet preview: {error}
      </section>
    );
  }

  if (!packet) return null;

  const ready = packet.ready_for_preview;
  const rs = packet.filing_readiness.review_summary;

  return (
    <section className="space-y-3 rounded-lg border border-violet-200 bg-violet-50/50 px-3 py-3 dark:border-violet-900 dark:bg-violet-950/30">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-violet-950 dark:text-violet-100">Filing packet preview</h3>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${ready ? "bg-sky-600 text-white" : "bg-amber-600 text-white"}`}
        >
          Filing readiness: {ready ? "Ready" : "Not ready"}
        </span>
        <span className="rounded border border-violet-300/80 bg-white px-1.5 py-0.5 text-[10px] text-violet-800 dark:border-violet-800 dark:bg-slate-900 dark:text-violet-200">
          Preview only — does not submit claims
        </span>
      </div>

      <p className="text-[10px] text-slate-600 dark:text-slate-400">
        Operator review packet assembled from persisted evidence. No Amazon submission.
      </p>

      <dl className="grid gap-1 text-[10px] text-slate-700 dark:text-slate-300">
        <div className="grid grid-cols-[7rem_1fr] gap-1">
          <dt className="font-medium text-slate-500">Claim anchor</dt>
          <dd>
            {packetSourceLabel(packet.claim_summary.source_table)} ·{" "}
            <span className="font-mono">{packet.claim_summary.source_row_id}</span>
          </dd>
        </div>
        {packet.claim_summary.sku ? (
          <div className="grid grid-cols-[7rem_1fr] gap-1">
            <dt className="font-medium text-slate-500">SKU</dt>
            <dd className="font-mono">{packet.claim_summary.sku}</dd>
          </div>
        ) : null}
        <div className="grid grid-cols-[7rem_1fr] gap-1">
          <dt className="font-medium text-slate-500">Generation</dt>
          <dd className="font-mono break-all">
            {packet.claim_summary.generation_id ?? "—"}
            {packet.claim_summary.generation_number != null
              ? ` (#${packet.claim_summary.generation_number})`
              : ""}
          </dd>
        </div>
        <div className="grid grid-cols-[7rem_1fr] gap-1">
          <dt className="font-medium text-slate-500">Persisted edges</dt>
          <dd>{packet.claim_summary.persisted_edge_count}</dd>
        </div>
        <div className="grid grid-cols-[7rem_1fr] gap-1">
          <dt className="font-medium text-slate-500">Lineage events</dt>
          <dd>{packet.claim_summary.lineage_event_count}</dd>
        </div>
      </dl>

      {packet.unresolved_warnings.length > 0 ? (
        <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="font-semibold">Unresolved warnings ({packet.unresolved_warnings.length})</p>
          <ul className="mt-1 list-inside list-disc">
            {packet.unresolved_warnings.map((w) => (
              <li key={w.code}>{w.message}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-[10px] text-emerald-700 dark:text-emerald-300">No unresolved actionable warnings.</p>
      )}

      <div>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-violet-800 dark:text-violet-200">
          Evidence groups
        </h4>
        <div className="overflow-x-auto rounded border border-violet-200/80 dark:border-violet-900/60">
          <table className="w-full text-left text-[10px]">
            <thead className="bg-violet-100/80 dark:bg-violet-950/50">
              <tr>
                <th className="px-2 py-1 font-medium">Group</th>
                <th className="px-2 py-1 font-medium">Edges</th>
                <th className="px-2 py-1 font-medium">Accepted</th>
                <th className="px-2 py-1 font-medium">Rejected</th>
                <th className="px-2 py-1 font-medium">Needs review</th>
              </tr>
            </thead>
            <tbody>
              {packet.evidence_groups.map((g) => (
                <tr key={g.group_key} className="border-t border-violet-100 dark:border-violet-900/40">
                  <td className="px-2 py-1">{g.label}</td>
                  <td className="px-2 py-1">{g.edge_count}</td>
                  <td className="px-2 py-1">{g.review.accepted}</td>
                  <td className="px-2 py-1">{g.review.rejected}</td>
                  <td className="px-2 py-1">{g.review.needs_review}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-violet-200 bg-violet-50/80 dark:border-violet-800 dark:bg-violet-950/30">
              <tr>
                <td className="px-2 py-1 font-medium">Total</td>
                <td className="px-2 py-1">{rs.total}</td>
                <td className="px-2 py-1">{rs.accepted}</td>
                <td className="px-2 py-1">{rs.rejected}</td>
                <td className="px-2 py-1">{rs.needs_review}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {packet.trid_references.length > 0 ? (
        <div>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-violet-800 dark:text-violet-200">
            TRID / reference IDs
          </h4>
          <ul className="max-h-32 space-y-1 overflow-y-auto text-[10px]">
            {packet.trid_references.slice(0, 20).map((t) => (
              <li
                key={`${t.trid_key}:${t.source_row_id}`}
                className="rounded border border-slate-200 px-2 py-1 font-mono dark:border-slate-700"
              >
                <span className="text-sky-700 dark:text-sky-300">{t.trid_key || "—"}</span>
                <span className="text-slate-500"> · {t.source_table} </span>
                <span className="text-slate-600">{t.source_row_id}</span>
                <span className="text-slate-500"> conf {Math.round(t.confidence_score * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {packet.lineage_links.length > 0 ? (
        <div>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-violet-800 dark:text-violet-200">
            Lineage links
          </h4>
          <ul className="max-h-28 space-y-1 overflow-y-auto text-[10px]">
            {packet.lineage_links.slice(0, 12).map((l) => (
              <li key={l.id} className="rounded border border-slate-200 px-2 py-1 dark:border-slate-700">
                <span className="font-medium">{l.event_type}</span>
                <span className="text-slate-500"> · {l.producer}</span>
                {l.source_table ? (
                  <span className="text-slate-600">
                    {" "}
                    · {l.source_table}
                    {l.source_row_id ? ` / ${l.source_row_id}` : ""}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!ready}
          title={ready ? "Download JSON packet" : "Complete filing readiness gate before download"}
          onClick={() =>
            downloadJson(`claim-filing-packet-preview-${draftId.slice(0, 8)}.json`, packet)
          }
          className="inline-flex items-center gap-1 rounded border border-violet-400 bg-white px-2 py-1 text-[10px] font-medium text-violet-900 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-700 dark:bg-slate-900 dark:text-violet-100"
        >
          <Download className="h-3 w-3" />
          Download preview JSON
        </button>
        {!ready ? (
          <span className="self-center text-[10px] text-amber-800 dark:text-amber-200">
            Download enabled when filing readiness is Ready (view always allowed).
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void load()}
          className="rounded border border-slate-300 px-2 py-1 text-[10px] text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300"
        >
          Refresh packet
        </button>
      </div>

      <button
        type="button"
        onClick={() => setJsonOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] font-medium text-slate-600 dark:text-slate-400"
      >
        {jsonOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Raw packet JSON
      </button>
      {jsonOpen ? (
        <pre className="max-h-56 overflow-auto rounded border border-slate-200 bg-white p-2 text-[9px] dark:border-slate-700 dark:bg-slate-900">
          {JSON.stringify(packet, null, 2)}
        </pre>
      ) : null}
    </section>
  );
}
