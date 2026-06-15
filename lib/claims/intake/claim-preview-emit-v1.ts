/**
 * PHASE-CLAIM-CANDIDATE-EMIT-STAGING-PILOT-V1
 * Preview → claim_candidates emitter (staging pilot only).
 * Gated by emit approval contract + operator approval file.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildFirstSafeFamiliesPreviewGenerators,
  type PreviewGeneratorItem,
} from "@/lib/claims/center/claim-first-safe-families-preview-generators-v1";
import { collectDrafts } from "@/lib/claims/center/claim-readmodel-staging-dryrun-v1";
import {
  APPROVED_EMIT_V3_FAMILIES,
  EMIT_CONTRACT_VERSION,
  type ApprovedEmitV3Family,
} from "@/lib/claims/contracts/claim-candidate-emit-approval-contract-v1";
import { applyDrafts, countLegacyOverlap } from "@/lib/claims/intake/claim-generator-registry";
import { CLAIM_INTAKE_GENERATORS } from "@/lib/claims/intake/claim-intake-generators";
import {
  loadClaimIntakeSettings,
  resolveClaimIntakeWindow,
} from "@/lib/claims/intake/claim-intake-settings";
import { loadEffectiveClaimIntakePolicy } from "@/lib/claims/intake/claim-intake-policy-contract";
import {
  evaluateClaimPreviewEmitDateGate,
  emitDateGateMetadata,
  type EmitDateGateSkipReason,
} from "@/lib/claims/intake/claim-preview-emit-date-gate-v1";
import type { ClaimCandidateDraft } from "@/lib/claims/intake/claim-intake-types";
import { PRODUCTION_REF } from "@/lib/production-db-bind";
import { assertStagingSupabaseUrl, refFromSupabaseUrl } from "@/lib/staging-project-ref";

export const STAGING_PILOT_REF = "eiqfaapyumhixxoeltgu" as const;
export const ORIGINAL_PILOT_REF = PRODUCTION_REF;
export const EMIT_ORIGIN_TAG = "preview_emit_v1" as const;
export const DEFAULT_PILOT_MAX_ROWS = 50 as const;
export const DEFAULT_ORIGINAL_CONSERVATIVE_CAP = 25 as const;
export const DEFAULT_ORIGINAL_SHIPMENT_SHARE = 30 as const;
export const DEFAULT_ORIGINAL_ORDER_SHARE = 20 as const;

const APPROVAL_FILE = join(
  process.cwd(),
  ".cursor/operator-approvals/claim-candidate-emit-staging-pilot-v1-approval.md",
);

const WAVE2_APPROVAL_FILE = join(
  process.cwd(),
  ".cursor/operator-approvals/claim-candidate-emit-staging-wave2-v1-approval.md",
);

const ORIGINAL_APPROVAL_FILE = join(
  process.cwd(),
  ".cursor/operator-approvals/claim-candidate-emit-original-pilot-v1-approval.md",
);

const CHUNK = 100;

export type PreviewEmitSkipReason =
  | "preview_only_family"
  | "not_claim_ready"
  | "blocker_flags"
  | "disputed_row"
  | "missing_product_link"
  | "missing_store_id"
  | "missing_source_edges"
  | "missing_evidence_summary"
  | "draft_not_found"
  | "quarantined_existing"
  | "rejected_existing"
  | "legacy_seed_dedupe"
  | "identity_conflict"
  | "pilot_cap_reached"
  | EmitDateGateSkipReason;

export type EffectiveDateGateResult = {
  pass: boolean;
  policy_scan_go_live_date: string | null;
  policy_claim_start_date: string | null;
  skipped_by_date_count: number;
  emitted_with_date_gate_passed: number;
  all_emitted_rows_date_gate_passed: boolean;
};

export type ClaimPreviewEmitPilotResult = {
  contract_version: typeof EMIT_CONTRACT_VERSION;
  staging_only: boolean;
  intake_run_id: string;
  before_count: number;
  after_count: number;
  inserted_count: number;
  updated_count: number;
  skipped_count: number;
  skipped_by_date_count: number;
  effective_date_gate_result: EffectiveDateGateResult;
  legacy_corroborated_count: number;
  emitted_family_counts: Record<string, number>;
  skipped_reason_counts: Partial<Record<PreviewEmitSkipReason, number>>;
  sample_emitted_rows: Array<Record<string, unknown>>;
  duplicate_prevention_result: { pass: boolean; all_have_dedupe_key: boolean };
  disputed_exclusion_result: { pass: boolean; disputed_emitted: number };
  source_edge_validation: { pass: boolean; missing_edges: number };
  evidence_summary_validation: { pass: boolean; missing_summary: number };
  money_field_validation: { pass: boolean; zero_coerced: number };
  no_claim_case_mutation_verification: { pass: boolean; before: number; after: number };
  RLS_scope_verification: { pass: boolean; org_scoped: boolean; store_scoped: boolean };
  rollback_sql: string;
  approval_file_status: "signed" | "unsigned";
  SAFE_STAGING_CLAIM_CANDIDATE_EMIT_PILOT: "yes" | "no";
  SAFE_TO_PLAN_ORIGINAL_EMIT_PILOT: "no";
};

export type ClaimPreviewEmitWave2Result = ClaimPreviewEmitPilotResult & {
  wave: "staging_wave2_v1";
  removal_shipment_missing_count: number;
  removal_order_discrepancy_count: number;
  SAFE_STAGING_EMIT_WAVE2: "yes" | "no";
};

export type ClaimPreviewEmitOriginalPilotResult = Omit<
  ClaimPreviewEmitPilotResult,
  "staging_only" | "SAFE_STAGING_CLAIM_CANDIDATE_EMIT_PILOT" | "SAFE_TO_PLAN_ORIGINAL_EMIT_PILOT"
> & {
  original_only: true;
  original_ref: typeof ORIGINAL_PILOT_REF;
  original_ref_guard: { pass: boolean; ref: string };
  selected_cap: number;
  eligible_preview_counts: Record<string, number>;
  removal_shipment_missing_count: number;
  removal_order_discrepancy_count: number;
  needs_review_exclusion_result: { pass: boolean; needs_review_emitted: number };
  preview_only_family_exclusion_result: { pass: boolean; preview_only_emitted: number };
  dedupe_result: { pass: boolean; all_have_dedupe_key: boolean };
  source_edge_result: { pass: boolean; missing_edges: number };
  evidence_summary_result: { pass: boolean; missing_summary: number };
  money_field_result: { pass: boolean; zero_coerced: number };
  SAFE_ORIGINAL_EMIT_PILOT: "yes" | "no";
  SAFE_TO_REVIEW_ORIGINAL_CANDIDATES_UI: "yes" | "no";
};

function str(v: string | null | undefined): string {
  return String(v ?? "").trim();
}

export function readPilotApprovalStatus(): {
  approved: boolean;
  status: "signed" | "unsigned";
  reason: string | null;
} {
  if (!existsSync(APPROVAL_FILE)) {
    return { approved: false, status: "unsigned", reason: "approval_file_missing" };
  }
  const content = readFileSync(APPROVAL_FILE, "utf8");
  const envOk = process.env.APPROVED_CLAIM_CANDIDATE_EMIT_STAGING_PILOT_V1 === "yes";
  const fileOk = /APPROVED_CLAIM_CANDIDATE_EMIT_STAGING_PILOT_V1\s*=\s*yes/i.test(content);
  const decisionOk = /\[x\]\s*APPROVED/i.test(content) || /Decision:\s*\*\*APPROVED\*\*/i.test(content);
  if (envOk || (fileOk && decisionOk) || fileOk) {
    return { approved: true, status: "signed", reason: null };
  }
  return {
    approved: false,
    status: "unsigned",
    reason: "APPROVED_CLAIM_CANDIDATE_EMIT_STAGING_PILOT_V1 not set to yes",
  };
}

