import { getClaimCenterListSelect } from "./claim-center-candidate-select";
import {
  aggregateDashboardKpis,
  buildClaimCenterListResponse,
  fetchActiveCandidatesForOrg,
} from "./claim-center-v1-read-model";
import type { ClaimCenterV1Row, ClaimCenterV1StatusGroup } from "./claim-center-v1-types";
import { evaluateClaimCenterModuleAccess } from "./claim-center-module-gate";
import { evaluateMenorixAiModuleAccess } from "@/lib/menorix/evaluate-menorix-ai-module-access";
import { loadDiscoveryIndexState } from "@/lib/claims/discovery/claim-discovery-index";
import { loadMaterializedCandidateEdges } from "@/lib/claims/edges/claim-reference-edge-materializer";
import { supabaseServer } from "@/lib/supabase-server";

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

export async function centerModuleGateOrThrow(organizationId: string) {
  const access = await evaluateClaimCenterModuleAccess(supabaseServer, organizationId);
  if (!access.enabled) {
    throw new CenterApiError(access.reason ?? "Claim Center module disabled.", 403);
  }
  return access;
}

export class CenterApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function fetchCenterCandidateRows(
  organizationId: string,
  opts: {
    storeId: string | null;
    limit: number;
    includeQuarantined?: boolean;
    includeLegacySeed?: boolean;
    statusGroup?: ClaimCenterV1StatusGroup | null;
    sourceKind?: string | null;
    v1StatusGroups?: ClaimCenterV1StatusGroup[];
  },
): Promise<ClaimCenterV1Row[]> {
  const listSelect = await getClaimCenterListSelect(supabaseServer);
  const raw = await fetchActiveCandidatesForOrg(supabaseServer, organizationId, {
    storeId: opts.storeId,
    listSelect,
    limit: opts.limit,
    includeQuarantined: opts.includeQuarantined,
    includeLegacySeed: opts.includeLegacySeed,
  });

  let rows = await buildClaimCenterListResponse(supabaseServer, organizationId, raw);

  if (opts.sourceKind) {
    rows = rows.filter((r) => r.source_kind === opts.sourceKind);
  }
  if (opts.statusGroup) {
    rows = rows.filter((r) => r.v1_status_group === opts.statusGroup);
  }
  if (opts.v1StatusGroups?.length) {
    const set = new Set(opts.v1StatusGroups);
    rows = rows.filter((r) => set.has(r.v1_status_group));
  }

  return rows;
}

export async function getCenterDashboardPayload(organizationId: string, storeId: string | null) {
  await centerModuleGateOrThrow(organizationId);
  const rows = await fetchCenterCandidateRows(organizationId, {
    storeId,
    limit: 500,
  });
  const kpis = aggregateDashboardKpis(rows);
  const opportunities = [...rows]
    .filter((r) => r.v1_status_group === "new" || r.v1_status_group === "evidence_ready" || r.v1_status_group === "ready_to_file")
    .sort((a, b) => (b.recovery_value ?? 0) - (a.recovery_value ?? 0))
    .slice(0, 8);
  return { kpis, opportunities, sample_count: rows.length };
}

export async function getCenterAiAccessPayload(organizationId: string) {
  await centerModuleGateOrThrow(organizationId);
  return evaluateMenorixAiModuleAccess(supabaseServer, organizationId);
}

export async function getCenterAutomationHealthPayload(organizationId: string, storeId: string | null) {
  await centerModuleGateOrThrow(organizationId);
  const runs = await getCenterRunsPayload(organizationId, storeId);
  const index = runs.discovery_index as {
    last_watermark_at?: string | null;
    sources?: Record<string, { enabled?: boolean; last_run_at?: string | null }>;
  } | null;

  const enabledSources = index?.sources
    ? Object.entries(index.sources)
        .filter(([, v]) => v?.enabled === true)
        .map(([k]) => k)
    : [];

  const lastAt = str(index?.last_watermark_at) ?? null;
  const warnings: string[] = [];
  if (!enabledSources.length) warnings.push("No discovery sources appear enabled.");
  if (!lastAt) warnings.push("Discovery index has no recent watermark.");

  const status = warnings.length >= 2 ? "degraded" : warnings.length === 1 ? "degraded" : lastAt ? "healthy" : "unknown";

  return {
    status,
    label: status === "healthy" ? "Healthy" : status === "degraded" ? "Needs attention" : "Unknown",
    detail:
      status === "healthy"
        ? "Scheduled scans and discovery index are active."
        : "Review automation schedules and source enablement in Settings.",
    last_run_at: lastAt,
    enabled_sources: enabledSources,
    warnings: warnings.length ? warnings : undefined,
    intake_runs: runs.intake_runs,
  };
}

export async function getCenterOpportunitiesPayload(organizationId: string, storeId: string | null, limit: number) {
  await centerModuleGateOrThrow(organizationId);
  const rows = await fetchCenterCandidateRows(organizationId, { storeId, limit: 800 });
  const filtered = rows
    .filter(
      (r) =>
        r.v1_status_group === "new" ||
        r.v1_status_group === "evidence_ready" ||
        r.v1_status_group === "ready_to_file" ||
        r.canonical_window.status === "closing_soon",
    )
    .sort((a, b) => (b.recovery_value ?? 0) - (a.recovery_value ?? 0))
    .slice(0, limit);
  return { items: filtered, total_scanned: rows.length };
}

