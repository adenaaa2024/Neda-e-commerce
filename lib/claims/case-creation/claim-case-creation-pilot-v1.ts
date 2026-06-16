/**
 * PHASE-CLAIM-CASE-CREATION-PILOT-V1
 * Controlled original pilot: claim_candidates → claim_cases + claim_lines + events.
 * Gated by operator approval. No submissions. No PDF. No candidate mutation.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildLineIdempotencyKey,
  evaluateCaseCreationEligibility,
} from "@/lib/claims/contracts/claim-case-creation-contract-v1";
import {
  composeClaimCaseCreationPreviewV1,
  type ClaimCasePreviewV1,
} from "@/lib/claims/case-creation/claim-case-creation-preview-v1";
import { composeClaimEvidencePacketV1 } from "@/lib/claims/evidence/claim-evidence-packet-v1";
import type { ClaimEvidencePacketV1 } from "@/lib/claims/evidence/claim-evidence-packet-v1";
import { ORIGINAL_PILOT_INTAKE_RUN_ID } from "@/lib/claims/evidence/claim-evidence-packet-v1-plan-contract";
import { PRODUCTION_REF } from "@/lib/production-db-bind";
import { refFromSupabaseUrl } from "@/lib/staging-project-ref";

export const CASE_CREATION_PILOT_ORIGIN = "case_creation_pilot_v1" as const;
export const DEFAULT_PILOT_CASE_CAP = 10 as const;
export const DEFAULT_SHIPMENT_CAP = 6 as const;
export const DEFAULT_ORDER_CAP = 4 as const;
export const MAX_PILOT_CASE_CAP = 25 as const;

/** Canonical first-wave pilot candidates from execute `20260615T190000Z`. */
export const CANONICAL_PILOT_V1_CANDIDATE_IDS = [
  "0ba4c6a9-be89-424a-af66-9d786abc2142",
  "112dab30-d118-4451-9b1a-1076cc40fc4d",
  "3e879edb-8697-4b7b-9172-583cd10ae6b6",
  "497e19c0-7409-4886-be0c-38f9e18b2158",
  "49ad0445-2e27-4558-913a-fcca5c614ef8",
  "4c29e99f-07ee-4cd1-86dc-2d2c5937fd7f",
  "5720e68e-7692-4c4a-a646-d8465d7f2f9f",
  "5936e2d2-894e-4a98-97ee-2ce1d8a70597",
  "5ee3fb7a-1b43-463d-9c04-937a07a91828",
  "63320d6e-1b8a-458e-8bc9-6e373281e89e",
] as const;

const APPROVAL_FILE = join(
  process.cwd(),
  ".cursor/operator-approvals/claim-case-creation-pilot-v1-approval.md",
);

export type CaseCreationPilotApprovalStatus = {
  approved: boolean;
  status: "signed" | "unsigned";
  reason: string | null;
  max_cases_cap: number;
  shipment_cap: number;
  order_cap: number;
};

export type CaseCreationPilotSkipReason =
  | "not_structurally_ready"
  | "duplicate_risk"
  | "family_cap_reached"
  | "total_cap_reached"
  | "family_not_approved"
  | "outside_intake_run";

export type CaseCreationPilotCandidateResult = {
  candidate_id: string;
  family_key_v3: string | null;
  outcome: "inserted" | "reused_existing" | "skipped";
  skip_reason?: CaseCreationPilotSkipReason;
  claim_case_id?: string;
  claim_line_id?: string;
  case_idempotency_key?: string;
};

export type CaseCreationPilotExecuteResult = {
  pilot_case_run_id: string;
  intake_run_id: string;
  selected_cap: number;
  selected_candidates: string[];
  selected_family_distribution: Record<string, number>;
  results: CaseCreationPilotCandidateResult[];
  inserted_cases_count: number;
  inserted_lines_count: number;
  inserted_events_count: number;
  reused_existing_count: number;
  skipped_count: number;
  skipped_reason_counts: Record<string, number>;
  sample_created_cases: Array<{
    claim_case_id: string;
    claim_line_id: string;
    candidate_id: string;
    family_key_v3: string | null;
    case_idempotency_key: string;
  }>;
};