export function readWave2ApprovalStatus(): {
  approved: boolean;
  status: "signed" | "unsigned";
  reason: string | null;
} {
  if (!existsSync(WAVE2_APPROVAL_FILE)) {
    return { approved: false, status: "unsigned", reason: "wave2_approval_file_missing" };
  }
  const content = readFileSync(WAVE2_APPROVAL_FILE, "utf8");
  const envOk = process.env.APPROVED_CLAIM_CANDIDATE_EMIT_STAGING_WAVE2_V1 === "yes";
  const fileOk = /APPROVED_CLAIM_CANDIDATE_EMIT_STAGING_WAVE2_V1\s*=\s*yes/i.test(content);
  const decisionOk = /\[x\]\s*APPROVED/i.test(content) || /Decision:\s*\*\*APPROVED\*\*/i.test(content);
  if (envOk || (fileOk && decisionOk) || fileOk) {
    return { approved: true, status: "signed", reason: null };
  }
  return {
    approved: false,
    status: "unsigned",
    reason: "APPROVED_CLAIM_CANDIDATE_EMIT_STAGING_WAVE2_V1 not set to yes",
  };
}

export function readOriginalPilotApprovalStatus(): {
  approved: boolean;
  status: "signed" | "unsigned";
  reason: string | null;
  max_rows_cap: number;
} {
  const defaultCap = DEFAULT_PILOT_MAX_ROWS;
  if (!existsSync(ORIGINAL_APPROVAL_FILE)) {
    const envOk = process.env.APPROVED_CLAIM_CANDIDATE_EMIT_ORIGINAL_PILOT_V1 === "yes";
    return {
      approved: envOk,
      status: envOk ? "signed" : "unsigned",
      reason: envOk ? null : "original_approval_file_missing",
      max_rows_cap: defaultCap,
    };
  }
  const content = readFileSync(ORIGINAL_APPROVAL_FILE, "utf8");
  const envOk = process.env.APPROVED_CLAIM_CANDIDATE_EMIT_ORIGINAL_PILOT_V1 === "yes";
  const fileOk = /APPROVED_CLAIM_CANDIDATE_EMIT_ORIGINAL_PILOT_V1\s*=\s*yes/i.test(content);
  const decisionOk = /\[x\]\s*APPROVED/i.test(content) || /Decision:\s*\*\*APPROVED\*\*/i.test(content);
  const capMatch = content.match(/MAX_ROWS_CAP\s*=\s*(\d+)/i);
  const capFromFile = capMatch ? Number(capMatch[1]) : defaultCap;
  const maxRowsCap = Number.isFinite(capFromFile) && capFromFile > 0 ? capFromFile : defaultCap;
  if (envOk || (fileOk && decisionOk) || fileOk) {
    return { approved: true, status: "signed", reason: null, max_rows_cap: maxRowsCap };
  }
  return {
    approved: false,
    status: "unsigned",
    reason: "APPROVED_CLAIM_CANDIDATE_EMIT_ORIGINAL_PILOT_V1 not set to yes",
    max_rows_cap: maxRowsCap,
  };
}

export function assertOriginalPilotClient(_client: SupabaseClient): void {
  const url =
    process.env.ORIGINAL_SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    process.env.SUPABASE_URL?.trim() ||
    "";
  if (!url) throw new Error("BLOCKED: original Supabase URL required");
  const ref = refFromSupabaseUrl(url);
  if (ref === STAGING_PILOT_REF) {
    throw new Error(`BLOCKED: staging ref ${STAGING_PILOT_REF} must not be used for original emit`);
  }
  if (ref !== ORIGINAL_PILOT_REF) {
    throw new Error(`BLOCKED: expected original ref ${ORIGINAL_PILOT_REF}, got ${ref ?? "missing"}`);
  }
}

export function assertStagingPilotClient(client: SupabaseClient): void {
  const url =
    process.env.STAGING_SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    "";
  if (url) {
    assertStagingSupabaseUrl(url, "STAGING_SUPABASE_URL");
    if (refFromSupabaseUrl(url) !== STAGING_PILOT_REF) {
      throw new Error(`BLOCKED: expected staging ref ${STAGING_PILOT_REF}`);
    }
  }
}

