import { buildAttentionList } from "./claim-center-money-contract";
import {
  QUEUE_SEMANTICS_NOTES,
  computeQueueCounts,
  filterBlockedMoneyRows,
  filterFindMoneyRows,
  filterObservedRecoveryRows,
  filterProofRows,
  filterProductLinkageRows,
  filterReferencesRows,
  filterReviewRows,
} from "./claim-center-queue-semantics";
import { getClaimCenterListSelect } from "./claim-center-candidate-select";
import {
  aggregateDashboardKpis,
  buildClaimCenterListResponse,
  buildQueryMeta,
  countActiveCandidatesForOrg,
  fetchActiveCandidatesForOrg,
  loadEffectiveClaimIntakePolicy,
} from "./claim-center-v1-read-model";
import {
  buildClaimCenterPolicyContext,
  type ClaimCenterPolicyContext,
} from "../intake/claim-intake-policy-contract";
import { filterPhysicalReturnMvpRows } from "./claim-center-physical-return-mvp";
import type { ClaimCenterV1Row, ClaimCenterV1StatusGroup } from "./claim-center-v1-types";
import {
  CLAIM_CENTER_DASHBOARD_SAMPLE_LIMIT,
  CLAIM_CENTER_LINKAGE_SCAN_LIMIT,
  CLAIM_CENTER_OPPORTUNITIES_SCAN_LIMIT,
  CLAIM_CENTER_REFERENCES_SCAN_LIMIT,
} from "./claim-center-ui-copy";
import { evaluateClaimCenterModuleAccess } from "./claim-center-module-gate";
import { evaluateMenorixAiModuleAccess } from "@/lib/menorix/evaluate-menorix-ai-module-access";
import { loadDiscoveryIndexState } from "@/lib/claims/discovery/claim-discovery-index";
import { buildSourceConnectorReadiness } from "@/lib/claims/connectors/source-connector-readmodel";
import { buildClaimFamilyAlgorithmMatrixPayload } from "@/lib/claims/center/claim-family-algorithm-readmodel";
import { buildClaimFamilyAlgorithmV3Payload } from "@/lib/claims/center/claim-family-algorithm-v3-readmodel";
import { buildFirstSafeFamiliesPreviewGenerators } from "@/lib/claims/center/claim-first-safe-families-preview-generators-v1";
import {
  buildClaimGroupingReadmodel,
  type GroupingFilterParams,
} from "@/lib/claims/grouping/claim-grouping-readmodel";
import { buildClaimPreviewReadmodelMvp } from "@/lib/claims/center/claim-preview-readmodel-mvp-v1";
import type { ClaimPreviewMvpFamilyKey } from "@/lib/claims/center/claim-preview-readmodel-mvp-v1";
import { CLAIM_PREVIEW_MVP_FAMILIES } from "@/lib/claims/center/claim-preview-readmodel-mvp-v1";
import { buildClaimPilotReviewReadmodel } from "@/lib/claims/pilot/claim-pilot-review-readmodel";
import type { ClaimPilotReviewQuery } from "@/lib/claims/pilot/claim-pilot-review-readmodel";
import {
  composeClaimEvidencePacketV1,
  type ComposeEvidencePacketV1Query,
} from "@/lib/claims/evidence/claim-evidence-packet-v1";
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
    physicalReturnMvpOnly?: boolean;
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

  let rows = await buildClaimCenterListResponse(supabaseServer, organizationId, raw, {
    storeId: opts.storeId,
  });

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

  if (opts.physicalReturnMvpOnly !== false) {
    rows = filterPhysicalReturnMvpRows(rows);
  }

  return rows;
}

async function loadCenterPolicyContext(
  organizationId: string,
  storeId: string | null,
): Promise<ClaimCenterPolicyContext> {
  const policy = await loadEffectiveClaimIntakePolicy(supabaseServer, organizationId, storeId);
  return buildClaimCenterPolicyContext(policy);
}

