/**
 * PHASE-LIVE-REFERENCE-API-COMPLETION-V1
 *
 * Deterministic, read-only / dry-run live reference layer for claim self-sufficiency.
 *
 * Hard rules (enforced by construction):
 *  - No DB writes. No claim_* mutation. No Amazon submit. No live SP-API call.
 *  - No invented TRID. No title/name-only matching. VRET is not TRID.
 *  - Reimbursement matching stays blocked until a real amazon_case_id (or safe
 *    post-filing references) exist.
 *  - All write actions disabled unless a future explicit operator approval flips
 *    a guard (not present in this phase).
 */
import fs from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../filing/claim-filing-packet-v1-plan-contract";
import { composeReimbursementTrackingPreviewV1 } from "../submission/claim-reimbursement-tracking-preview-v1";
import type { ReimbursementTrackingPreviewRow } from "../submission/claim-reimbursement-tracking-preview-v1";
import {
  composeClaimLiveReferenceApiCompletionAuditV1,
  type ReferenceCoverageRow,
} from "./claim-live-reference-api-completion-audit-v1";

export const CLAIM_LIVE_REFERENCE_API_COMPLETION_V1 =
  "claim-live-reference-api-completion-v1" as const;

/** Live SP-API reference sync is NEVER executed in this phase. Future approval only. */
export const LIVE_SP_API_SYNC_ENABLED = false;
export const REFERENCE_WRITE_ENABLED = false;

type RunOpts = { pilot_case_run_id?: string; intake_run_id?: string };

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function fileExists(rel: string): boolean {
  return fs.existsSync(path.join(process.cwd(), rel));
}

export type ReferenceContext = {
  pilot_case_run_id: string;
  intake_run_id: string;
  coverage: ReferenceCoverageRow[];
  previews: ReimbursementTrackingPreviewRow[];
  no_claim_mutation_verification: boolean;
};

/**
 * Loads coverage matrix (from the verified audit composer) + tracking previews
 * once, so each endpoint derives deterministically from the same snapshot.
 */
export async function loadReferenceContext(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  opts: RunOpts = {},
): Promise<ReferenceContext> {
  const pilotCaseRunId = opts.pilot_case_run_id ?? PILOT_CASE_RUN_ID;
  const intakeRunId = opts.intake_run_id ?? PILOT_INTAKE_RUN_ID;

  const [audit, tracking] = await Promise.all([
    composeClaimLiveReferenceApiCompletionAuditV1(client, organizationId, storeId, {
      pilot_case_run_id: pilotCaseRunId,
      intake_run_id: intakeRunId,
    }),
    composeReimbursementTrackingPreviewV1(client, organizationId, storeId, {
      pilot_case_run_id: pilotCaseRunId,
      intake_run_id: intakeRunId,
    }),
  ]);

  return {
    pilot_case_run_id: pilotCaseRunId,
    intake_run_id: intakeRunId,
    coverage: audit.reference_coverage_matrix,
    previews: tracking.previews,
    no_claim_mutation_verification: audit.no_claim_mutation_verification,
  };
}

function findCoverage(
  ctx: ReferenceContext,
  args: { claim_submission_id?: string; claim_case_id?: string },
): ReferenceCoverageRow | null {
  const subId = str(args.claim_submission_id);
  const caseId = str(args.claim_case_id);
  return (
    ctx.coverage.find(
      (r) =>
        (subId && r.claim_submission_id === subId) ||
        (caseId && r.claim_case_id === caseId),
    ) ?? null
  );
}

function findPreview(
  ctx: ReferenceContext,
  args: { claim_submission_id?: string; claim_case_id?: string },
): ReimbursementTrackingPreviewRow | null {
  const subId = str(args.claim_submission_id);
  const caseId = str(args.claim_case_id);
  return (
    ctx.previews.find(
      (p) =>
        (subId && p.claim_submission_id === subId) ||
        (caseId && p.claim_case_id === caseId),
    ) ?? null
  );
}

// ── 1. TRID resolver ────────────────────────────────────────────────────────

export type TridResolverResult = {
  found: boolean;
  claim_submission_id: string | null;
  claim_case_id: string | null;
  trid: string | null;
  trid_source: "product_link" | "expected_package_id_anchor" | "resolved_product_id" | "none";
  expected_package_id: string | null;
  resolved_product_id: string | null;
  family: string | null;
  confidence: "high" | "medium" | "low" | "none";
  source_edges: Array<{ kind: string; value: string }>;
  missing_refs: string[];
  no_invented_trid: true;
  dry_run: true;
};

function tridSourceFromSubstitute(
  row: ReferenceCoverageRow,
): TridResolverResult["trid_source"] {
  if (!row.trid_present) return "none";
  if (!row.trid_substitute) return "product_link";
  if (row.trid_substitute === "expected_package_id_anchor") return "expected_package_id_anchor";
  if (row.trid_substitute === "resolved_product_id") return "resolved_product_id";
  return "product_link";
}