function previewEmitSkipReason(preview: PreviewGeneratorItem): PreviewEmitSkipReason | null {
  if (!(APPROVED_EMIT_V3_FAMILIES as readonly string[]).includes(preview.family_key)) {
    return "preview_only_family";
  }
  if (preview.recommended_action !== "claim_ready") return "not_claim_ready";
  if (preview.pre_cutoff || preview.missing_event_date || !preview.date_gate_passed) {
    return "not_claim_ready";
  }
  if (preview.blocker_flags.length > 0) return "blocker_flags";
  if (preview.review_flags.includes("disputed_source_row")) return "disputed_row";
  if (!preview.product_id) return "missing_product_link";
  if (!str(preview.store_id)) return "missing_store_id";
  if (!preview.source_edges.length) return "missing_source_edges";
  if (!str(preview.evidence_summary)) return "missing_evidence_summary";
  return null;
}

function resolveEmitClaimFamily(
  preview: PreviewGeneratorItem,
  draft: ClaimCandidateDraft,
): string {
  if (preview.family_key === "removal_order_discrepancy") return "shipment_quantity_mismatch";
  if (preview.family_key === "removal_shipment_missing") return "shipment_not_received";
  return draft.claim_family;
}

function decorateDraftForEmit(
  draft: ClaimCandidateDraft,
  preview: PreviewGeneratorItem,
  dateGate: ReturnType<typeof evaluateClaimPreviewEmitDateGate>,
  generatorPhase = "preview_emit_staging_pilot_v1",
): ClaimCandidateDraft {
  return {
    ...draft,
    claim_family: resolveEmitClaimFamily(preview, draft),
    organization_id: preview.organization_id,
    store_id: preview.store_id,
    event_date: dateGate.source_event_date ?? draft.event_date,
    product: {
      sku: preview.sku,
      fnsku: preview.fnsku,
      asin: preview.asin,
      resolved_product_id: preview.product_id,
    },
    expected_quantity: preview.quantity_claimed ?? draft.expected_quantity,
    evidence_summary: str(preview.evidence_summary) || draft.evidence_summary,
    evidence_pointers: preview.source_edges.map((e) => ({ table: e.table, id: e.id })),
    reference_edges: [...preview.TRID_edges],
    expected_amount:
      preview.estimated_amazon_payout != null ? preview.estimated_amazon_payout : draft.expected_amount,
    recovery_value:
      preview.estimated_amazon_payout ?? draft.recovery_value ?? draft.expected_amount,
    cogs_unit: preview.internal_cost_loss != null ? preview.internal_cost_loss : draft.cogs_unit,
    metadata: {
      ...draft.metadata,
      emit_contract_version: EMIT_CONTRACT_VERSION,
      preview_id: preview.preview_id,
      emit_origin: EMIT_ORIGIN_TAG,
      generator_phase: generatorPhase,
      family_key_v3: preview.family_key,
      money_lanes: {
        estimated_amazon_payout: preview.estimated_amazon_payout,
        observed_reimbursement: preview.observed_reimbursement,
        internal_cost_loss: preview.internal_cost_loss,
        reimbursement_gap: preview.reimbursement_gap,
      },
      reference_key: draft.reference_key,
      evidence_pointers: preview.source_edges.map((e) => ({ table: e.table, id: e.id })),
      reference_edges: preview.TRID_edges,
      evidence_summary: preview.evidence_summary,
      ...emitDateGateMetadata(dateGate),
    },
  };
}

function rollbackSql(intakeRunId: string, label = "PHASE-CLAIM-CANDIDATE-EMIT-STAGING-PILOT-V1"): string {
  return `-- ${label} rollback (quarantine — no hard delete)
UPDATE claim_candidates
SET
  quarantined_at = NOW(),
  quarantine_reason = 'emit_pilot_rollback_v1',
  candidate_status = 'superseded',
  superseded_by_candidate_id = id,
  metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
    'rollback_run_id', '${intakeRunId}',
    'rollback_at', NOW()::text,
    'rollback_mode', 'quarantine_supersede'
  ),
  updated_at = NOW()
WHERE intake_run_id = '${intakeRunId}'
  AND metadata->>'emit_origin' = '${EMIT_ORIGIN_TAG}';

-- Release dedupe keys on superseded pilot rows so a fresh pilot emit can re-insert.
UPDATE claim_candidates
SET dedupe_key = NULL,
    updated_at = NOW()
WHERE intake_run_id = '${intakeRunId}'
  AND metadata->>'emit_origin' = '${EMIT_ORIGIN_TAG}'
  AND quarantined_at IS NOT NULL;

-- Reverse legacy corroboration stamps from same pilot window (optional):
-- UPDATE claim_candidates SET metadata = metadata - 'corroborated_by_dedupe_key' - 'corroborated_at'
-- WHERE source_kind = 'legacy_seed' AND metadata->>'corroborated_at' >= '<pilot_started_at>';
`;
}

async function countTable(
  client: SupabaseClient,
  table: "claim_candidates" | "claim_cases",
  organizationId: string,
): Promise<number> {
  const { count, error } = await client
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);
  if (error) throw new Error(`${table} count failed: ${error.message}`);
  return count ?? 0;
}

async function loadDedupeBlockers(
  client: SupabaseClient,
  organizationId: string,
  dedupeKeys: string[],
): Promise<Map<string, PreviewEmitSkipReason>> {
  const blockers = new Map<string, PreviewEmitSkipReason>();
  for (let i = 0; i < dedupeKeys.length; i += CHUNK) {
    const chunk = dedupeKeys.slice(i, i + CHUNK);
    const { data, error } = await client
      .from("claim_candidates")
      .select("dedupe_key, source_kind, quarantined_at, rejected_at")
      .eq("organization_id", organizationId)
      .in("dedupe_key", chunk);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{
      dedupe_key: string;
      source_kind: string | null;
      quarantined_at: string | null;
      rejected_at: string | null;
    }>) {
      if (row.source_kind === "legacy_seed") blockers.set(row.dedupe_key, "legacy_seed_dedupe");
      else if (row.quarantined_at) {
        /* superseded pilot rows must not block fresh trusted re-emit */
      } else if (row.rejected_at) blockers.set(row.dedupe_key, "rejected_existing");
    }
  }
  return blockers;
}

