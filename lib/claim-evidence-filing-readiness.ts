/**
 * CLAIM-EVIDENCE-08 — Filing readiness gate (read-only with respect to claim submission).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ClaimEvidenceWarning } from "./claim-evidence-preview";
import type { ClaimEvidenceEdgeReviewSummary } from "./claim-evidence-edge-review";

export type ClaimEvidenceDraftOperatorState = {
  warnings_acknowledged_at: string | null;
  warnings_acknowledged_by: string | null;
  acknowledged_warning_codes: string[];
};

export type FilingReadinessGate = {
  /** True when all gate checks pass (does not submit claims). */
  ready: boolean;
  all_edges_reviewed: boolean;
  no_blocking_rejected: boolean;
  warnings_clear_or_acknowledged: boolean;
  blockers: string[];
  review_summary: ClaimEvidenceEdgeReviewSummary;
  actionable_warning_count: number;
  warnings_acknowledged: boolean;
};

const NON_ACTIONABLE_WARNING_CODES = new Set([
  "preview_only",
  "persisted_edges_available",
]);

export function filterActionableWarnings(warnings: ClaimEvidenceWarning[]): ClaimEvidenceWarning[] {
  return warnings.filter(
    (w) =>
      !NON_ACTIONABLE_WARNING_CODES.has(w.code) &&
      (w.severity === "error" || w.severity === "warn"),
  );
}

export function computeFilingReadiness(input: {
  reviewSummary: ClaimEvidenceEdgeReviewSummary;
  warnings: ClaimEvidenceWarning[];
  operatorState: ClaimEvidenceDraftOperatorState | null;
}): FilingReadinessGate {
  const blockers: string[] = [];
  const { reviewSummary, warnings, operatorState } = input;

  const all_edges_reviewed =
    reviewSummary.total > 0 && reviewSummary.needs_review === 0;
  if (!all_edges_reviewed) {
    if (reviewSummary.total === 0) blockers.push("no_persisted_edges");
    else blockers.push(`${reviewSummary.needs_review}_edges_need_review`);
  }

  const no_blocking_rejected = reviewSummary.rejected === 0;
  if (!no_blocking_rejected) {
    blockers.push(`${reviewSummary.rejected}_edges_rejected`);
  }

  const actionable = filterActionableWarnings(warnings);
  const warnings_acknowledged = operatorState?.warnings_acknowledged_at != null;
  const warnings_clear_or_acknowledged = actionable.length === 0 || warnings_acknowledged;
  if (!warnings_clear_or_acknowledged) {
    blockers.push("evidence_warnings_require_acknowledgement");
  }

  return {
    ready: blockers.length === 0,
    all_edges_reviewed,
    no_blocking_rejected,
    warnings_clear_or_acknowledged,
    blockers,
    review_summary: reviewSummary,
    actionable_warning_count: actionable.length,
    warnings_acknowledged,
  };
}

export async function probeFilingReadinessSchema(client: SupabaseClient): Promise<boolean> {
  const { error } = await client.from("claim_evidence_draft_operator_state").select("draft_id").limit(1);
  if (!error) return true;
  const msg = error.message ?? "";
  return !(msg.includes("Could not find") || msg.includes("does not exist") || error.code === "42P01");
}

export async function loadDraftOperatorState(
  client: SupabaseClient,
  organizationId: string,
  draftId: string,
): Promise<ClaimEvidenceDraftOperatorState | null> {
  if (!(await probeFilingReadinessSchema(client))) return null;

  const { data, error } = await client
    .from("claim_evidence_draft_operator_state")
    .select("warnings_acknowledged_at, warnings_acknowledged_by, acknowledged_warning_codes")
    .eq("organization_id", organizationId)
    .eq("draft_id", draftId)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  const codes = row.acknowledged_warning_codes;
  return {
    warnings_acknowledged_at:
      row.warnings_acknowledged_at != null ? String(row.warnings_acknowledged_at) : null,
    warnings_acknowledged_by:
      row.warnings_acknowledged_by != null ? String(row.warnings_acknowledged_by) : null,
    acknowledged_warning_codes: Array.isArray(codes)
      ? codes.map((c) => String(c)).filter(Boolean)
      : [],
  };
}

export async function acknowledgeEvidenceWarnings(
  client: SupabaseClient,
  input: {
    organizationId: string;
    draftId: string;
    reviewedBy: string;
    warningCodes: string[];
  },
): Promise<ClaimEvidenceDraftOperatorState> {
  if (!(await probeFilingReadinessSchema(client))) {
    throw new Error(
      "Filing readiness tables missing — apply migration 20260822120000_claim_evidence_filing_readiness.sql",
    );
  }

  const now = new Date().toISOString();
  const payload = {
    draft_id: input.draftId,
    organization_id: input.organizationId,
    warnings_acknowledged_at: now,
    warnings_acknowledged_by: input.reviewedBy,
    acknowledged_warning_codes: input.warningCodes,
    updated_at: now,
  };

  const { error } = await client.from("claim_evidence_draft_operator_state").upsert(payload, {
    onConflict: "draft_id",
  });
  if (error) throw new Error(`claim_evidence_draft_operator_state upsert: ${error.message}`);

  return {
    warnings_acknowledged_at: now,
    warnings_acknowledged_by: input.reviewedBy,
    acknowledged_warning_codes: input.warningCodes,
  };
}