export function readCaseCreationPilotApprovalStatus(): CaseCreationPilotApprovalStatus {
  const envOk = process.env.APPROVED_CLAIM_CASE_CREATION_PILOT_V1 === "yes";
  if (!existsSync(APPROVAL_FILE)) {
    return {
      approved: envOk,
      status: envOk ? "signed" : "unsigned",
      reason: envOk ? null : "approval_file_missing",
      max_cases_cap: DEFAULT_PILOT_CASE_CAP,
      shipment_cap: DEFAULT_SHIPMENT_CAP,
      order_cap: DEFAULT_ORDER_CAP,
    };
  }
  const content = readFileSync(APPROVAL_FILE, "utf8");
  const fileOk = /APPROVED_CLAIM_CASE_CREATION_PILOT_V1\s*=\s*yes/i.test(content);
  const decisionOk = /\[x\]\s*APPROVED/i.test(content);
  const capMatch = content.match(/MAX_CASES_CAP\s*=\s*(\d+)/i);
  const shipMatch = content.match(/SHIPMENT_MISSING_CAP\s*=\s*(\d+)/i);
  const orderMatch = content.match(/ORDER_DISCREPANCY_CAP\s*=\s*(\d+)/i);
  const maxCasesCap = capMatch ? Number(capMatch[1]) : DEFAULT_PILOT_CASE_CAP;
  const shipmentCap = shipMatch ? Number(shipMatch[1]) : DEFAULT_SHIPMENT_CAP;
  const orderCap = orderMatch ? Number(orderMatch[1]) : DEFAULT_ORDER_CAP;
  const cap =
    Number.isFinite(maxCasesCap) && maxCasesCap > 0
      ? Math.min(maxCasesCap, MAX_PILOT_CASE_CAP)
      : DEFAULT_PILOT_CASE_CAP;
  if (envOk || (fileOk && decisionOk) || fileOk) {
    return {
      approved: true,
      status: "signed",
      reason: null,
      max_cases_cap: cap,
      shipment_cap: shipmentCap,
      order_cap: orderCap,
    };
  }
  return {
    approved: false,
    status: "unsigned",
    reason: "APPROVED_CLAIM_CASE_CREATION_PILOT_V1 not set to yes",
    max_cases_cap: cap,
    shipment_cap: shipmentCap,
    order_cap: orderCap,
  };
}

export function assertOriginalCaseCreationPilotClient(_client: SupabaseClient): void {
  const url =
    process.env.ORIGINAL_SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    process.env.SUPABASE_URL?.trim() ||
    "";
  if (!url) throw new Error("BLOCKED: original Supabase URL required");
  const ref = refFromSupabaseUrl(url);
  if (ref !== PRODUCTION_REF) {
    throw new Error(`BLOCKED: expected original ref ${PRODUCTION_REF}, got ${ref ?? "missing"}`);
  }
}

function trimPacketSnapshot(packet: ClaimEvidencePacketV1) {
  return {
    packet_id: packet.packet_id,
    candidate_id: packet.candidate_id,
    intake_run_id: packet.intake_run_id,
    family_key_v3: packet.family_key_v3,
    claim_family: packet.claim_family,
    source_event_key: packet.source_event_key,
    quantity: packet.quantity,
    date_gate: packet.date_gate,
    money_lanes: packet.money_lanes,
    evidence_summary: packet.evidence_summary,
    readiness: packet.readiness,
    review_flags: packet.review_flags,
    blocker_flags: packet.blocker_flags,
  };
}