/** DB unique (org, source_table, source_row_id) — broader than dedupe_key identity check in applyDrafts. */
async function loadSourceRowIdentitySkips(
  client: SupabaseClient,
  organizationId: string,
  drafts: ClaimCandidateDraft[],
): Promise<Set<string>> {
  const skipDedupe = new Set<string>();
  const byTable = new Map<string, string[]>();
  for (const d of drafts) {
    const list = byTable.get(d.source_table) ?? [];
    list.push(d.source_row_id);
    byTable.set(d.source_table, list);
  }
  const existingByPhysical = new Map<string, { dedupe_key: string | null; source_kind: string | null }>();
  for (const [table, ids] of byTable) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = [...new Set(ids.slice(i, i + CHUNK))];
      const { data, error } = await client
        .from("claim_candidates")
        .select("source_row_id, dedupe_key, source_kind, claim_family")
        .eq("organization_id", organizationId)
        .eq("source_table", table)
        .is("quarantined_at", null)
        .is("rejected_at", null)
        .in("source_row_id", chunk);
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as Array<{
        source_row_id: string;
        dedupe_key: string | null;
        source_kind: string | null;
        claim_family: string | null;
      }>) {
        existingByPhysical.set(`${table}:${row.source_row_id}:${row.claim_family ?? ""}`, {
          dedupe_key: row.dedupe_key,
          source_kind: row.source_kind,
        });
      }
    }
  }
  for (const d of drafts) {
    const hit = existingByPhysical.get(`${d.source_table}:${d.source_row_id}:${d.claim_family}`);
    if (!hit) continue;
    if (hit.dedupe_key === d.dedupe_key) continue;
    skipDedupe.add(d.dedupe_key);
  }
  return skipDedupe;
}

function bumpSkip(
  counts: Partial<Record<PreviewEmitSkipReason, number>>,
  reason: PreviewEmitSkipReason,
): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

async function loadActiveTrustedDedupeKeys(
  client: SupabaseClient,
  organizationId: string,
): Promise<Set<string>> {
  const keys = new Set<string>();
  const { data, error } = await client
    .from("claim_candidates")
    .select("dedupe_key")
    .eq("organization_id", organizationId)
    .not("dedupe_key", "is", null)
    .is("quarantined_at", null)
    .is("rejected_at", null)
    .neq("source_kind", "legacy_seed");
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as Array<{ dedupe_key: string | null }>) {
    if (row.dedupe_key) keys.add(row.dedupe_key);
  }
  return keys;
}

/** Wave 2: shipment_missing first (not already emitted), then order_discrepancy without active dedupe. */
export function sortPreviewsForWave2Emit(
  previews: PreviewGeneratorItem[],
  activeDedupeKeys: Set<string>,
): PreviewGeneratorItem[] {
  const byQty = (a: PreviewGeneratorItem, b: PreviewGeneratorItem) =>
    (b.quantity_claimed ?? 0) - (a.quantity_claimed ?? 0);

  const shipmentMissing = previews
    .filter(
      (p) =>
        p.family_key === "removal_shipment_missing" && !activeDedupeKeys.has(p.duplicate_key),
    )
    .sort(byQty);

  const orderDiscrepancy = previews
    .filter(
      (p) =>
        p.family_key === "removal_order_discrepancy" && !activeDedupeKeys.has(p.duplicate_key),
    )
    .sort(byQty);

  return [...shipmentMissing, ...orderDiscrepancy];
}

export function resolveOriginalFamilyCaps(maxRows: number): { shipment: number; order: number } {
  const shipment = Math.min(DEFAULT_ORIGINAL_SHIPMENT_SHARE, Math.ceil(maxRows * 0.6));
  const order = Math.min(DEFAULT_ORIGINAL_ORDER_SHARE, Math.max(0, maxRows - shipment));
  return { shipment, order };
}

function physicalSlotKey(preview: PreviewGeneratorItem): string | null {
  const edge = preview.source_edges[0];
  if (!edge?.table || !edge?.id) return null;
  return `${edge.table}:${edge.id}`;
}

async function loadOccupiedPhysicalSlots(
  client: SupabaseClient,
  organizationId: string,
  slotKeys: string[],
): Promise<Set<string>> {
  const occupied = new Set<string>();
  const byTable = new Map<string, string[]>();
  for (const key of slotKeys) {
    const sep = key.indexOf(":");
    if (sep <= 0) continue;
    const table = key.slice(0, sep);
    const rowId = key.slice(sep + 1);
    const list = byTable.get(table) ?? [];
    list.push(rowId);
    byTable.set(table, list);
  }
  for (const [table, ids] of byTable) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = [...new Set(ids.slice(i, i + CHUNK))];
      const { data, error } = await client
        .from("claim_candidates")
        .select("source_table, source_row_id")
        .eq("organization_id", organizationId)
        .eq("source_table", table)
        .in("source_row_id", chunk);
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as Array<{ source_table: string; source_row_id: string }>) {
        occupied.add(`${row.source_table}:${row.source_row_id}`);
      }
    }
  }
  return occupied;
}

