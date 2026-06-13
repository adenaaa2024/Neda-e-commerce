"use client";

import { useEffect, useMemo, useState } from "react";

import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

type EdgeGroup = Record<string, unknown[]>;

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const inner = (
    <>
      {!embedded ? <h3 className="text-sm font-semibold">Amazon references</h3> : null}
      <p className={`text-xs opacity-70 ${embedded ? "" : "mt-1"}`}>
        Read-only TRID graph summary — shipment, order, package, tracking, removal, and transaction edges grouped by
        kind. Confidence is inferred from edge materialization only.
      </p>
      {row.ambiguity_pending ? (
        <div className="mt-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-200">
          <p className="font-semibold">Reference ambiguity (read-only)</p>
          <p className="mt-1 opacity-90">
            Multiple edges match this opportunity. Resolve in Claim Engine review-ops when the write bridge opens.
          </p>
        </div>
      ) : null}
      <p className="mt-2 text-xs opacity-70">
        {row.reference_edge_count} materialized edge{row.reference_edge_count === 1 ? "" : "s"}
        {row.amazon_reference_id ? ` · Primary: ${row.amazon_reference_id}` : ""}
        {row.reference_type ? ` · Type: ${row.reference_type}` : ""}
      </p>
      {loading ? <p className="mt-2 text-xs opacity-60">Loading…</p> : null}
      {error ? <p className="mt-2 text-xs text-red-500">{error}</p> : null}
      {ambiguityGroups.length > 0 ? (
        <ul className="mt-3 space-y-2 text-xs">
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
        <ul className="mt-3 space-y-2 text-xs">
          {Object.entries(grouped).map(([kind, edges]) => (
            <li key={kind}>
              <span className="font-medium">{kind}</span> ({edges.length})
            </li>
          ))}
        </ul>
      ) : !loading && !error ? (
        <p className="mt-2 text-xs opacity-60">No reference edges materialized yet for this candidate.</p>
      ) : null}
    </>
  );

  if (embedded) return <div className="mt-2">{inner}</div>;

  return (
    <section className="claim-center-card mb-4 rounded-xl p-3">
      {inner}
    </section>
  );
}
