"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { ClaimCenterBridgePhaseNotice } from "@/components/claim-center/ClaimCenterBridgePhaseNotice";
import { ClaimCenterV2PageShell } from "@/components/claim-center/ClaimCenterV2PageShell";
import { getClaimCenterV2Page } from "@/lib/claims/center/claim-center-v2-page-contract";
import { ClaimCenterSectionEmptyState } from "@/components/claim-center/ClaimCenterSectionEmptyState";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import { CLAIM_CENTER_SECTION_EMPTY } from "@/lib/claims/center/claim-center-ui-copy";

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

  const contract = getClaimCenterV2Page("submissions");

  return (
    <ClaimCenterV2PageShell contract={contract}>
      <div className="claim-center-card mb-4 space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
        <p className="font-semibold">
          <span className="mr-2 rounded bg-amber-500/25 px-1.5 py-0.5 text-[10px] uppercase">Legacy</span>
          Legacy read-only queue
        </p>
        <p className="text-xs opacity-80">
          {note ??
            "These rows come from claim_submissions tied to return items. Filing new submissions from opportunities requires the write bridge phase."}
        </p>
        <p className="text-xs opacity-70">
          Legacy filings only — use the <strong>Legacy tools</strong> menu for Claim Engine workflows. No submit or
          promote actions in Claim Center.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <ClaimCenterSectionEmptyState config={CLAIM_CENTER_SECTION_EMPTY.submissions} />
      ) : (
        <div className="hidden md:block claim-center-table-card overflow-x-auto">
          <table className="claim-center-table w-full min-w-[480px] text-sm">
            <thead className="text-xs uppercase opacity-70">
              <tr>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Return</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3 text-left">Created</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className="border-t">
                  <td className="px-4 py-3">{s.status ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs">{s.return_id ?? "—"}</td>
                  <td className="px-4 py-3 text-right">{s.claim_amount ?? "—"}</td>
                  <td className="px-4 py-3 text-xs">{s.created_at ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && items.length > 0 ? (
        <ul className="mt-4 space-y-3 md:hidden">
          {items.map((s) => (
            <li key={s.id} className="claim-center-mobile-card p-4 text-sm">
              <p className="font-semibold">{s.status ?? "—"}</p>
              <p className="mt-1 text-xs opacity-70">Return {s.return_id ?? "—"}</p>
              <p className="mt-1 text-xs">Amount {s.claim_amount ?? "—"}</p>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-4">
        <ClaimCenterBridgePhaseNotice compact />
      </div>
    </ClaimCenterV2PageShell>
  );
}