/** Original pilot: open physical slots only; shipment dedupes excluded from order batch. */
export async function selectPreviewsForOriginalPilotEmitAsync(
  client: SupabaseClient,
  organizationId: string,
  previews: PreviewGeneratorItem[],
  activeDedupeKeys: Set<string>,
  maxRows: number,
): Promise<PreviewGeneratorItem[]> {
  const caps = resolveOriginalFamilyCaps(maxRows);
  const byQty = (a: PreviewGeneratorItem, b: PreviewGeneratorItem) =>
    (b.quantity_claimed ?? 0) - (a.quantity_claimed ?? 0);

  const shipPool = previews
    .filter(
      (p) =>
        p.family_key === "removal_shipment_missing" && !activeDedupeKeys.has(p.duplicate_key),
    )
    .sort(byQty);
  const orderPool = previews
    .filter(
      (p) =>
        p.family_key === "removal_order_discrepancy" && !activeDedupeKeys.has(p.duplicate_key),
    )
    .sort(byQty);

  const slotKeys = [...shipPool, ...orderPool]
    .map((p) => physicalSlotKey(p))
    .filter((k): k is string => !!k);
  const occupied = await loadOccupiedPhysicalSlots(client, organizationId, slotKeys);

  const shipment = shipPool
    .filter((p) => {
      const slot = physicalSlotKey(p);
      return slot && !occupied.has(slot);
    })
    .slice(0, caps.shipment);

  const shipmentDedupes = new Set(shipment.map((p) => p.duplicate_key));
  const shipmentSlots = new Set(
    shipment.map((p) => physicalSlotKey(p)).filter((k): k is string => !!k),
  );

  const order = orderPool
    .filter((p) => {
      const slot = physicalSlotKey(p);
      return (
        slot &&
        !occupied.has(slot) &&
        !shipmentDedupes.has(p.duplicate_key) &&
        !shipmentSlots.has(slot)
      );
    })
    .slice(0, caps.order);

  return [...shipment, ...order].slice(0, maxRows);
}

/** Original pilot: shipment_missing up to family cap, then order_discrepancy. */
export function selectPreviewsForOriginalPilotEmit(
  previews: PreviewGeneratorItem[],
  activeDedupeKeys: Set<string>,
  maxRows: number,
): PreviewGeneratorItem[] {
  const caps = resolveOriginalFamilyCaps(maxRows);
  const byQty = (a: PreviewGeneratorItem, b: PreviewGeneratorItem) =>
    (b.quantity_claimed ?? 0) - (a.quantity_claimed ?? 0);

  const shipment = previews
    .filter(
      (p) =>
        p.family_key === "removal_shipment_missing" && !activeDedupeKeys.has(p.duplicate_key),
    )
    .sort(byQty)
    .slice(0, caps.shipment);

  const shipmentDedupes = new Set(shipment.map((p) => p.duplicate_key));

  const order = previews
    .filter(
      (p) =>
        p.family_key === "removal_order_discrepancy" &&
        !activeDedupeKeys.has(p.duplicate_key) &&
        !shipmentDedupes.has(p.duplicate_key),
    )
    .sort(byQty)
    .slice(0, caps.order);

  return [...shipment, ...order].slice(0, maxRows);
}

export function countEligibleEmitPreviews(
  previews: PreviewGeneratorItem[],
  activeDedupeKeys: Set<string>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of previews) {
    if (!(APPROVED_EMIT_V3_FAMILIES as readonly string[]).includes(p.family_key)) continue;
    if (previewEmitSkipReason(p)) continue;
    if (activeDedupeKeys.has(p.duplicate_key)) continue;
    counts[p.family_key] = (counts[p.family_key] ?? 0) + 1;
  }
  return counts;
}

