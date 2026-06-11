"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { ClaimCenterPageShell } from "@/components/claim-center/ClaimCenterPageShell";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";

type RunsPayload = {
  discovery_index?: Record<string, unknown> | null;
  intake_runs?: Array<{ run_id: string; candidate_count: number }>;
};

export default function ClaimCenterRunsPage() {
  const { fetchJson, storeId } = useClaimCenter();
  const [data, setData] = useState<RunsPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const payload = await fetchJson<RunsPayload>("/api/claims/center/runs");
    setData(payload);
    setLoading(false);
  }, [fetchJson]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  return (
    <ClaimCenterPageShell
      title="Recovery scans"
      description="Scheduled generator runs and discovery index state. Read-only operational visibility."
    >
      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-6">
          <section className="claim-center-card rounded-xl p-4">
            <h2 className="text-sm font-semibold">Intake runs</h2>
            {(data?.intake_runs ?? []).length === 0 ? (
              <p className="mt-2 text-sm opacity-60">No intake runs in scope.</p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {(data?.intake_runs ?? []).map((r) => (
                  <li key={r.run_id} className="flex justify-between border-b py-2">
                    <span className="font-mono text-xs">{r.run_id}</span>
                    <span>{r.candidate_count} opportunities</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="claim-center-card rounded-xl p-4">
            <h2 className="text-sm font-semibold">Discovery index</h2>
            <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-black/5 p-3 text-xs dark:bg-white/5">
              {JSON.stringify(data?.discovery_index ?? {}, null, 2)}
            </pre>
          </section>
        </div>
      )}
    </ClaimCenterPageShell>
  );
}