export async function getCenterDashboardPayload(organizationId: string, storeId: string | null) {
  await centerModuleGateOrThrow(organizationId);
  const sampleLimit = CLAIM_CENTER_DASHBOARD_SAMPLE_LIMIT;
  const [rows, dbTotal, policy_context] = await Promise.all([
    fetchCenterCandidateRows(organizationId, { storeId, limit: sampleLimit }),
    countActiveCandidatesForOrg(supabaseServer, organizationId, { storeId: storeId ?? undefined }),
    loadCenterPolicyContext(organizationId, storeId),
  ]);
  const kpis = aggregateDashboardKpis(rows);
  const attention = buildAttentionList(rows, 8);
  const opportunities = attention;
  const queue_counts = computeQueueCounts(rows);
  const meta = buildQueryMeta({
    itemsReturned: rows.length,
    totalScanned: rows.length,
    sampleLimit,
    dbTotalCount: dbTotal,
  });
  return { kpis, opportunities, attention, queue_counts, meta, policy_context };
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
        : "Review automation schedules and source enablement in Platform Automation or workspace claim settings.",
    last_run_at: lastAt,
    enabled_sources: enabledSources,
    warnings: warnings.length ? warnings : undefined,
    intake_runs: runs.intake_runs,
  };
}

function exposureSortKey(row: ClaimCenterV1Row): number {
  const known = row.money_display?.expected_recovery_value;
  if (known != null && known > 0) return known;
  return -1;
}

export async function getCenterOpportunitiesPayload(organizationId: string, storeId: string | null, limit: number) {
  await centerModuleGateOrThrow(organizationId);
  const scanLimit = CLAIM_CENTER_OPPORTUNITIES_SCAN_LIMIT;
  const rows = await fetchCenterCandidateRows(organizationId, { storeId, limit: scanLimit });
  const findMoney = filterFindMoneyRows(rows);
  const blockedMoney = filterBlockedMoneyRows(rows);
  const sorted = [...findMoney].sort((a, b) => exposureSortKey(b) - exposureSortKey(a));
  const items = sorted.slice(0, limit);
  const meta = buildQueryMeta({
    itemsReturned: items.length,
    totalScanned: rows.length,
    sampleLimit: scanLimit,
  });
  const policy_context = await loadCenterPolicyContext(organizationId, storeId);
  return {
    items,
    blocked_money_items: blockedMoney.slice(0, limit),
    queue_note: QUEUE_SEMANTICS_NOTES.find_money,
    queue_counts: computeQueueCounts(rows),
    meta,
    policy_context,
  };
}

export async function getCenterReviewPayload(organizationId: string, storeId: string | null, limit: number) {
  await centerModuleGateOrThrow(organizationId);
  const scanLimit = CLAIM_CENTER_OPPORTUNITIES_SCAN_LIMIT;
  const rows = await fetchCenterCandidateRows(organizationId, { storeId, limit: scanLimit });
  const filtered = filterReviewRows(rows);
  const items = filtered.slice(0, limit);
  const meta = buildQueryMeta({
    itemsReturned: items.length,
    totalScanned: rows.length,
    sampleLimit: scanLimit,
  });
  const policy_context = await loadCenterPolicyContext(organizationId, storeId);
  return { items, meta, queue_note: QUEUE_SEMANTICS_NOTES.review, policy_context };
}