async function runClaimPreviewEmitCore(options: {
  client: SupabaseClient;
  organizationId: string;
  storeId: string;
  intakeRunId: string;
  maxRows: number;
  dryRun: boolean;
  orderedPreviews: PreviewGeneratorItem[];
  draftByKey: Map<string, ClaimCandidateDraft>;
  effectivePolicy: Awaited<ReturnType<typeof loadEffectiveClaimIntakePolicy>>;
  approvalStatus: "signed" | "unsigned";
  generatorPhase: string;
  rollbackLabel: string;
  staging_only: boolean;
  safeFlagKey:
    | "SAFE_STAGING_CLAIM_CANDIDATE_EMIT_PILOT"
    | "SAFE_STAGING_EMIT_WAVE2"
    | "SAFE_ORIGINAL_EMIT_PILOT";
}): Promise<ClaimPreviewEmitPilotResult> {
  const skippedReasonCounts: Partial<Record<PreviewEmitSkipReason, number>> = {};
  const beforeCount = await countTable(options.client, "claim_candidates", options.organizationId);
  const claimCasesBefore = await countTable(options.client, "claim_cases", options.organizationId);

  const emitDrafts: ClaimCandidateDraft[] = [];
  const emittedFamilyCounts: Record<string, number> = {};
  const seenDedupe = new Set<string>();
  let skippedByDateCount = 0;

  for (const preview of options.orderedPreviews) {
    if (emitDrafts.length >= options.maxRows) {
      bumpSkip(skippedReasonCounts, "pilot_cap_reached");
      continue;
    }
    const skip = previewEmitSkipReason(preview);
    if (skip) {
      bumpSkip(skippedReasonCounts, skip);
      continue;
    }
    const draft = options.draftByKey.get(preview.duplicate_key);
    if (!draft) {
      bumpSkip(skippedReasonCounts, "draft_not_found");
      continue;
    }

    const dateGate = evaluateClaimPreviewEmitDateGate({
      source_kind: preview.source_kind,
      event_date: preview.event_date ?? preview.source_event_date ?? draft.event_date,
      policy: options.effectivePolicy,
    });
    if (!dateGate.pass) {
      if (dateGate.skip_reason) {
        bumpSkip(skippedReasonCounts, dateGate.skip_reason);
        skippedByDateCount += 1;
      }
      continue;
    }

    if (seenDedupe.has(draft.dedupe_key)) {
      bumpSkip(skippedReasonCounts, "identity_conflict");
      continue;
    }
    seenDedupe.add(draft.dedupe_key);
    emitDrafts.push(
      decorateDraftForEmit(draft, preview, dateGate, options.generatorPhase),
    );
    emittedFamilyCounts[preview.family_key] = (emittedFamilyCounts[preview.family_key] ?? 0) + 1;
  }

  const dedupeKeys = emitDrafts.map((d) => d.dedupe_key);
  const dedupeBlockers = await loadDedupeBlockers(
    options.client,
    options.organizationId,
    dedupeKeys,
  );
  const identitySkips = await loadSourceRowIdentitySkips(
    options.client,
    options.organizationId,
    emitDrafts,
  );

  const finalDrafts: ClaimCandidateDraft[] = [];
  for (const d of emitDrafts) {
    const block = dedupeBlockers.get(d.dedupe_key);
    if (block) {
      bumpSkip(skippedReasonCounts, block);
      continue;
    }
    if (identitySkips.has(d.dedupe_key)) {
      bumpSkip(skippedReasonCounts, "identity_conflict");
      continue;
    }
    finalDrafts.push(d);
  }

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let legacyCorroborated = 0;

  if (!options.dryRun && finalDrafts.length > 0) {
    const legacyOverlap = await countLegacyOverlap(
      options.client,
      options.organizationId,
      finalDrafts,
    );
    for (const draft of finalDrafts) {
      try {
        const stats = await applyDrafts(
          options.client,
          options.organizationId,
          [draft],
          legacyOverlap,
          options.intakeRunId,
        );
        inserted += stats.inserted;
        updated += stats.updated_existing_trusted;
        skipped += stats.skipped_identity_conflict;
        legacyCorroborated += stats.legacy_corroborated;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("duplicate key") || msg.includes("unique constraint")) {
          bumpSkip(skippedReasonCounts, "identity_conflict");
          skipped += 1;
          const fam = String(draft.metadata.family_key_v3 ?? "unknown");
          emittedFamilyCounts[fam] = Math.max(0, (emittedFamilyCounts[fam] ?? 1) - 1);
          continue;
        }
        throw e;
      }
    }
  }

  const afterCount = await countTable(options.client, "claim_candidates", options.organizationId);
  const claimCasesAfter = await countTable(options.client, "claim_cases", options.organizationId);

  const { data: emittedRows } = finalDrafts.length
    ? await options.client
        .from("claim_candidates")
        .select(
          "id, claim_family, source_kind, dedupe_key, source_event_key, organization_id, store_id, expected_quantity, intake_run_id, metadata, quarantined_at, rejected_at",
        )
        .eq("organization_id", options.organizationId)
        .eq("intake_run_id", options.intakeRunId)
    : { data: [] };

  const rows = (emittedRows ?? []) as Array<Record<string, unknown>>;
  const disputedEmitted = rows.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    return meta.build_status && String(meta.build_status).includes("disputed");
  }).length;

  const missingEdges = rows.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const ptrs = meta.evidence_pointers;
    return !Array.isArray(ptrs) || ptrs.length === 0;
  }).length;

  const missingSummary = rows.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    return !str(String(meta.evidence_summary ?? ""));
  }).length;

  const zeroCoerced = rows.filter((r) => {
    const amt = r.expected_amount;
    return amt === 0;
  }).length;

  const orgScoped = rows.every((r) => r.organization_id === options.organizationId);
  const storeScoped = rows.every((r) => r.store_id === options.storeId);

  const dateGateRowsPass = rows.every((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    return (
      meta.date_gate_passed === true &&
      str(String(meta.effective_date_source ?? "")) !== "" &&
      str(String(meta.effective_date_value ?? "")) !== "" &&
      str(String(meta.source_event_date ?? "")) !== ""
    );
  });

  const effectiveDateGateResult: EffectiveDateGateResult = {
    pass:
      !!options.effectivePolicy.claim_start_date &&
      !!options.effectivePolicy.scan_go_live_date &&
      (rows.length === 0 || dateGateRowsPass),
    policy_scan_go_live_date: options.effectivePolicy.scan_go_live_date,
    policy_claim_start_date: options.effectivePolicy.claim_start_date,
    skipped_by_date_count: skippedByDateCount,
    emitted_with_date_gate_passed: rows.filter((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      return meta.date_gate_passed === true;
    }).length,
    all_emitted_rows_date_gate_passed: rows.length === 0 || dateGateRowsPass,
  };

  const validationsPass =
    claimCasesBefore === claimCasesAfter &&
    disputedEmitted === 0 &&
    missingEdges === 0 &&
    missingSummary === 0 &&
    zeroCoerced === 0 &&
    orgScoped &&
    storeScoped &&
    effectiveDateGateResult.pass &&
    (options.dryRun || inserted + updated <= options.maxRows);

  const safeYes: "yes" | "no" = options.dryRun
    ? "no"
    : validationsPass && inserted + updated > 0
      ? "yes"
      : validationsPass
        ? "yes"
        : "no";

  const result: ClaimPreviewEmitPilotResult = {
    contract_version: EMIT_CONTRACT_VERSION,
    staging_only: options.staging_only,
    intake_run_id: options.intakeRunId,
    before_count: beforeCount,
    after_count: afterCount,
    inserted_count: inserted,
    updated_count: updated,
    skipped_count:
      skipped + Object.values(skippedReasonCounts).reduce((a, b) => a + (b ?? 0), 0),
    skipped_by_date_count: skippedByDateCount,
    effective_date_gate_result: effectiveDateGateResult,
    legacy_corroborated_count: legacyCorroborated,
    emitted_family_counts: emittedFamilyCounts,
    skipped_reason_counts: skippedReasonCounts,
    sample_emitted_rows: rows.slice(0, 10),
    duplicate_prevention_result: {
      pass: rows.every((r) => str(String(r.dedupe_key ?? "")) !== ""),
      all_have_dedupe_key: rows.every((r) => str(String(r.dedupe_key ?? "")) !== ""),
    },
    disputed_exclusion_result: { pass: disputedEmitted === 0, disputed_emitted: disputedEmitted },
    source_edge_validation: { pass: missingEdges === 0, missing_edges: missingEdges },
    evidence_summary_validation: { pass: missingSummary === 0, missing_summary: missingSummary },
    money_field_validation: { pass: zeroCoerced === 0, zero_coerced: zeroCoerced },
    no_claim_case_mutation_verification: {
      pass: claimCasesBefore === claimCasesAfter,
      before: claimCasesBefore,
      after: claimCasesAfter,
    },
    RLS_scope_verification: { pass: orgScoped && storeScoped, org_scoped: orgScoped, store_scoped: storeScoped },
    rollback_sql: rollbackSql(options.intakeRunId, options.rollbackLabel),
    approval_file_status: options.approvalStatus,
    SAFE_STAGING_CLAIM_CANDIDATE_EMIT_PILOT: safeYes,
    SAFE_TO_PLAN_ORIGINAL_EMIT_PILOT: "no",
  };

  if (options.safeFlagKey === "SAFE_STAGING_EMIT_WAVE2") {
    (result as ClaimPreviewEmitPilotResult & { SAFE_STAGING_EMIT_WAVE2?: string }).SAFE_STAGING_EMIT_WAVE2 =
      safeYes;
  }
  if (options.safeFlagKey === "SAFE_ORIGINAL_EMIT_PILOT") {
    (result as ClaimPreviewEmitPilotResult & { SAFE_ORIGINAL_EMIT_PILOT?: string }).SAFE_ORIGINAL_EMIT_PILOT =
      safeYes;
  }

  return result;
}