export function selectPilotCaseCandidates(args: {
  previews: ClaimCasePreviewV1[];
  evaluations: Array<{
    candidate_id: string;
    structural_ready: boolean;
    duplicate_risk: boolean;
    family_key_v3: string | null;
  }>;
  shipment_cap: number;
  order_cap: number;
  total_cap: number;
}): { selected: ClaimCasePreviewV1[]; skipped_reason_counts: Record<string, number> } {
  const byId = new Map(args.previews.map((p) => [p.included_candidate_ids[0]!, p]));
  const eligible = args.evaluations
    .filter((e) => e.structural_ready && !e.duplicate_risk)
    .sort((a, b) => a.candidate_id.localeCompare(b.candidate_id));

  const selected: ClaimCasePreviewV1[] = [];
  const skipped_reason_counts: Record<string, number> = {};
  let ship = 0;
  let order = 0;

  for (const ev of eligible) {
    const preview = byId.get(ev.candidate_id);
    if (!preview) {
      skipped_reason_counts.not_structurally_ready =
        (skipped_reason_counts.not_structurally_ready ?? 0) + 1;
      continue;
    }
    const fam = ev.family_key_v3;
    if (selected.length >= args.total_cap) {
      skipped_reason_counts.total_cap_reached =
        (skipped_reason_counts.total_cap_reached ?? 0) + 1;
      continue;
    }
    if (fam === "removal_shipment_missing") {
      if (ship >= args.shipment_cap) {
        skipped_reason_counts.family_cap_reached =
          (skipped_reason_counts.family_cap_reached ?? 0) + 1;
        continue;
      }
      ship += 1;
    } else if (fam === "removal_order_discrepancy") {
      if (order >= args.order_cap) {
        skipped_reason_counts.family_cap_reached =
          (skipped_reason_counts.family_cap_reached ?? 0) + 1;
        continue;
      }
      order += 1;
    } else {
      skipped_reason_counts.family_not_approved =
        (skipped_reason_counts.family_not_approved ?? 0) + 1;
      continue;
    }
    selected.push(preview);
  }

  return { selected, skipped_reason_counts };
}

async function loadPacketMap(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  intakeRunId: string,
  candidateIds: string[],
): Promise<Map<string, ClaimEvidencePacketV1>> {
  const map = new Map<string, ClaimEvidencePacketV1>();
  for (const cid of candidateIds) {
    const p = await composeClaimEvidencePacketV1(client, organizationId, storeId, {
      intake_run_id: intakeRunId,
      candidate_id: cid,
      limit: 1,
    });
    const packet = p.packets[0];
    if (packet) map.set(cid, packet);
  }
  return map;
}

type CandidateRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  intake_run_id: string | null;
  source_kind: string | null;
  source_table: string;
  source_row_id: string;
  claim_family: string | null;
  candidate_status: string | null;
  evidence_status: string | null;
  source_event_key: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  resolved_product_id: string | null;
  expected_quantity: number | null;
  quarantined_at: string | null;
  rejected_at: string | null;
  metadata: Record<string, unknown> | null;
};

async function loadCandidateRow(
  client: SupabaseClient,
  candidateId: string,
): Promise<CandidateRow | null> {
  const { data, error } = await client
    .from("claim_candidates")
    .select(
      "id, organization_id, store_id, intake_run_id, source_kind, source_table, source_row_id, claim_family, candidate_status, evidence_status, source_event_key, sku, fnsku, asin, resolved_product_id, expected_quantity, quarantined_at, rejected_at, metadata",
    )
    .eq("id", candidateId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as CandidateRow | null) ?? null;
}

