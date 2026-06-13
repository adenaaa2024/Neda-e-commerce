"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { ClaimCenterBridgePhaseNotice } from "@/components/claim-center/ClaimCenterBridgePhaseNotice";
import { ClaimCenterV2PageShell } from "@/components/claim-center/ClaimCenterV2PageShell";
import { getClaimCenterV2Page } from "@/lib/claims/center/claim-center-v2-page-contract";
import { ClaimCenterSectionEmptyState } from "@/components/claim-center/ClaimCenterSectionEmptyState";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import { CLAIM_CENTER_SECTION_EMPTY } from "@/lib/claims/center/claim-center-ui-copy";

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

  const contract = getClaimCenterV2Page("cases");

  return (
    <ClaimCenterV2PageShell contract={contract}>
      <div className="claim-center-card mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs">
        <span className="font-bold uppercase text-amber-800 dark:text-amber-200">Legacy</span>
        <p className="mt-1 opacity-90">Not-built in Claim Center V2 — case promotion requires the write bridge phase.</p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <ClaimCenterSectionEmptyState config={CLAIM_CENTER_SECTION_EMPTY.cases} />
      ) : (
        <>
          <div className="hidden md:block claim-center-table-card overflow-x-auto">
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
                {items.map((c) => (
                  <tr key={c.id} className="border-t">
                    <td className="px-4 py-3 font-mono text-xs">{c.id}</td>
                    <td className="px-4 py-3">{c.status ?? "—"}</td>
                    <td className="px-4 py-3 text-xs">{c.created_at ?? "—"}</td>
                    <td className="px-4 py-3 text-xs">{c.scanner_issue_type ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-3 md:hidden">
            {items.map((c) => (
              <li key={c.id} className="claim-center-mobile-card p-4 text-sm">
                <p className="font-mono text-xs">{c.id}</p>
                <p className="mt-1 font-semibold">{c.status ?? "—"}</p>
                <p className="mt-1 text-xs opacity-70">{c.scanner_issue_type ?? "—"}</p>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="mt-4">
        <ClaimCenterBridgePhaseNotice compact />
      </div>
    </ClaimCenterV2PageShell>
  );
}