function confidenceFromSource(source: TridResolverResult["trid_source"]): TridResolverResult["confidence"] {
  switch (source) {
    case "product_link":
      return "high";
    case "expected_package_id_anchor":
      return "medium";
    case "resolved_product_id":
      return "low";
    default:
      return "none";
  }
}

export function resolveTridFromContext(
  ctx: ReferenceContext,
  args: { claim_submission_id?: string; claim_case_id?: string },
): TridResolverResult {
  const row = findCoverage(ctx, args);
  const preview = findPreview(ctx, args);

  if (!row) {
    return {
      found: false,
      claim_submission_id: str(args.claim_submission_id) || null,
      claim_case_id: str(args.claim_case_id) || null,
      trid: null,
      trid_source: "none",
      expected_package_id: null,
      resolved_product_id: null,
      family: null,
      confidence: "none",
      source_edges: [],
      missing_refs: ["claim_submission_or_case_not_in_pilot_scope"],
      no_invented_trid: true,
      dry_run: true,
    };
  }

  const source = tridSourceFromSubstitute(row);
  const sourceEdges = (preview?.detail_preview.reference_graph_lines ?? [])
    .filter((l) => str(l.value))
    .map((l) => ({ kind: str(l.kind), value: str(l.value) }));

  const epEdge = sourceEdges.find((e) => e.kind.toLowerCase().includes("expected_package"));
  const expectedPackageId =
    source === "expected_package_id_anchor" ? row.trid_value : epEdge?.value ?? null;
  const resolvedProductId =
    source === "product_link" || source === "resolved_product_id" ? row.trid_value : null;

  return {
    found: true,
    claim_submission_id: row.claim_submission_id,
    claim_case_id: row.claim_case_id,
    trid: row.trid_value,
    trid_source: source,
    expected_package_id: expectedPackageId,
    resolved_product_id: resolvedProductId,
    family: row.family_key_v3,
    confidence: confidenceFromSource(source),
    source_edges: sourceEdges,
    missing_refs: row.missing_for_case_opening,
    no_invented_trid: true,
    dry_run: true,
  };
}

// ── 2. Reference refresh preview (dry-run only) ───────────────────────────────

export type ReferenceRefreshPreviewResult = {
  claim_submission_id: string;
  claim_case_id: string | null;
  dry_run: true;
  would_write: false;
  live_sp_api_called: false;
  live_sp_api_sync_enabled: boolean;
  source: "already_loaded_amazon_tables";
  proposed_edges: Array<{
    kind: string;
    value: string;
    status: "already_materialized";
    source: string;
  }>;
  unresolvable_without_live_sync: string[];
  note: string;
};

export function buildReferenceRefreshPreviewFromContext(
  ctx: ReferenceContext,
  args: { claim_submission_id: string },
): ReferenceRefreshPreviewResult | { error: string } {
  const preview = findPreview(ctx, { claim_submission_id: args.claim_submission_id });
  const row = findCoverage(ctx, { claim_submission_id: args.claim_submission_id });
  if (!preview || !row) {
    return { error: "claim_submission_id not found in pilot scope." };
  }

  const proposed = (preview.detail_preview.reference_graph_lines ?? [])
    .filter((l) => str(l.value))
    .map((l) => ({
      kind: str(l.kind),
      value: str(l.value),
      status: "already_materialized" as const,
      source: str(l.source) || "claim_reference_edges",
    }));

  // Refs that the deterministic graph cannot propose without a governed live pull.
  const unresolvable = row.missing_for_case_opening.filter((m) =>
    ["removal_order_id", "tracking_number", "lpn"].some((k) => m.includes(k)),
  );

  return {
    claim_submission_id: preview.claim_submission_id,
    claim_case_id: preview.claim_case_id,
    dry_run: true,
    would_write: false,
    live_sp_api_called: false,
    live_sp_api_sync_enabled: LIVE_SP_API_SYNC_ENABLED,
    source: "already_loaded_amazon_tables",
    proposed_edges: proposed,
    unresolvable_without_live_sync: unresolvable,
    note:
      "Dry-run reference refresh from already-loaded amazon_* tables. No Amazon call, no DB write. " +
      "Live SP-API sync requires future explicit operator approval.",
  };
}

// ── 3. Reference coverage matrix ──────────────────────────────────────────────

export type ReferenceCoverageSummary = {
  pilot_case_run_id: string;
  intake_run_id: string;
  pilot_submission_count: number;
  trid_coverage_count: string;
  removal_shipment_coverage_count: string;
  removal_order_coverage_count: string;
  fnsku_sku_asin_coverage_count: string;
  amazon_case_id_coverage_count: string;
  reimbursement_ref_coverage_count: string;
  matrix: ReferenceCoverageRow[];
  dry_run: true;
};