/** Resolve earliest existing case/line for idempotent pilot re-execute (no maybeSingle on duplicate rows). */
async function resolveExistingPilotCaseAndLine(
  client: SupabaseClient,
  organizationId: string,
  candidateId: string,
  caseKey: string,
  lineKey: string,
): Promise<{ claimCaseId: string | null; claimLineId: string | null }> {
  let claimCaseId: string | null = null;
  let claimLineId: string | null = null;

  const { data: linesByCand, error: lineCandErr } = await client
    .from("claim_lines")
    .select("id, claim_case_id, created_at")
    .eq("organization_id", organizationId)
    .eq("claim_candidate_id", candidateId)
    .not("claim_case_id", "is", null)
    .order("created_at", { ascending: true });
  if (lineCandErr) throw new Error(lineCandErr.message);
  if (linesByCand?.length) {
    claimLineId = String(linesByCand[0]!.id);
    claimCaseId = String(linesByCand[0]!.claim_case_id);
  }

  const { data: linesByKey, error: lineKeyErr } = await client
    .from("claim_lines")
    .select("id, claim_case_id, created_at")
    .eq("organization_id", organizationId)
    .eq("idempotency_key", lineKey)
    .order("created_at", { ascending: true });
  if (lineKeyErr) throw new Error(lineKeyErr.message);
  if (linesByKey?.length) {
    claimLineId = claimLineId ?? String(linesByKey[0]!.id);
    claimCaseId = claimCaseId ?? String(linesByKey[0]!.claim_case_id);
  }

  const { data: casesByKey, error: caseKeyErr } = await client
    .from("claim_cases")
    .select("id, status, created_at")
    .eq("organization_id", organizationId)
    .eq("idempotency_key", caseKey)
    .order("created_at", { ascending: true });
  if (caseKeyErr) throw new Error(caseKeyErr.message);
  if (casesByKey?.length) {
    const open = casesByKey.find((c) => c.status === "open");
    const pick = open ?? casesByKey[0]!;
    claimCaseId = claimCaseId ?? String(pick.id);
  }

  const { data: casesByMeta, error: caseMetaErr } = await client
    .from("claim_cases")
    .select("id, status, created_at")
    .eq("organization_id", organizationId)
    .filter("metadata->>case_creation_origin", "eq", CASE_CREATION_PILOT_ORIGIN)
    .contains("metadata", { candidate_ids: [candidateId] })
    .order("created_at", { ascending: true });
  if (caseMetaErr) throw new Error(caseMetaErr.message);
  if (casesByMeta?.length) {
    const open = casesByMeta.find((c) => c.status === "open");
    const pick = open ?? casesByMeta[0]!;
    claimCaseId = claimCaseId ?? String(pick.id);
  }

  return { claimCaseId, claimLineId };
}

