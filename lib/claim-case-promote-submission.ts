import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getClaimDetail } from "@/app/claim-engine/claim-actions";
import {
  buildClaimEvidenceSlots,
  mergeDefaultClaimEvidence,
  type ClaimEvidenceKey,
} from "@/app/claim-engine/claim-evidence-settings";
import { renderSingleClaimPdfBuffer, resolveCoreSettingsForPdf } from "@/app/claim-engine/claim-pdf-server";
import { CLAIM_SUBMISSIONS_TABLE } from "@/app/claim-engine/claim-submissions-constants";
import { getCoreSettings } from "@/app/settings/workspace-settings-actions";
import {
  buildClaimSubmissionSourcePayloadForReturn,
  upsertClaimSubmissionForReturnItem,
} from "@/app/returns/actions";
import { getEffectiveClaimSettings } from "@/lib/claim-effective-settings";
import { getReturnPhotoEvidenceGalleryUrls, type ReturnPhotoEvidenceRow } from "@/lib/return-photo-evidence";
import { isPhysicalReturnItemForClaims } from "@/lib/returns-claims-work-queue";
import { pickPrimaryScannerIssueFromConditions } from "@/lib/scanner-claim-issue-pick";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

const PDF_BUCKET = "claim-reports";

export type PromoteClaimCaseToSubmissionResult = {
  ok: boolean;
  claim_case_id?: string;
  claim_submission_id?: string;
  report_url?: string | null;
  created_submission?: boolean;
  pdf_generated?: boolean;
  error?: string;
  skipped_reason?: string;
};

