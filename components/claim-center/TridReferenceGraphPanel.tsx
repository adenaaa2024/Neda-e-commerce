"use client";

import { useEffect, useState } from "react";

import type { ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

type EdgeGroup = Record<string, unknown[]>;

export function TridReferenceGraphPanel({
  row,
  organizationId,
}: {
  row: ClaimCenterV1Row;
  organizationId?: string;
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

  return (
    <section className="claim-center-card mb-4 rounded-xl p-3">
      <h3 className="text-sm font-semibold">Amazon references (TRID)</h3>
      {row.ambiguity_pending ? (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">Reference conflict — multiple candidates match.</p>
      ) : null}
      <p className="mt-1 text-xs opacity-70">
        {row.reference_edge_count} materialized edge{row.reference_edge_count === 1 ? "" : "s"}
        {row.amazon_reference_id ? ` · Primary: ${row.amazon_reference_id}` : ""}
      </p>
      {loading ? <p className="mt-2 text-xs opacity-60">Loading…</p> : null}
      {error ? <p className="mt-2 text-xs text-red-500">{error}</p> : null}
      {grouped && Object.keys(grouped).length > 0 ? (
        <ul className="mt-3 space-y-2 text-xs">
          {Object.entries(grouped).map(([kind, edges]) => (
            <li key={kind}>
              <span className="font-medium">{kind}</span> ({edges.length})
            </li>
          ))}
        </ul>
      ) : !loading && !error ? (
        <p className="mt-2 text-xs opacity-60">No reference edges materialized yet.</p>
      ) : null}
    </section>
  );
}