export async function executeClaimCaseCreationPilotV1(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  options: {
    intake_run_id?: string;
    pilot_case_run_id?: string;
    shipment_cap?: number;
    order_cap?: number;
    total_cap?: number;
    dry_run?: boolean;
    pinned_candidate_ids?: string[];
  } = {},
): Promise<CaseCreationPilotExecuteResult> {
  const intakeRunId = options.intake_run_id?.trim() || ORIGINAL_PILOT_INTAKE_RUN_ID;
  const pilotCaseRunId = options.pilot_case_run_id ?? randomUUID();
  const totalCap = options.total_cap ?? DEFAULT_PILOT_CASE_CAP;
  const shipmentCap = options.shipment_cap ?? DEFAULT_SHIPMENT_CAP;
  const orderCap = options.order_cap ?? DEFAULT_ORDER_CAP;
  const attestedAt = new Date().toISOString();

  const pinned = (options.pinned_candidate_ids ?? []).map((id) => id.trim()).filter(Boolean);

  const previewPayload = await composeClaimCaseCreationPreviewV1(client, organizationId, storeId, {
    intake_run_id: intakeRunId,
    limit: 50,
    candidate_ids: pinned.length > 0 ? pinned : undefined,
    operator_reviewed_candidate_ids: pinned,
    force_case_preview_candidate_ids: pinned,
  });

  const structuralEvals = previewPayload.evaluations.map((e) => ({
    candidate_id: e.candidate_id,
    structural_ready: e.structural_ready,
    duplicate_risk: e.duplicate_risk,
    family_key_v3: e.family_key_v3,
  }));

  const { selected: autoSelected, skipped_reason_counts: preSkip } = selectPilotCaseCandidates({
    previews: previewPayload.case_previews,
    evaluations: structuralEvals,
    shipment_cap: shipmentCap,
    order_cap: orderCap,
    total_cap: totalCap,
  });

  let selectedPreviews = autoSelected;
  if (pinned.length > 0) {
    const byId = new Map(
      previewPayload.case_previews.map((p) => [p.included_candidate_ids[0]!, p] as const),
    );
    selectedPreviews = pinned
      .map((id) => byId.get(id))
      .filter((p): p is ClaimCasePreviewV1 => !!p);
    if (selectedPreviews.length !== pinned.length) {
      throw new Error("pinned_candidate_missing_from_preview");
    }
  }

  const selectedIds = selectedPreviews.map((p) => p.included_candidate_ids[0]!).filter(Boolean);
  const packetMap = await loadPacketMap(client, organizationId, storeId, intakeRunId, selectedIds);

  const results: CaseCreationPilotCandidateResult[] = [];
  let insertedCases = 0;
  let insertedLines = 0;
  let insertedEvents = 0;
  let reusedExisting = 0;
  let skipped = 0;
  const skipped_reason_counts: Record<string, number> = { ...preSkip };
  const sample_created_cases: CaseCreationPilotExecuteResult["sample_created_cases"] = [];

  for (const preview of selectedPreviews) {
    const candidateId = preview.included_candidate_ids[0]!;
    const packet = packetMap.get(candidateId);
    const row = await loadCandidateRow(client, candidateId);

    if (!packet || !row || row.intake_run_id !== intakeRunId) {
      skipped += 1;
      skipped_reason_counts.outside_intake_run = (skipped_reason_counts.outside_intake_run ?? 0) + 1;
      results.push({
        candidate_id: candidateId,
        family_key_v3: preview.family_key_v3,
        outcome: "skipped",
        skip_reason: "outside_intake_run",
      });
      continue;
    }

    const eligibility = evaluateCaseCreationEligibility({
      packet,
      candidate_status: row.candidate_status,
      evidence_status: row.evidence_status,
      quarantined_at: row.quarantined_at,
      rejected_at: row.rejected_at,
      source_kind: packet.source_kind,
      operator_reviewed_packet: true,
    });

    const caseKey = preview.case_idempotency_key;
    const lineKey = buildLineIdempotencyKey(candidateId);

    const { claimCaseId: preExistingCaseId, claimLineId: preExistingLineId } =
      await resolveExistingPilotCaseAndLine(client, organizationId, candidateId, caseKey, lineKey);

    if (
      !eligibility.structural_ready ||
      (preview.duplicate_risk.has_risk && !preExistingCaseId)
    ) {
      skipped += 1;
      const reason = preview.duplicate_risk.has_risk ? "duplicate_risk" : "not_structurally_ready";
      skipped_reason_counts[reason] = (skipped_reason_counts[reason] ?? 0) + 1;
      results.push({
        candidate_id: candidateId,
        family_key_v3: preview.family_key_v3,
        outcome: "skipped",
        skip_reason: reason as CaseCreationPilotSkipReason,
        case_idempotency_key: caseKey,
      });
      continue;
    }

    if (options.dry_run) {
      results.push({
        candidate_id: candidateId,
        family_key_v3: preview.family_key_v3,
        outcome: preExistingCaseId ? "reused_existing" : "inserted",
        claim_case_id: preExistingCaseId ?? undefined,
        claim_line_id: preExistingLineId ?? undefined,
        case_idempotency_key: caseKey,
      });
      if (preExistingCaseId) reusedExisting += 1;
      else insertedCases += 1;
      continue;
    }

    let claimCaseId = preExistingCaseId;
    let claimLineId = preExistingLineId;
    let createdCase = false;

    if (!claimCaseId) {
      const { data: insertedCase, error: caseErr } = await client
        .from("claim_cases")
        .insert({
          organization_id: organizationId,
          store_id: storeId,
          claim_source: "delayed_not_received",
          claim_subtype: preview.family_key_v3,
          status: "open",
          priority: "normal",
          primary_resolved_product_id: preview.product_identifiers.product_id,
          primary_sku: preview.product_identifiers.sku,
          idempotency_key: caseKey,
          metadata: {
            candidate_ids: [candidateId],
            intake_run_id: intakeRunId,
            family_key_v3: preview.family_key_v3,
            claim_family: preview.claim_family,
            source_event_key: preview.source_event_key,
            evidence_packet_snapshot: trimPacketSnapshot(packet),
            grouping_mode: preview.grouping_mode,
            money_lanes: packet.money_lanes,
            pilot_wave: "original_case_creation_pilot_v1",
            case_creation_origin: CASE_CREATION_PILOT_ORIGIN,
            pilot_case_run_id: pilotCaseRunId,
            operator_review_attested: true,
            operator_review_attested_by: "maysam",
            operator_review_attested_at: attestedAt,
          },
        })
        .select("id")
        .single();

      if (caseErr) {
        if (caseErr.code === "23505") {
          const { data: raced } = await client
            .from("claim_cases")
            .select("id")
            .eq("idempotency_key", caseKey)
            .maybeSingle();
          claimCaseId = raced?.id ?? null;
          if (claimCaseId) reusedExisting += 1;
        } else {
          throw new Error(`claim_case_insert_failed:${caseErr.message}`);
        }
      } else if (insertedCase?.id) {
        claimCaseId = insertedCase.id;
        createdCase = true;
        insertedCases += 1;

        const { error: evErr } = await client.from("claim_case_events").insert({
          organization_id: organizationId,
          claim_case_id: claimCaseId,
          event_type: "case_opened",
          to_status: "open",
          payload: {
            candidate_ids: [candidateId],
            pilot_case_run_id: pilotCaseRunId,
            case_creation_origin: CASE_CREATION_PILOT_ORIGIN,
            packet_id: packet.packet_id,
            family_key_v3: preview.family_key_v3,
          },
        });
        if (evErr) throw new Error(`claim_case_event_insert_failed:${evErr.message}`);
        insertedEvents += 1;
      }
    } else {
      reusedExisting += 1;
    }

    if (!claimCaseId) {
      skipped += 1;
      skipped_reason_counts.not_structurally_ready =
        (skipped_reason_counts.not_structurally_ready ?? 0) + 1;
      results.push({
        candidate_id: candidateId,
        family_key_v3: preview.family_key_v3,
        outcome: "skipped",
        skip_reason: "not_structurally_ready",
        case_idempotency_key: caseKey,
      });
      continue;
    }

    const { data: existingLineRows, error: existingLineErr } = await client
      .from("claim_lines")
      .select("id, claim_case_id")
      .eq("organization_id", organizationId)
      .eq("idempotency_key", lineKey)
      .order("created_at", { ascending: true })
      .limit(1);
    if (existingLineErr) throw new Error(existingLineErr.message);
    const existingLine = existingLineRows?.[0] ?? null;

    claimLineId = claimLineId ?? existingLine?.id ?? null;
    if (!claimLineId) {
      const expectedPackageId =
        row.source_table === "expected_packages" ? row.source_row_id : null;
      const { data: insertedLine, error: lineErr } = await client
        .from("claim_lines")
        .insert({
          organization_id: organizationId,
          store_id: storeId,
          claim_case_id: claimCaseId,
          claim_candidate_id: candidateId,
          source_table: row.source_table,
          source_row_id: row.source_row_id,
          expected_package_id: expectedPackageId,
          resolved_product_id: row.resolved_product_id,
          sku: row.sku,
          fnsku: row.fnsku,
          asin: row.asin,
          line_grain: "import_source",
          discrepancy_kind: "removal_financial",
          quantity_basis: "units",
          quantity_expected: preview.clean_quantity,
          status: "claim_ready",
          idempotency_key: lineKey,
          metadata: {
            family_key_v3: preview.family_key_v3,
            evidence_summary: packet.evidence_summary,
            case_creation_origin: CASE_CREATION_PILOT_ORIGIN,
            pilot_case_run_id: pilotCaseRunId,
          },
        })
        .select("id")
        .single();

      if (lineErr) {
        if (lineErr.code === "23505") {
          const { data: racedLine } = await client
            .from("claim_lines")
            .select("id")
            .eq("idempotency_key", lineKey)
            .maybeSingle();
          claimLineId = racedLine?.id ?? null;
        } else {
          throw new Error(`claim_line_insert_failed:${lineErr.message}`);
        }
      } else if (insertedLine?.id) {
        claimLineId = insertedLine.id;
        insertedLines += 1;
        if (createdCase) {
          await client
            .from("claim_cases")
            .update({ primary_claim_line_id: claimLineId })
            .eq("id", claimCaseId);
        }
      }
    } else if (existingLine && !existingLine.claim_case_id && claimLineId) {
      await client.from("claim_lines").update({ claim_case_id: claimCaseId }).eq("id", claimLineId);
    }

    results.push({
      candidate_id: candidateId,
      family_key_v3: preview.family_key_v3,
      outcome: createdCase ? "inserted" : "reused_existing",
      claim_case_id: claimCaseId,
      claim_line_id: claimLineId ?? undefined,
      case_idempotency_key: caseKey,
    });

    if (sample_created_cases.length < 3 && claimCaseId && claimLineId) {
      sample_created_cases.push({
        claim_case_id: claimCaseId,
        claim_line_id: claimLineId,
        candidate_id: candidateId,
        family_key_v3: preview.family_key_v3,
        case_idempotency_key: caseKey,
      });
    }
  }

  const familyDist: Record<string, number> = {};
  for (const p of selectedPreviews) {
    const fam = p.family_key_v3 ?? "unknown";
    familyDist[fam] = (familyDist[fam] ?? 0) + 1;
  }

  return {
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
    selected_cap: totalCap,
    selected_candidates: selectedIds,
    selected_family_distribution: familyDist,
    results,
    inserted_cases_count: insertedCases,
    inserted_lines_count: insertedLines,
    inserted_events_count: insertedEvents,
    reused_existing_count: reusedExisting,
    skipped_count: skipped,
    skipped_reason_counts,
    sample_created_cases,
  };
}