async function loadPreviewEmitContext(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
) {
  const effectivePolicy = await loadEffectiveClaimIntakePolicy(client, organizationId, storeId);
  if (!effectivePolicy.claim_start_date || !effectivePolicy.scan_go_live_date) {
    throw new Error(
      "BLOCKED: claim_start_date and scan_go_live_date must be configured before emit",
    );
  }
  const previewPayload = await buildFirstSafeFamiliesPreviewGenerators({
    client,
    organizationId,
    storeId,
    include_all_previews: true,
    rowLimit: 400,
    prerequisite_safe: "yes",
  });
  const { settings } = await loadClaimIntakeSettings(client, organizationId);
  const window = resolveClaimIntakeWindow(settings, null, null, new Date(), effectivePolicy);
  const sourceKinds = CLAIM_INTAKE_GENERATORS.map((g) => g.source_kind);
  const allDrafts = await collectDrafts(client, organizationId, storeId, sourceKinds, window, 400);
  const draftByKey = new Map(allDrafts.map((d) => [d.dedupe_key, d]));
  const claimReadyApproved = previewPayload.previews.filter(
    (p) =>
      (APPROVED_EMIT_V3_FAMILIES as readonly string[]).includes(p.family_key) &&
      p.recommended_action === "claim_ready",
  );
  return { effectivePolicy, draftByKey, claimReadyApproved };
}

/** Staging pilot V1: preview claim_ready → applyDrafts (max 50 rows). */
export async function runClaimPreviewEmitStagingPilotV1(options: {
  client: SupabaseClient;
  organizationId: string;
  storeId: string;
  intakeRunId?: string;
  maxRows?: number;
  dryRun?: boolean;
}): Promise<ClaimPreviewEmitPilotResult> {
  assertStagingPilotClient(options.client);
  const approval = readPilotApprovalStatus();
  if (!approval.approved) {
    throw new Error(`BLOCKED: operator approval required — ${approval.reason}`);
  }
  const maxRows = options.maxRows ?? DEFAULT_PILOT_MAX_ROWS;
  const intakeRunId = options.intakeRunId ?? randomUUID();
  const { effectivePolicy, draftByKey, claimReadyApproved } = await loadPreviewEmitContext(
    options.client,
    options.organizationId,
    options.storeId,
  );
  const ordered = [...claimReadyApproved].sort(
    (a, b) => (b.quantity_claimed ?? 0) - (a.quantity_claimed ?? 0),
  );
  return runClaimPreviewEmitCore({
    client: options.client,
    organizationId: options.organizationId,
    storeId: options.storeId,
    intakeRunId,
    maxRows,
    dryRun: options.dryRun ?? false,
    orderedPreviews: ordered,
    draftByKey,
    effectivePolicy,
    approvalStatus: approval.status,
    generatorPhase: "preview_emit_staging_pilot_v1",
    rollbackLabel: "PHASE-CLAIM-CANDIDATE-EMIT-STAGING-PILOT-V1",
    staging_only: true,
    safeFlagKey: "SAFE_STAGING_CLAIM_CANDIDATE_EMIT_PILOT",
  });
}

/** Staging wave 2: prioritize removal_shipment_missing, then new order_discrepancy rows. */
export async function runClaimPreviewEmitStagingWave2V1(options: {
  client: SupabaseClient;
  organizationId: string;
  storeId: string;
  intakeRunId?: string;
  maxRows?: number;
  dryRun?: boolean;
}): Promise<ClaimPreviewEmitWave2Result> {
  assertStagingPilotClient(options.client);
  const approval = readWave2ApprovalStatus();
  if (!approval.approved) {
    throw new Error(`BLOCKED: wave2 operator approval required — ${approval.reason}`);
  }
  const maxRows = options.maxRows ?? DEFAULT_PILOT_MAX_ROWS;
  const intakeRunId = options.intakeRunId ?? randomUUID();
  const { effectivePolicy, draftByKey, claimReadyApproved } = await loadPreviewEmitContext(
    options.client,
    options.organizationId,
    options.storeId,
  );
  const activeDedupeKeys = await loadActiveTrustedDedupeKeys(
    options.client,
    options.organizationId,
  );
  const ordered = sortPreviewsForWave2Emit(claimReadyApproved, activeDedupeKeys);
  const core = await runClaimPreviewEmitCore({
    client: options.client,
    organizationId: options.organizationId,
    storeId: options.storeId,
    intakeRunId,
    maxRows,
    dryRun: options.dryRun ?? false,
    orderedPreviews: ordered,
    draftByKey,
    effectivePolicy,
    approvalStatus: approval.status,
    generatorPhase: "preview_emit_staging_wave2_v1",
    rollbackLabel: "PHASE-CLAIM-CANDIDATE-EMIT-STAGING-WAVE2-V1",
    staging_only: true,
    safeFlagKey: "SAFE_STAGING_EMIT_WAVE2",
  });
  const shipmentCount = core.emitted_family_counts.removal_shipment_missing ?? 0;
  const orderCount = core.emitted_family_counts.removal_order_discrepancy ?? 0;
  const safeWave2: "yes" | "no" =
    (core as ClaimPreviewEmitPilotResult & { SAFE_STAGING_EMIT_WAVE2?: string }).SAFE_STAGING_EMIT_WAVE2 ===
      "yes" && shipmentCount > 0
      ? "yes"
      : core.SAFE_STAGING_CLAIM_CANDIDATE_EMIT_PILOT === "yes" && shipmentCount > 0
        ? "yes"
        : "no";
  return {
    ...core,
    wave: "staging_wave2_v1",
    removal_shipment_missing_count: shipmentCount,
    removal_order_discrepancy_count: orderCount,
    SAFE_STAGING_EMIT_WAVE2: options.dryRun ? "no" : safeWave2,
  };
}