function ratio(rows: ReferenceCoverageRow[], pred: (r: ReferenceCoverageRow) => boolean): string {
  const denom = rows.length;
  const num = rows.filter(pred).length;
  return `${num}/${denom}`;
}

export function buildReferenceCoverageSummary(ctx: ReferenceContext): ReferenceCoverageSummary {
  const rows = ctx.coverage;
  const shipmentRows = rows.filter((r) => r.family_key_v3 === "removal_shipment_missing");
  const orderRows = rows.filter((r) => r.family_key_v3 === "removal_order_discrepancy");

  return {
    pilot_case_run_id: ctx.pilot_case_run_id,
    intake_run_id: ctx.intake_run_id,
    pilot_submission_count: rows.length,
    trid_coverage_count: ratio(rows, (r) => r.trid_present),
    removal_shipment_coverage_count: `${shipmentRows.filter((r) => r.removal_shipment_id_present || r.tracking_present).length}/${shipmentRows.length}`,
    removal_order_coverage_count: `${orderRows.filter((r) => r.removal_order_id_present).length}/${orderRows.length}`,
    fnsku_sku_asin_coverage_count: ratio(rows, (r) => r.fnsku_sku_asin_present),
    amazon_case_id_coverage_count: ratio(rows, (r) => r.amazon_case_id_present),
    reimbursement_ref_coverage_count: ratio(rows, (r) => r.reimbursement_ref_present),
    matrix: rows,
    dry_run: true,
  };
}

// ── 4. Reimbursement match refresh preview (dry-run, blocked w/o case id) ──────

export type ReimbursementMatchPreviewResult = {
  claim_submission_id: string;
  claim_case_id: string | null;
  status: "blocked" | "pending" | "proposed";
  blocked_reason: string | null;
  amazon_case_id_present: boolean;
  amazon_case_id: string | null;
  proposed_matches: Array<{
    reference: string;
    amount: number | null;
    posted_date: string | null;
    match_reason: string;
    confidence: string;
  }>;
  dry_run: true;
  would_close_claim: false;
  would_write: false;
};

export function buildReimbursementMatchPreviewFromContext(
  ctx: ReferenceContext,
  args: { claim_submission_id: string },
): ReimbursementMatchPreviewResult | { error: string } {
  const preview = findPreview(ctx, { claim_submission_id: args.claim_submission_id });
  const row = findCoverage(ctx, { claim_submission_id: args.claim_submission_id });
  if (!preview || !row) {
    return { error: "claim_submission_id not found in pilot scope." };
  }

  const caseId = str(preview.future_amazon_case_id) || null;
  const caseIdPresent = row.amazon_case_id_present && Boolean(caseId);

  if (!caseIdPresent) {
    return {
      claim_submission_id: preview.claim_submission_id,
      claim_case_id: preview.claim_case_id,
      status: "blocked",
      blocked_reason:
        "Reimbursement matching blocked: no real Amazon Case ID on claim_submission. " +
        "Matching remains blocked until case id or safe post-filing references exist.",
      amazon_case_id_present: false,
      amazon_case_id: null,
      proposed_matches: [],
      dry_run: true,
      would_close_claim: false,
      would_write: false,
    };
  }

  const proposed = (preview.linked_reimbursement_rows ?? []).map((r) => ({
    reference: str(r.reference_key) || str(r.order_id) || str(r.id),
    amount: r.amount ?? null,
    posted_date: r.posted_date ?? null,
    match_reason: str(r.match_reason) || "reference_match",
    confidence: str(preview.match_confidence) || "low",
  }));

  return {
    claim_submission_id: preview.claim_submission_id,
    claim_case_id: preview.claim_case_id,
    status: proposed.length > 0 ? "proposed" : "pending",
    blocked_reason:
      proposed.length > 0
        ? null
        : "Case id present but no reimbursement row matched yet — pending Amazon payout.",
    amazon_case_id_present: true,
    amazon_case_id: caseId,
    proposed_matches: proposed,
    dry_run: true,
    would_close_claim: false,
    would_write: false,
  };
}

// ── Static contract verification (smoke) ──────────────────────────────────────

export function verifyLiveReferenceApiCompletionContractStatic(): boolean {
  return (
    LIVE_SP_API_SYNC_ENABLED === false &&
    REFERENCE_WRITE_ENABLED === false &&
    fileExists("app/api/claims/center/references/trid-resolver/route.ts") &&
    fileExists("app/api/claims/center/references/refresh-preview/route.ts") &&
    fileExists("app/api/claims/center/references/coverage/route.ts") &&
    fileExists("app/api/claims/center/reimbursement-match/refresh-preview/route.ts") &&
    fileExists("lib/claims/reference/claim-live-reference-api-completion-audit-v1.ts")
  );
}