export function buildCaseCreationPilotRollbackSql(args: {
  organizationId: string;
  pilotCaseRunId: string;
}): string {
  const org = args.organizationId;
  const runId = args.pilotCaseRunId;
  return `-- PHASE-CLAIM-CASE-CREATION-PILOT-V1 rollback (soft-close only; no hard delete)
-- Scope: metadata.case_creation_origin = '${CASE_CREATION_PILOT_ORIGIN}' AND pilot_case_run_id = '${runId}'

BEGIN;

UPDATE public.claim_lines cl
SET
  status = 'closed',
  status_reason = 'pilot_rollback_v1',
  metadata = COALESCE(cl.metadata, '{}'::jsonb) || jsonb_build_object(
    'pilot_rollback_at', now()::text,
    'pilot_rollback_run_id', '${runId}',
    'detached_via_rollback', true
  ),
  updated_at = now()
FROM public.claim_cases cc
WHERE cl.claim_case_id = cc.id
  AND cc.organization_id = '${org}'::uuid
  AND cc.metadata->>'case_creation_origin' = '${CASE_CREATION_PILOT_ORIGIN}'
  AND cc.metadata->>'pilot_case_run_id' = '${runId}';

UPDATE public.claim_cases
SET
  status = 'closed',
  status_reason = 'pilot_rollback_v1',
  closed_at = now(),
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'superseded_at', now()::text,
    'pilot_rollback_run_id', '${runId}'
  ),
  updated_at = now()
WHERE organization_id = '${org}'::uuid
  AND metadata->>'case_creation_origin' = '${CASE_CREATION_PILOT_ORIGIN}'
  AND metadata->>'pilot_case_run_id' = '${runId}';

INSERT INTO public.claim_case_events (
  organization_id,
  claim_case_id,
  event_type,
  from_status,
  to_status,
  payload
)
SELECT
  organization_id,
  id,
  'case_closed',
  status,
  'closed',
  jsonb_build_object(
    'rollback', 'pilot_rollback_v1',
    'pilot_case_run_id', '${runId}'
  )
FROM public.claim_cases
WHERE organization_id = '${org}'::uuid
  AND metadata->>'case_creation_origin' = '${CASE_CREATION_PILOT_ORIGIN}'
  AND metadata->>'pilot_case_run_id' = '${runId}'
  AND status = 'closed'
  AND status_reason = 'pilot_rollback_v1';

COMMIT;
`;
}

export function verifyMoneyNullPreservation(
  cases: Array<{ metadata: Record<string, unknown> | null }>,
): { pass: boolean; coerced_non_null: number } {
  let coerced = 0;
  for (const c of cases) {
    const lanes = c.metadata?.money_lanes as Record<string, unknown> | undefined;
    if (!lanes) continue;
    for (const key of [
      "estimated_amazon_payout",
      "observed_reimbursement",
      "internal_cost_loss",
      "recovery_value",
    ]) {
      if (lanes[key] === 0) coerced += 1;
    }
  }
  return { pass: coerced === 0, coerced_non_null: coerced };
}
