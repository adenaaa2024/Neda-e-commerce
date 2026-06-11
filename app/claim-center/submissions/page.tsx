"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { ClaimCenterPageShell } from "@/components/claim-center/ClaimCenterPageShell";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";

type SubmissionRow = {
  id: string;
  status: string | null;
  claim_amount: number | null;
  return_id: string | null;
  created_at: string | null;
};

export default function ClaimCenterSubmissionsPage() {
  const { fetchJson, storeId } = useClaimCenter();
  const [items, setItems] = useState<SubmissionRow[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await fetchJson<{ items: SubmissionRow[]; bridge_note?: string }>("/api/claims/center/submissions");
    setItems(data.items ?? []);
    setNote(data.bridge_note ?? null);
    setLoading(false);
  }, [fetchJson]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  return (
    <ClaimCenterPageShell
      title="Submissions"
      description="Legacy return-linked submissions. Event-based opportunities are not yet in the submission queue."
    >
      {note ? (
        <div className="claim-center-card mb-4 rounded-xl p-3 text-xs opacity-80">{note}</div>
      ) : null}
      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="claim-center-table-card overflow-x-auto">
          <table className="claim-center-table w-full text-sm">
            <thead className="text-xs uppercase opacity-70">
              <tr>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Return</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3 text-left">Created</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center opacity-60">
                    No submissions in scope.
                  </td>
                </tr>
              ) : (
                items.map((s) => (
                  <tr key={s.id} className="border-t">
                    <td className="px-4 py-3">{s.status ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-xs">{s.return_id ?? "—"}</td>
                    <td className="px-4 py-3 text-right">{s.claim_amount ?? "—"}</td>
                    <td className="px-4 py-3 text-xs">{s.created_at ?? "—"}</td>
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
