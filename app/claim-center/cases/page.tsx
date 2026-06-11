"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { ClaimCenterPageShell } from "@/components/claim-center/ClaimCenterPageShell";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";

type CaseRow = {
  id: string;
  status: string | null;
  scanner_issue_type: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export default function ClaimCenterCasesPage() {
  const { fetchJson, storeId } = useClaimCenter();
  const [items, setItems] = useState<CaseRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await fetchJson<{ items: CaseRow[] }>("/api/claims/center/cases");
    setItems(data.items ?? []);
    setLoading(false);
  }, [fetchJson]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  return (
    <ClaimCenterPageShell
      title="Cases"
      description="Promoted claim cases (read-only). Candidate → case bridge is not yet available for event-based opportunities."
    >
      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="claim-center-table-card overflow-x-auto">
          <table className="claim-center-table w-full text-sm">
            <thead className="text-xs uppercase opacity-70">
              <tr>
                <th className="px-4 py-3 text-left">Case</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Created</th>
                <th className="px-4 py-3 text-left">Issue</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center opacity-60">
                    No cases in scope.
                  </td>
                </tr>
              ) : (
                items.map((c) => (
                  <tr key={c.id} className="border-t">
                    <td className="px-4 py-3 font-mono text-xs">{c.id}</td>
                    <td className="px-4 py-3">{c.status ?? "—"}</td>
                    <td className="px-4 py-3 text-xs">{c.created_at ?? "—"}</td>
                    <td className="px-4 py-3 text-xs">{c.scanner_issue_type ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </ClaimCenterPageShell>
  );
}