function collectHttpUrls(...groups: (readonly (string | null | undefined)[] | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of groups) {
    if (!g) continue;
    for (const raw of g) {
      const u = String(raw ?? "").trim();
      if (!u || !/^https?:\/\//i.test(u) || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

async function loadCaseBundle(
  client: SupabaseClient,
  claimCaseId: string,
  organizationId: string,
) {
  const { data: claimCase, error: caseErr } = await client
    .from("claim_cases")
    .select(
      "id, organization_id, store_id, status, scanner_issue_type, claim_source, primary_return_item_id, primary_package_id, metadata",
    )
    .eq("id", claimCaseId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (caseErr) throw new Error(caseErr.message);
  if (!claimCase) return null;

  const returnItemId = String(claimCase.primary_return_item_id ?? "").trim();
  if (!returnItemId || !isUuidString(returnItemId)) {
    return { claimCase, returnItem: null, lines: [], evidence: [] };
  }

  const { data: returnItem, error: riErr } = await client
    .from("return_items")
    .select(
      "id, organization_id, store_id, package_id, pallet_id, expected_item_id, conditions, photo_evidence, notes, order_id, resolved_product_id, estimated_value, created_at, deleted_at",
    )
    .eq("id", returnItemId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (riErr) throw new Error(riErr.message);

  const { data: lines } = await client
    .from("claim_lines")
    .select("id, line_grain, return_item_id, claim_case_id")
    .eq("claim_case_id", claimCaseId)
    .eq("line_grain", "return_item");

  const { data: evidence } = await client
    .from("claim_evidence")
    .select("id, public_url, evidence_kind")
    .eq("claim_case_id", claimCaseId);

  return {
    claimCase,
    returnItem: returnItem ?? null,
    lines: lines ?? [],
    evidence: evidence ?? [],
  };
}

async function uploadSubmissionPdf(
  client: SupabaseClient,
  organizationId: string,
  submissionId: string,
  buffer: Buffer,
  actorProfileId?: string | null,
): Promise<string> {
  const path = `${organizationId}/${submissionId}/claim-export-${Date.now()}.pdf`;
  const { error: upErr } = await client.storage.from(PDF_BUCKET).upload(path, buffer, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (upErr) throw new Error(upErr.message);

  const { error: dbErr } = await client
    .from(CLAIM_SUBMISSIONS_TABLE)
    .update({
      report_url: path,
      updated_at: new Date().toISOString(),
      ...(actorProfileId && isUuidString(actorProfileId) ? { created_by: actorProfileId } : {}),
    })
    .eq("id", submissionId)
    .eq("organization_id", organizationId);
  if (dbErr) throw new Error(dbErr.message);
  return path;
}

/**
 * Bridge claim_cases + return_item lines → claim_submissions (+ optional PDF).
 * Idempotent: one submission per primary_return_item_id; metadata stores back-link.
 */
export async function promoteClaimCaseToSubmissionPackage(
  claimCaseId: string,
  options: {
    organizationId: string;
    actorProfileId?: string | null;
    generatePdf?: boolean;
    client?: SupabaseClient;
  },
): Promise<PromoteClaimCaseToSubmissionResult> {
  const cid = String(claimCaseId ?? "").trim();
  const orgId = String(options.organizationId ?? "").trim();
  if (!isUuidString(cid)) return { ok: false, skipped_reason: "invalid_claim_case_id" };
  if (!isUuidString(orgId)) return { ok: false, skipped_reason: "invalid_organization_id" };

  const client = options.client ?? supabaseServer;

  try {
    const bundle = await loadCaseBundle(client, cid, orgId);
    if (!bundle) return { ok: false, skipped_reason: "claim_case_not_found" };

    const { claimCase, returnItem, lines } = bundle;
    if (!returnItem) {
      return { ok: false, skipped_reason: "missing_primary_return_item" };
    }

    const ri = returnItem as {
      id: string;
      package_id: string | null;
      pallet_id: string | null;
      expected_item_id: string | null;
      conditions: string[] | null;
      photo_evidence: ReturnPhotoEvidenceRow;
      notes: string | null;
      order_id: string | null;
      store_id: string | null;
      resolved_product_id: string | null;
      estimated_value: unknown;
    };

    if (!isPhysicalReturnItemForClaims(ri)) {
      return { ok: false, skipped_reason: "not_physical_scan" };
    }

    const issue = pickPrimaryScannerIssueFromConditions(ri.conditions);
    if (!issue) return { ok: false, skipped_reason: "not_claimable" };

    if (issue.canonical === "operator_other" && !String(ri.notes ?? "").trim()) {
      return { ok: false, skipped_reason: "missing_operator_note" };
    }

    if (!String(ri.resolved_product_id ?? "").trim()) {
      return { ok: false, skipped_reason: "needs_product_resolution" };
    }

    const returnItemLines = (lines as { line_grain: string }[]).filter(
      (l) => l.line_grain === "return_item",
    );
    if (!returnItemLines.length) {
      return { ok: false, skipped_reason: "no_return_item_claim_lines" };
    }

    const evidenceUrls = collectHttpUrls(
      (bundle.evidence as { public_url?: string | null }[]).map((e) => e.public_url),
      getReturnPhotoEvidenceGalleryUrls(ri.photo_evidence ?? {}),
    );

    const sourcePayload = await buildClaimSubmissionSourcePayloadForReturn(
      ri.conditions ?? [],
      ri.order_id ?? null,
      ri.package_id ?? null,
      { operatorNotes: ri.notes ?? null },
      { selectedEvidenceUrls: evidenceUrls.length ? evidenceUrls : null },
    );

    const ev = Number(ri.estimated_value);
    const claimAmount = Number.isFinite(ev) && ev > 0 ? ev : 100;

    const upsert = await upsertClaimSubmissionForReturnItem({
      organizationId: orgId,
      returnId: ri.id,
      storeId: ri.store_id ?? (claimCase.store_id as string | null),
      claimAmount,
      sourcePayload,
      returnHint: { store_id: ri.store_id, package_id: ri.package_id },
      status: "ready_to_send",
    });

    if (!upsert.ok || !upsert.submissionId) {
      return { ok: false, error: upsert.error ?? "submission_upsert_failed" };
    }

    const meta = (claimCase.metadata as Record<string, unknown> | null) ?? {};
    const mergedMeta = {
      ...meta,
      claim_submission_id: upsert.submissionId,
      submission_linked_at: new Date().toISOString(),
      promote_source: "claim_case_to_submission",
    };

    const { error: metaErr } = await client
      .from("claim_cases")
      .update({
        metadata: mergedMeta,
        updated_at: new Date().toISOString(),
      })
      .eq("id", cid)
      .eq("organization_id", orgId);
    if (metaErr) return { ok: false, error: metaErr.message };

    await client.from("claim_case_events").insert({
      organization_id: orgId,
      claim_case_id: cid,
      event_type: "submission_linked",
      actor_id: options.actorProfileId ?? null,
      payload: {
        claim_submission_id: upsert.submissionId,
        return_item_id: ri.id,
        created_submission: upsert.created ?? false,
      },
    });

    let reportUrl: string | null = null;
    let pdfGenerated = false;

    const effectiveSettings = await getEffectiveClaimSettings(client, orgId, ri.store_id);
    const shouldPdf = options.generatePdf ?? effectiveSettings.auto_generate_pdf_reports;

    if (shouldPdf) {
      try {
        const detailRes = await getClaimDetail(upsert.submissionId, orgId);
        if (detailRes.ok && detailRes.data) {
          const core = resolveCoreSettingsForPdf(await getCoreSettings());
          const st = detailRes.data.returnRow?.stores;
          const storeName = st?.name?.trim() || "Store";
          const storePlatform = st?.platform?.trim() || "amazon";
          const buffer = await renderSingleClaimPdfBuffer({
            tenant: core,
            storeName,
            storePlatform,
            detail: detailRes.data,
            claimAmountNote: String(detailRes.data.claim.amount ?? claimAmount),
          });
          reportUrl = await uploadSubmissionPdf(
            client,
            orgId,
            upsert.submissionId,
            buffer,
            options.actorProfileId,
          );
          pdfGenerated = true;
        }
      } catch (pdfErr) {
        console.warn("[promoteClaimCaseToSubmissionPackage] PDF skipped:", pdfErr);
      }
    }

    return {
      ok: true,
      claim_case_id: cid,
      claim_submission_id: upsert.submissionId,
      report_url: reportUrl,
      created_submission: upsert.created,
      pdf_generated: pdfGenerated,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "promote_failed",
    };
  }
}