export async function getCenterEvidencePayload(organizationId: string, storeId: string | null, limit: number) {
  await centerModuleGateOrThrow(organizationId);
  const scanLimit = CLAIM_CENTER_OPPORTUNITIES_SCAN_LIMIT;
  const rows = await fetchCenterCandidateRows(organizationId, { storeId, limit: scanLimit });
  const filtered = filterProofRows(rows);
  const items = filtered.slice(0, limit);
  const meta = buildQueryMeta({
    itemsReturned: items.length,
    totalScanned: rows.length,
    sampleLimit: scanLimit,
  });
  const policy_context = await loadCenterPolicyContext(organizationId, storeId);
  return { items, meta, queue_note: QUEUE_SEMANTICS_NOTES.proof, policy_context };
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

  const rows = await fetchCenterCandidateRows(organizationId, { storeId, limit: CLAIM_CENTER_REFERENCES_SCAN_LIMIT });
  const materialized = filterReferencesRows(rows);
  const items = materialized.slice(0, limit);
  const meta = buildQueryMeta({
    itemsReturned: items.length,
    totalScanned: rows.length,
    sampleLimit: CLAIM_CENTER_REFERENCES_SCAN_LIMIT,
  });
  const references_not_materialized = rows.length > 0 && materialized.length === 0;
  return {
    items,
    ambiguity_count: materialized.filter((r) => r.ambiguity_pending).length,
    references_not_materialized,
    empty_message: references_not_materialized
      ? "References not materialized yet — run reference edge discovery or wait for TRID materialization."
      : null,
    queue_note: QUEUE_SEMANTICS_NOTES.references,
    meta,
    policy_context: await loadCenterPolicyContext(organizationId, storeId),
  };
}

export async function getCenterProductLinkagePayload(organizationId: string, storeId: string | null, limit: number) {
  await centerModuleGateOrThrow(organizationId);
  const rows = await fetchCenterCandidateRows(organizationId, { storeId, limit: CLAIM_CENTER_LINKAGE_SCAN_LIMIT });
  const unlinked = filterProductLinkageRows(rows);
  const items = unlinked.slice(0, limit);
  const meta = buildQueryMeta({
    itemsReturned: items.length,
    totalScanned: rows.length,
    sampleLimit: CLAIM_CENTER_LINKAGE_SCAN_LIMIT,
  });
  return {
    items,
    stats: {
      total: rows.length,
      linked: rows.length - unlinked.length,
      unlinked: unlinked.length,
      linkage_pct: rows.length ? Math.round(((rows.length - unlinked.length) / rows.length) * 1000) / 10 : 0,
    },
    meta,
    policy_context: await loadCenterPolicyContext(organizationId, storeId),
  };
}

export async function getCenterRecoveryPayload(organizationId: string, storeId: string | null, limit: number) {
  await centerModuleGateOrThrow(organizationId);
  const rows = await fetchCenterCandidateRows(organizationId, { storeId, limit: CLAIM_CENTER_LINKAGE_SCAN_LIMIT });
  const observed = filterObservedRecoveryRows(rows);
  const items = observed.slice(0, limit);
  const meta = buildQueryMeta({
    itemsReturned: items.length,
    totalScanned: rows.length,
    sampleLimit: CLAIM_CENTER_LINKAGE_SCAN_LIMIT,
  });
  return {
    items,
    meta,
    queue_note: QUEUE_SEMANTICS_NOTES.recovery,
    empty_message:
      items.length === 0 ? "No observed reimbursements linked yet." : null,
    policy_context: await loadCenterPolicyContext(organizationId, storeId),
  };
}