export async function getCenterReviewPayload(organizationId: string, storeId: string | null, limit: number) {
  await centerModuleGateOrThrow(organizationId);
  const rows = await fetchCenterCandidateRows(organizationId, {
    storeId,
    limit: 800,
    v1StatusGroups: [
      "needs_review",
      "blocked_product_link",
      "blocked_reference_conflict",
      "evidence_ready",
    ],
  });
  return { items: rows.slice(0, limit), total_scanned: rows.length };
}

export async function getCenterReferencesPayload(
  organizationId: string,
  storeId: string | null,
  candidateId: string | null,
  limit: number,
) {
  await centerModuleGateOrThrow(organizationId);

  if (candidateId) {
    const edges = await loadMaterializedCandidateEdges(supabaseServer, organizationId, [candidateId]);
    const list = edges.get(candidateId) ?? [];
    const grouped: Record<string, unknown[]> = {};
    for (const e of list) {
      const kind = str(e.reference_kind) ?? "unknown";
      grouped[kind] = grouped[kind] ?? [];
      grouped[kind].push(e);
    }
    return { candidate_id: candidateId, grouped, total: list.length };
  }

  const rows = await fetchCenterCandidateRows(organizationId, { storeId, limit: 400 });
  const withRefs = rows.filter((r) => r.reference_edge_count > 0 || r.reference_id);
  return {
    items: withRefs.slice(0, limit),
    ambiguity_count: withRefs.filter((r) => r.ambiguity_pending).length,
  };
}

export async function getCenterProductLinkagePayload(organizationId: string, storeId: string | null, limit: number) {
  await centerModuleGateOrThrow(organizationId);
  const rows = await fetchCenterCandidateRows(organizationId, { storeId, limit: 600 });
  const unlinked = rows.filter((r) => !r.product_linkage?.is_resolved);
  const linked = rows.length - unlinked.length;
  return {
    items: unlinked.slice(0, limit),
    stats: {
      total: rows.length,
      linked,
      unlinked: unlinked.length,
      linkage_pct: rows.length ? Math.round((linked / rows.length) * 1000) / 10 : 0,
    },
  };
}

export async function getCenterRecoveryPayload(organizationId: string, storeId: string | null, limit: number) {
  await centerModuleGateOrThrow(organizationId);
  const financialKinds = new Set(["reimbursement", "settlement", "transaction", "orbit_fra"]);
  const rows = await fetchCenterCandidateRows(organizationId, { storeId, limit: 600 });
  const financial = rows.filter((r) => financialKinds.has(r.source_kind ?? "") || !!r.reference_id);
  return { items: financial.slice(0, limit), total_scanned: rows.length };
}

export async function getCenterRunsPayload(organizationId: string, storeId: string | null) {
  await centerModuleGateOrThrow(organizationId);
  const index = await loadDiscoveryIndexState(supabaseServer, organizationId);

  let q = supabaseServer
    .from("claim_candidates")
    .select("intake_run_id")
    .eq("organization_id", organizationId)
    .not("intake_run_id", "is", null);
  if (storeId) q = q.eq("store_id", storeId);
  const { data: runRows } = await q.limit(2000);

  const runCounts = new Map<string, number>();
  for (const r of (runRows ?? []) as Array<{ intake_run_id?: string }>) {
    const id = str(r.intake_run_id);
    if (!id) continue;
    runCounts.set(id, (runCounts.get(id) ?? 0) + 1);
  }

  const runs = [...runCounts.entries()].map(([run_id, count]) => ({ run_id, candidate_count: count }));

  return {
    discovery_index: index,
    intake_runs: runs.slice(0, 50),
    store_id: storeId,
  };
}

export async function getCenterSubmissionsPayload(organizationId: string, storeId: string | null, limit: number) {
  await centerModuleGateOrThrow(organizationId);
  let q = supabaseServer
    .from("claim_submissions")
    .select("id, organization_id, store_id, return_id, status, claim_amount, submission_id, created_at, updated_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (storeId) q = q.eq("store_id", storeId);
  const { data, error } = await q;
  if (error) throw new CenterApiError(error.message, 500);
  return {
    items: data ?? [],
    bridge_note:
      "Event-based claim opportunities are not yet in the submission queue. Legacy submissions use return_item linkage.",
  };
}

export async function getCenterCasesPayload(organizationId: string, limit: number) {
  await centerModuleGateOrThrow(organizationId);
  const { data, error } = await supabaseServer
    .from("claim_cases")
    .select("id, status, scanner_issue_type, primary_return_item_id, created_at, updated_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new CenterApiError(error.message, 500);
  return { items: data ?? [] };
}

export async function getCenterModuleAccessPayload(organizationId: string) {
  return evaluateClaimCenterModuleAccess(supabaseServer, organizationId);
}
