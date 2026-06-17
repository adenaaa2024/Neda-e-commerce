/**
 * PHASE-7H-CLAIM-REFERENCE-EDGE-MATERIALIZATION-PILOT-ORIGINAL
 * Scoped materialization of claim_reference_edges for trusted open pilot cases only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";
import type { ClaimCaseReviewRow } from "../pilot/claim-case-review-readmodel";
import {
  summarizePost7hReports,
  verifyCaseReferenceGraphPost7h,
} from "../reference/claim-trid-reference-graph-reverify-after-7h-v1";
import type { CandidateSourceRow } from "../reference/claim-trid-reference-graph-verify-v1";
import { composeClaimFilingPacketPreviewV1 } from "../filing/claim-filing-packet-preview-v1";

export const PILOT_REFERENCE_EDGE_MATERIALIZATION_V1_VERSION =
  "claim-reference-edge-pilot-original-materializer-v1" as const;

export const PILOT_EDGE_MATERIALIZATION_ORIGIN = "pilot_reference_edge_materialization_v1" as const;

export const PILOT_EDGE_APPROVAL_TOKEN = "APPROVED_CLAIM_REFERENCE_EDGE_MATERIALIZATION_PILOT_V1" as const;

export const PILOT_EDGE_SCHEMA_MIGRATION_APPROVAL_TOKEN =
  "APPROVED_CLAIM_REFERENCE_EDGE_SCHEMA_MIGRATION_V1" as const;

export const SOURCE_DISCOVERY_EVIDENCE_GLOB =
  ".cursor/audit-reports/phase-7h-source-api-file-reference-discovery-v1" as const;

export const PILOT_EDGE_APPROVAL_PATH =
  ".cursor/operator-approvals/claim-reference-edge-materialization-pilot-v1-approval.md" as const;

export const PHASE_7H_MIGRATION_FILE =
  "supabase/migrations/20260917130000_phase7h_claim_reference_edges_candidate_anchor.sql";

export type PilotEdgeInsertRow = {
  organization_id: string;
  candidate_id: string;
  edge_type: "source_evidence";
  from_node_kind: string;
  from_source_table: string;
  from_source_row_id: string;
  to_node_kind: string;
  to_source_table: string | null;
  to_source_row_id: string | null;
  reference_kind: string;
  reference_value: string;
  confidence_score: number;
  ambiguity_group_key: null;
  ambiguity_rank: null;
  edge_reason: string;
  source_citations: Array<Record<string, unknown>>;
};

export type ExpectedPackageRow = {
  id: string;
  tracking_number: string | null;
  order_id: string | null;
  source_detail_row_id: string | null;
  source_shipment_row_id: string | null;
  metadata: Record<string, unknown>;
};

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function metaRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function looksLikeTracking(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  return /^TBA\d+/i.test(v) || /^\d{12,22}$/.test(v) || /^1Z[A-Z0-9]+$/i.test(v);
}

function tridFromMetadata(meta: Record<string, unknown>): string | null {
  const trid = str(meta.trid);
  if (trid) return trid;
  const productLink = str(meta.product_link);
  if (productLink) return productLink;
  return null;
}

function metadataReferenceEdges(meta: Record<string, unknown>): Array<{ kind: string; value: string }> {
  const raw = meta.reference_edges;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ kind: string; value: string }> = [];
  for (const item of raw) {
    const o = metaRecord(item);
    const kind = str(o.reference_kind);
    const value = str(o.reference_value);
    if (kind && value) out.push({ kind, value });
  }
  return out;
}

export function readPilotEdgeMaterializationApproval(raw: string): {
  approved: boolean;
  schemaMigrationApproved: boolean;
  raw: string;
  schemaMigrationRaw: string;
} {
  const approved = /^APPROVED_CLAIM_REFERENCE_EDGE_MATERIALIZATION_PILOT_V1\s*=\s*yes\s*$/im.test(raw);
  const schemaMigrationApproved =
    /^APPROVED_CLAIM_REFERENCE_EDGE_SCHEMA_MIGRATION_V1\s*=\s*yes\s*$/im.test(raw);
  return {
    approved,
    schemaMigrationApproved,
    raw: approved ? "yes" : "no_or_missing",
    schemaMigrationRaw: schemaMigrationApproved ? "yes" : "no_or_missing",
  };
}

export function findLatestSourceDiscoveryEvidence(cwd: string, fsMod: typeof import("node:fs")): {
  found: boolean;
  path: string | null;
  run_id: string | null;
} {
  const base = `${cwd}/${SOURCE_DISCOVERY_EVIDENCE_GLOB}`;
  if (!fsMod.existsSync(base)) return { found: false, path: null, run_id: null };
  const runs = fsMod
    .readdirSync(base)
    .filter((d) => fsMod.statSync(`${base}/${d}`).isDirectory())
    .sort()
    .reverse();
  if (runs.length === 0) return { found: false, path: null, run_id: null };
  const runId = runs[0]!;
  const p = `${SOURCE_DISCOVERY_EVIDENCE_GLOB}/${runId}/results.json`;
  return { found: fsMod.existsSync(`${cwd}/${p}`), path: p, run_id: runId };
}

export function loadSourceDiscoveryPrerequisite(
  cwd: string,
  fsMod: typeof import("node:fs"),
): {
  completed: boolean;
  path: string | null;
  SAFE_SOURCE_REFERENCE_DISCOVERY_VERIFIED: string;
  SAFE_TO_EXECUTE_7H_REFERENCE_EDGE_MATERIALIZATION: string;
  pass: boolean;
} {
  const latest = findLatestSourceDiscoveryEvidence(cwd, fsMod);
  if (!latest.found || !latest.path) {
    return {
      completed: false,
      path: null,
      SAFE_SOURCE_REFERENCE_DISCOVERY_VERIFIED: "missing",
      SAFE_TO_EXECUTE_7H_REFERENCE_EDGE_MATERIALIZATION: "missing",
      pass: false,
    };
  }
  const data = JSON.parse(fsMod.readFileSync(`${cwd}/${latest.path}`, "utf8")) as Record<
    string,
    unknown
  >;
  const verified = String(data.SAFE_SOURCE_REFERENCE_DISCOVERY_VERIFIED ?? "").trim();
  const executeGate = String(data.SAFE_TO_EXECUTE_7H_REFERENCE_EDGE_MATERIALIZATION ?? "").trim();
  const pass =
    verified === "yes" &&
    (executeGate === "yes" || executeGate === "conditional_yes_pending_7h_approval_and_migration");
  return {
    completed: true,
    path: latest.path,
    SAFE_SOURCE_REFERENCE_DISCOVERY_VERIFIED: verified,
    SAFE_TO_EXECUTE_7H_REFERENCE_EDGE_MATERIALIZATION: executeGate,
    pass,
  };
}

export function buildPilotReferenceEdgesForCase(args: {
  row: ClaimCaseReviewRow;
  candidate: CandidateSourceRow;
  expectedPackage: ExpectedPackageRow | null;
  materializationRunId: string;
  pilotCaseRunId?: string;
  intakeRunId?: string;
}): PilotEdgeInsertRow[] {
  const line = args.row.lines[0];
  if (!line?.claim_candidate_id) return [];

  const orgId = args.row.organization_id;
  const candidateId = line.claim_candidate_id;
  const caseId = args.row.id;
  const lineId = line.id;
  const epId =
    args.candidate.source_table === "expected_packages"
      ? str(args.candidate.source_row_id)
      : str(args.expectedPackage?.id);
  const baseCitation = {
    materialization_origin: PILOT_EDGE_MATERIALIZATION_ORIGIN,
    materialization_run_id: args.materializationRunId,
    pilot_case_run_id: args.pilotCaseRunId ?? PILOT_CASE_RUN_ID,
    intake_run_id: args.intakeRunId ?? PILOT_INTAKE_RUN_ID,
    claim_case_id: caseId,
  };

  const edges: PilotEdgeInsertRow[] = [];

  const push = (
    referenceKind: string,
    referenceValue: string,
    toTable: string | null,
    toRowId: string | null,
    reason: string,
  ) => {
    if (!referenceValue) return;
    edges.push({
      organization_id: orgId,
      candidate_id: candidateId,
      edge_type: "source_evidence",
      from_node_kind: "claim_candidate",
      from_source_table: "claim_candidates",
      from_source_row_id: candidateId,
      to_node_kind: toTable ? "source_row" : "reference",
      to_source_table: toTable,
      to_source_row_id: toRowId,
      reference_kind: referenceKind,
      reference_value: referenceValue,
      confidence_score: 1.0,
      ambiguity_group_key: null,
      ambiguity_rank: null,
      edge_reason: reason,
      source_citations: [baseCitation],
    });
  };

  push("claim_case_id", caseId, "claim_cases", caseId, "pilot case anchor");
  push("claim_line_id", lineId, "claim_lines", lineId, "pilot line anchor");
  push("claim_candidate_id", candidateId, "claim_candidates", candidateId, "pilot candidate anchor");

  if (epId) {
    push("expected_package_id", epId, "expected_packages", epId, "expected package source anchor");
    push("expected_packages", epId, "expected_packages", epId, "expected package pointer");
  }

  if (str(args.candidate.source_table) && str(args.candidate.source_row_id)) {
    push(
      str(args.candidate.source_table),
      str(args.candidate.source_row_id),
      str(args.candidate.source_table),
      str(args.candidate.source_row_id),
      "candidate source-of-truth row",
    );
  }

  const tracking =
    str(args.expectedPackage?.tracking_number) ||
    (looksLikeTracking(str(args.row.source_event_key)) ? str(args.row.source_event_key) : "");
  if (tracking && args.row.family_key_v3 === "removal_shipment_missing") {
    push("tracking_number", tracking, null, null, "tracking reference from EP or source_event_key");
    push("tracking_reference", tracking, null, null, "tracking reference alias");
  }

  const epMeta = metaRecord(args.expectedPackage?.metadata);
  const removalOrderId =
    str(args.expectedPackage?.source_detail_row_id) ||
    str(epMeta.source_detail_row_id) ||
    str(epMeta.amazon_removal_id);
  if (removalOrderId && args.row.family_key_v3 === "removal_order_discrepancy") {
    push("removal_order_id", removalOrderId, "amazon_removals", removalOrderId, "resolved removal order");
    push("amazon_removals", removalOrderId, "amazon_removals", removalOrderId, "removal order row pointer");
  }

  const removalShipmentId =
    str(args.expectedPackage?.source_shipment_row_id) || str(epMeta.source_shipment_row_id);
  if (removalShipmentId && args.row.family_key_v3 === "removal_shipment_missing") {
    push(
      "removal_shipment_id",
      removalShipmentId,
      "amazon_removal_shipments",
      removalShipmentId,
      "resolved removal shipment",
    );
    push(
      "amazon_removal_shipments",
      removalShipmentId,
      "amazon_removal_shipments",
      removalShipmentId,
      "removal shipment row pointer",
    );
  }

  const trid =
    tridFromMetadata(metaRecord(args.candidate.metadata)) ||
    tridFromMetadata(epMeta);
  if (trid) {
    push("product_link", trid, null, null, "TRID present in source metadata (not invented)");
  }

  for (const ref of metadataReferenceEdges(metaRecord(args.candidate.metadata))) {
    push(ref.kind, ref.value, null, null, "candidate metadata.reference_edges source pointer");
  }

  return edges;
}

export async function loadExpectedPackagesById(
  client: SupabaseClient,
  organizationId: string,
  ids: string[],
): Promise<Map<string, ExpectedPackageRow>> {
  const map = new Map<string, ExpectedPackageRow>();
  if (ids.length === 0) return map;
  const { data, error } = await client
    .from("expected_packages")
    .select("id, tracking_number, order_id, source_detail_row_id, source_shipment_row_id")
    .eq("organization_id", organizationId)
    .in("id", ids);
  if (error) throw new Error(`expected_packages: ${error.message}`);
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    map.set(str(r.id), {
      id: str(r.id),
      tracking_number: str(r.tracking_number) || null,
      order_id: str(r.order_id) || null,
      source_detail_row_id: str(r.source_detail_row_id) || null,
      source_shipment_row_id: str(r.source_shipment_row_id) || null,
      metadata: {},
    });
  }
  return map;
}

export async function loadCandidatesForPilot(
  client: SupabaseClient,
  organizationId: string,
  candidateIds: string[],
): Promise<Map<string, CandidateSourceRow>> {
  const map = new Map<string, CandidateSourceRow>();
  if (candidateIds.length === 0) return map;
  const { data, error } = await client
    .from("claim_candidates")
    .select("id, source_kind, source_table, source_row_id, source_event_key, metadata")
    .eq("organization_id", organizationId)
    .in("id", candidateIds);
  if (error) throw new Error(`claim_candidates: ${error.message}`);
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    map.set(str(r.id), {
      id: str(r.id),
      source_kind: str(r.source_kind) || null,
      source_table: str(r.source_table) || null,
      source_row_id: str(r.source_row_id) || null,
      source_event_key: str(r.source_event_key) || null,
      metadata: metaRecord(r.metadata),
    });
  }
  return map;
}

export async function countPilotCandidateEdges(
  client: SupabaseClient,
  organizationId: string,
  candidateIds: string[],
): Promise<number> {
  if (candidateIds.length === 0) return 0;
  const { count, error } = await client
    .from("claim_reference_edges")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .in("candidate_id", candidateIds);
  if (error) return 0;
  return count ?? 0;
}

export async function verifyPilotMaterializationPostExecute(args: {
  client: SupabaseClient;
  organizationId: string;
  storeId: string;
}): Promise<ReturnType<typeof summarizePost7hReports> & { per_case: ReturnType<typeof verifyCaseReferenceGraphPost7h>[] }> {
  const review = await import("../pilot/claim-case-review-readmodel").then((m) =>
    m.buildClaimCaseReviewReadmodel(args.client, args.organizationId, args.storeId, {
      pilot_case_run_id: PILOT_CASE_RUN_ID,
      intake_run_id: PILOT_INTAKE_RUN_ID,
      status: "open",
      limit: 100,
    }),
  );
  const previewPayload = await composeClaimFilingPacketPreviewV1(
    args.client,
    args.organizationId,
    args.storeId,
    {
      pilot_case_run_id: PILOT_CASE_RUN_ID,
      intake_run_id: PILOT_INTAKE_RUN_ID,
      status: "open",
      limit: 100,
    },
  );
  const rowById = new Map(review.rows.map((r) => [r.id, r]));
  const candidateIds = review.rows.flatMap((r) => r.lines.map((l) => str(l.claim_candidate_id))).filter(Boolean);
  const candidateMap = await loadCandidatesForPilot(args.client, args.organizationId, candidateIds);

  const perCase = previewPayload.previews.map((preview) => {
    const row = rowById.get(preview.claim_case_id)!;
    const line = row?.lines[0];
    const candidate = line?.claim_candidate_id
      ? candidateMap.get(line.claim_candidate_id) ?? null
      : null;
    return verifyCaseReferenceGraphPost7h({
      row,
      preview,
      candidate,
      exportedJsonPreview: null,
      exportedHtml: null,
      exportedPdfExists: false,
    });
  });

  return { ...summarizePost7hReports(perCase), per_case: perCase };
}

export function buildPilotEdgeMaterializationRollbackSql(args: {
  organizationId: string;
  materializationRunId: string;
}): string {
  return `-- PHASE-7H pilot reference edge rollback (scoped delete by run id in source_citations)
DELETE FROM public.claim_reference_edges
WHERE organization_id = '${args.organizationId}'::uuid
  AND candidate_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(source_citations) elem
    WHERE elem->>'materialization_origin' = '${PILOT_EDGE_MATERIALIZATION_ORIGIN}'
      AND elem->>'materialization_run_id' = '${args.materializationRunId}'
  );
`;
}
