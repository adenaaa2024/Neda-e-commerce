import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { evaluateClaimEligibilitySync } from "./claim-eligibility-policy";
import {
  evaluateClaimSubmissionReadiness,
  type ClaimGateEvaluation,
} from "./claim-settings-gates";
import { getEffectiveClaimSettings, toEffectiveClaimSettingsSnapshot } from "./claim-effective-settings";
import { getReturnPhotoEvidenceGalleryUrls, type ReturnPhotoEvidenceRow } from "./return-photo-evidence";
import { packageStatusIsClosed, returnHasResolvedProduct, returnHasScannerPhotoEvidence } from "./returns-claims-work-queue";
import { pickPrimaryScannerIssueFromConditions } from "./scanner-claim-issue-pick";
import { isUuidString } from "./uuid";

export type { ClaimGateEvaluation };

export async function evaluateClaimCaseSubmissionReadiness(
  client: SupabaseClient,
  claimCaseId: string,
  organizationId: string,
): Promise<ClaimGateEvaluation> {
  const cid = String(claimCaseId ?? "").trim();
  const orgId = String(organizationId ?? "").trim();
  if (!isUuidString(cid) || !isUuidString(orgId)) {
    return {
      allowed: false,
      reason: "invalid_ids",
      display_code: "promote_disabled",
      display_label: "Not ready for submission",
      display_hint: "Invalid case or organization id.",
    };
  }

  const { data: claimCase, error: caseErr } = await client
    .from("claim_cases")
    .select("id, store_id, primary_return_item_id, metadata")
    .eq("id", cid)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (caseErr) throw new Error(caseErr.message);
  if (!claimCase) {
    return {
      allowed: false,
      reason: "claim_case_not_found",
      display_code: "promote_disabled",
      display_label: "Not ready for submission",
      display_hint: "Claim case not found.",
    };
  }

  const meta = (claimCase.metadata as Record<string, unknown> | null) ?? {};
  const existingSub = String(meta.claim_submission_id ?? "").trim();
  if (existingSub && isUuidString(existingSub)) {
    return evaluateClaimSubmissionReadiness({
      settings: toEffectiveClaimSettingsSnapshot(
        await getEffectiveClaimSettings(client, orgId, (claimCase.store_id as string | null) ?? null),
      ),
      hasResolvedProduct: true,
      hasScannerEvidence: true,
      hasOperatorNote: true,
      eligibilityAllowed: true,
      eligibilityReason: "allowed",
      alreadyHasSubmission: true,
    });
  }

  const returnItemId = String(claimCase.primary_return_item_id ?? "").trim();
  if (!returnItemId || !isUuidString(returnItemId)) {
    return {
      allowed: false,
      reason: "missing_primary_return_item",
      display_code: "promote_disabled",
      display_label: "Not ready for submission",
      display_hint: "Case has no primary return item.",
    };
  }

  const { data: returnItem, error: riErr } = await client
    .from("return_items")
    .select(
      "id, store_id, package_id, conditions, photo_evidence, notes, resolved_product_id, created_at, deleted_at",
    )
    .eq("id", returnItemId)
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (riErr) throw new Error(riErr.message);
  if (!returnItem) {
    return {
      allowed: false,
      reason: "return_item_not_found",
      display_code: "promote_disabled",
      display_label: "Not ready for submission",
      display_hint: "Primary return item not found.",
    };
  }

  const ri = returnItem as {
    store_id: string | null;
    package_id: string | null;
    conditions: string[] | null;
    photo_evidence: ReturnPhotoEvidenceRow;
    notes: string | null;
    resolved_product_id: string | null;
    created_at: string | null;
  };

  const settings = await getEffectiveClaimSettings(client, orgId, ri.store_id);
  const snapshot = toEffectiveClaimSettingsSnapshot(settings);

  let packageClosed: boolean | null = null;
  if (ri.package_id) {
    const { data: pkg } = await client.from("packages").select("status").eq("id", ri.package_id).maybeSingle();
    packageClosed = packageStatusIsClosed((pkg as { status?: string | null } | null)?.status ?? null);
  }

  const issue = pickPrimaryScannerIssueFromConditions(ri.conditions);
  const claimSource =
    issue?.claimSource === "warehouse_qc_issue" ? "warehouse_qc_issue" : "scanner_operator_issue";
  const eligibility = evaluateClaimEligibilitySync({
    policy: settings.policy,
    claimSource,
    eventAt: ri.created_at,
    hasScannerEvidence: returnHasScannerPhotoEvidence(ri.photo_evidence ?? {}),
    packageClosed,
    moduleDomain: "returns",
    workflow: { require_evidence: snapshot.workflow.require_evidence },
  });

  const hasNote = Boolean(String(ri.notes ?? "").trim());
  if (snapshot.workflow.require_operator_note && issue?.canonical === "operator_other" && !hasNote) {
    return evaluateClaimSubmissionReadiness({
      settings: snapshot,
      hasResolvedProduct: returnHasResolvedProduct(ri),
      hasScannerEvidence: returnHasScannerPhotoEvidence(ri.photo_evidence ?? {}),
      hasOperatorNote: false,
      eligibilityAllowed: false,
      eligibilityReason: "missing_operator_note",
      packageClosed,
    });
  }

  const evidenceUrls = getReturnPhotoEvidenceGalleryUrls(ri.photo_evidence ?? {});
  const { data: caseEvidence } = await client
    .from("claim_evidence")
    .select("public_url")
    .eq("claim_case_id", cid);
  const hasCaseEvidence = (caseEvidence ?? []).some((e) =>
    /^https?:\/\//i.test(String((e as { public_url?: string }).public_url ?? "").trim()),
  );
  const hasScannerEvidence =
    returnHasScannerPhotoEvidence(ri.photo_evidence ?? {}) || evidenceUrls.length > 0 || hasCaseEvidence;

  return evaluateClaimSubmissionReadiness({
    settings: snapshot,
    hasResolvedProduct: returnHasResolvedProduct(ri),
    hasScannerEvidence,
    hasOperatorNote: hasNote,
    eligibilityAllowed: eligibility.allowed,
    eligibilityReason: eligibility.reason,
    packageClosed,
  });
}