/** Original/live pilot: approved families only, cap 50 (or 25 conservative). */
export async function runClaimPreviewEmitOriginalPilotV1(options: {
  client: SupabaseClient;
  organizationId: string;
  storeId: string;
  intakeRunId?: string;
  maxRows?: number;
  dryRun?: boolean;
  conservativeCap?: boolean;
}): Promise<ClaimPreviewEmitOriginalPilotResult> {
  assertOriginalPilotClient(options.client);
  const approval = readOriginalPilotApprovalStatus();
  if (!approval.approved) {
    throw new Error(`BLOCKED: original operator approval required — ${approval.reason}`);
  }

  const selectedCap =
    options.maxRows ??
    (options.conservativeCap ? DEFAULT_ORIGINAL_CONSERVATIVE_CAP : approval.max_rows_cap);
  if (selectedCap > DEFAULT_PILOT_MAX_ROWS && !options.conservativeCap) {
    throw new Error(`BLOCKED: original pilot cap ${selectedCap} exceeds max ${DEFAULT_PILOT_MAX_ROWS}`);
  }

  const intakeRunId = options.intakeRunId ?? randomUUID();
  const { effectivePolicy, draftByKey, claimReadyApproved } = await loadPreviewEmitContext(
    options.client,
    options.organizationId,
    options.storeId,
  );
  const activeDedupeKeys = await loadActiveTrustedDedupeKeys(
    options.client,
    options.organizationId,
  );
  const eligibleCounts = countEligibleEmitPreviews(claimReadyApproved, activeDedupeKeys);
  const ordered = await selectPreviewsForOriginalPilotEmitAsync(
    options.client,
    options.organizationId,
    claimReadyApproved,
    activeDedupeKeys,
    selectedCap,
  );

  const core = await runClaimPreviewEmitCore({
    client: options.client,
    organizationId: options.organizationId,
    storeId: options.storeId,
    intakeRunId,
    maxRows: selectedCap,
    dryRun: options.dryRun ?? false,
    orderedPreviews: ordered,
    draftByKey,
    effectivePolicy,
    approvalStatus: approval.status,
    generatorPhase: "preview_emit_original_pilot_v1",
    rollbackLabel: "PHASE-CLAIM-CANDIDATE-EMIT-ORIGINAL-PILOT-V1",
    staging_only: false,
    safeFlagKey: "SAFE_ORIGINAL_EMIT_PILOT",
  });

  const shipmentCount = core.emitted_family_counts.removal_shipment_missing ?? 0;
  const orderCount = core.emitted_family_counts.removal_order_discrepancy ?? 0;

  const { data: allEmitted } = await options.client
    .from("claim_candidates")
    .select("id, metadata, dedupe_key, source_event_key")
    .eq("organization_id", options.organizationId)
    .eq("intake_run_id", intakeRunId);

  let needsReviewEmitted = 0;
  let previewOnlyEmitted = 0;
  for (const r of (allEmitted ?? []) as Array<{ metadata: Record<string, unknown> | null }>) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    if (meta.recommended_action === "needs_review") needsReviewEmitted += 1;
    const fam = String(meta.family_key_v3 ?? "");
    if (fam && !(APPROVED_EMIT_V3_FAMILIES as readonly string[]).includes(fam)) {
      previewOnlyEmitted += 1;
    }
  }

  const familyCaps = resolveOriginalFamilyCaps(selectedCap);
  const safeOriginal: "yes" | "no" =
    !options.dryRun &&
    (core as ClaimPreviewEmitPilotResult & { SAFE_ORIGINAL_EMIT_PILOT?: string }).SAFE_ORIGINAL_EMIT_PILOT ===
      "yes" &&
    core.no_claim_case_mutation_verification.pass &&
    core.disputed_exclusion_result.pass &&
    core.effective_date_gate_result.pass &&
    previewOnlyEmitted === 0 &&
    needsReviewEmitted === 0 &&
    shipmentCount + orderCount > 0 &&
    shipmentCount <= familyCaps.shipment &&
    orderCount <= familyCaps.order
      ? "yes"
      : "no";

  const safeUi: "yes" | "no" = safeOriginal === "yes" ? "yes" : "no";

  const { staging_only: _s, SAFE_STAGING_CLAIM_CANDIDATE_EMIT_PILOT: _p, SAFE_TO_PLAN_ORIGINAL_EMIT_PILOT: _t, ...rest } =
    core;

  return {
    ...rest,
    original_only: true,
    original_ref: ORIGINAL_PILOT_REF,
    original_ref_guard: { pass: true, ref: ORIGINAL_PILOT_REF },
    selected_cap: selectedCap,
    eligible_preview_counts: eligibleCounts,
    removal_shipment_missing_count: shipmentCount,
    removal_order_discrepancy_count: orderCount,
    needs_review_exclusion_result: { pass: needsReviewEmitted === 0, needs_review_emitted: needsReviewEmitted },
    preview_only_family_exclusion_result: {
      pass: previewOnlyEmitted === 0,
      preview_only_emitted: previewOnlyEmitted,
    },
    dedupe_result: core.duplicate_prevention_result,
    source_edge_result: core.source_edge_validation,
    evidence_summary_result: core.evidence_summary_validation,
    money_field_result: core.money_field_validation,
    SAFE_ORIGINAL_EMIT_PILOT: options.dryRun ? "no" : safeOriginal,
    SAFE_TO_REVIEW_ORIGINAL_CANDIDATES_UI: options.dryRun ? "no" : safeUi,
  };
}

export function isApprovedEmitFamily(familyKey: string): familyKey is ApprovedEmitV3Family {
  return (APPROVED_EMIT_V3_FAMILIES as readonly string[]).includes(familyKey);
}