export async function getCenterSourcesPayload(organizationId: string, storeId: string | null) {
  await centerModuleGateOrThrow(organizationId);
  const [runs, automation, policy_context, connector_readiness] = await Promise.all([
    getCenterRunsPayload(organizationId, storeId),
    getCenterAutomationHealthPayload(organizationId, storeId),
    loadCenterPolicyContext(organizationId, storeId),
    buildSourceConnectorReadiness(supabaseServer, organizationId, storeId),
  ]);
  const enabled = policy_context.effective_policy.enabled_sources;
  const discoverySources = runs.discovery_index as {
    sources?: Record<string, { enabled?: boolean; last_run_at?: string | null }>;
  } | null;
  const source_cards = enabled.map((kind) => {
    const disc = discoverySources?.sources?.[kind];
    const warnings: string[] = [];
    if (!disc?.enabled) warnings.push("source_disabled_by_policy");
    if (!disc?.last_run_at) warnings.push("No successful run recorded yet.");
    return {
      source_kind: kind,
      enabled_in_policy: true,
      discovery_enabled: disc?.enabled ?? false,
      last_run_at: disc?.last_run_at ?? null,
      warnings,
    };
  });
  return {
    ...runs,
    automation_health: automation,
    source_cards,
    policy_context,
    connector_readiness,
    source_health_payload: connector_readiness.source_health,
    claim_readiness_payload: connector_readiness.claim_readiness,
    trid_readiness_payload: connector_readiness.trid_readiness,
    product_story_readiness_payload: connector_readiness.product_story_readiness,
    orbit_fra_readiness_payload: connector_readiness.orbit_fra_readiness,
    file_api_connector_readiness: connector_readiness.file_api_connector_readiness,
    removal_source_supersession_payload: connector_readiness.removal_source_supersession,
  };
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

/** Read-only claim family algorithm contract — no DB reads beyond module gate. */
export async function getCenterAlgorithmMatrixPayload(organizationId: string) {
  await centerModuleGateOrThrow(organizationId);
  return buildClaimFamilyAlgorithmMatrixPayload();
}

/** Read-only V3 algorithm matrix + AI optional contract — SELECT module gate + AI flags only. */
export async function getCenterAlgorithmMatrixV3Payload(organizationId: string) {
  await centerModuleGateOrThrow(organizationId);
  const aiAccess = await evaluateMenorixAiModuleAccess(supabaseServer, organizationId);
  return buildClaimFamilyAlgorithmV3Payload({ ai_module_access: aiAccess });
}

/** Read-only MVP claim preview items — generator dry-run only, no claim_candidates writes. */
export async function getCenterClaimPreviewPayload(args: {
  organizationId: string;
  storeId: string;
  limit: number;
  from?: string | null;
  to?: string | null;
  family?: string | null;
}) {
  await centerModuleGateOrThrow(args.organizationId);
  const families =
    args.family &&
    (CLAIM_PREVIEW_MVP_FAMILIES as readonly string[]).includes(args.family)
      ? ([args.family] as ClaimPreviewMvpFamilyKey[])
      : undefined;
  return buildClaimPreviewReadmodelMvp({
    client: supabaseServer,
    organizationId: args.organizationId,
    storeId: args.storeId,
    from: args.from,
    to: args.to,
    rowLimit: args.limit,
    families,
  });
}

/** Read-only first safe family preview generators — no claim_candidates writes. */
export async function getCenterPreviewGeneratorsPayload(args: {
  organizationId: string;
  storeId: string;
  limit: number;
  from?: string | null;
  to?: string | null;
}) {
  await centerModuleGateOrThrow(args.organizationId);
  return buildFirstSafeFamiliesPreviewGenerators({
    client: supabaseServer,
    organizationId: args.organizationId,
    storeId: args.storeId,
    from: args.from,
    to: args.to,
    rowLimit: args.limit,
    prerequisite_safe: "yes",
  });
}

/** Read-only grouping/filter preview over preview-generator output — no case creation. */
export async function getCenterGroupingPreviewPayload(args: {
  organizationId: string;
  storeId: string;
  filters: GroupingFilterParams;
  from?: string | null;
  to?: string | null;
}) {
  await centerModuleGateOrThrow(args.organizationId);
  return buildClaimGroupingReadmodel({
    client: supabaseServer,
    organizationId: args.organizationId,
    storeId: args.storeId,
    filters: args.filters,
    from: args.from,
    to: args.to,
  });
}

/** Read-only original pilot candidate review — scoped by intake_run_id; no writes. */
export async function getCenterPilotReviewPayload(args: {
  organizationId: string;
  storeId: string;
  query: ClaimPilotReviewQuery;
}) {
  await centerModuleGateOrThrow(args.organizationId);
  return buildClaimPilotReviewReadmodel(
    supabaseServer,
    args.organizationId,
    args.storeId,
    args.query,
  );
}

/** Read-only evidence packet V1 preview — no writes, no PDF. */
export async function getCenterEvidencePacketPayload(args: {
  organizationId: string;
  storeId: string;
  query: ComposeEvidencePacketV1Query;
}) {
  await centerModuleGateOrThrow(args.organizationId);
  return composeClaimEvidencePacketV1(
    supabaseServer,
    args.organizationId,
    args.storeId,
    args.query,
  );
}
