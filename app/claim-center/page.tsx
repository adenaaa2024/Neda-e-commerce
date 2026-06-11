"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import type { MenorixAiAssistState, MenorixAutomationHealth } from "@/components/menorix";
import { ClaimCenterCommandDashboard } from "@/components/claim-center/ClaimCenterCommandDashboard";
import { useClaimCenter } from "@/components/claim-center/ClaimCenterRootClient";
import type { ClaimCenterDashboardKpis, ClaimCenterV1Row } from "@/lib/claims/center/claim-center-v1-types";

export default function ClaimCenterDashboardPage() {
  const { fetchJson, setSelectedRow, storeId } = useClaimCenter();
  const [kpis, setKpis] = useState<ClaimCenterDashboardKpis | null>(null);
  const [opportunities, setOpportunities] = useState<ClaimCenterV1Row[]>([]);
  const [referenceConflictCount, setReferenceConflictCount] = useState(0);
  const [aiState, setAiState] = useState<MenorixAiAssistState>("locked");
  const [automationHealth, setAutomationHealth] = useState<MenorixAutomationHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [dash, refs, ai, auto] = await Promise.all([
        fetchJson<{ kpis: ClaimCenterDashboardKpis; opportunities: ClaimCenterV1Row[] }>("/api/claims/center/dashboard"),
        fetchJson<{ ambiguity_count?: number }>("/api/claims/center/references"),
        fetchJson<{ state: MenorixAiAssistState }>("/api/claims/center/ai-access"),
        fetchJson<MenorixAutomationHealth>("/api/claims/center/automation-health"),
      ]);
      setKpis(dash.kpis);
      setOpportunities(dash.opportunities ?? []);
      setReferenceConflictCount(refs.ambiguity_count ?? 0);
      setAiState(ai.state ?? "locked");
      setAutomationHealth(auto);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load dashboard.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm opacity-70">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading dashboard…
      </div>
    );
  }

  if (error) return <p className="text-sm text-red-500">{error}</p>;
  if (!kpis) return null;

  return (
    <ClaimCenterCommandDashboard
      kpis={kpis}
      opportunities={opportunities}
      referenceConflictCount={referenceConflictCount}
      aiState={aiState}
      automationHealth={automationHealth ?? undefined}
      onSelectRow={setSelectedRow}
    />
  );
}
