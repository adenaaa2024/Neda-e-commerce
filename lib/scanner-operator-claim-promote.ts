import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getReturnPhotoEvidenceGalleryUrls,
  getReturnPhotoEvidenceUrls,
  hasReturnPhotoEvidenceUrlSlots,
  type ReturnPhotoEvidenceRow,
} from "@/lib/return-photo-evidence";
import { evaluateClaimEligibility } from "@/lib/claim-eligibility-policy";
import { resolveClaimModuleDomain } from "@/lib/claim-module-scope";
import {
  isBulkOrphanReturnItemPattern,
  isPhysicalReturnItemForClaims,
} from "@/lib/returns-claims-work-queue";
import {
  CANONICAL_SCANNER_ISSUE_TYPES,
  mapScannerIssueToDiscrepancyKind,
  pickPrimaryScannerIssueFromConditions,
  type CanonicalScannerIssueType,
  type ScannerClaimSource,
} from "@/lib/scanner-claim-issue-pick";
import { supabaseServer } from "@/lib/supabase-server";
import { evaluateScannerClaimPromoteAllowedForOrg } from "@/lib/scanner-claim-promote-guard";
import {
  getEffectiveClaimSettings,
  isAutoClaimCaseCreationAllowed,
} from "@/lib/claim-effective-settings";
import { packageStatusIsClosed } from "@/lib/returns-claims-work-queue";
import { returnHasResolvedProduct } from "@/lib/returns-claims-work-queue";
import { isUuidString } from "@/lib/uuid";

export {
  CANONICAL_SCANNER_ISSUE_TYPES,
  pickPrimaryScannerIssueFromConditions,
  mapScannerIssueToDiscrepancyKind,
  type CanonicalScannerIssueType,
  type ScannerClaimSource,
};

export type PromoteScannerClaimResult = {
  promoted: boolean;
  skipped_reason?: string;
  claim_line_id?: string;
  claim_case_id?: string;
  evidence_ids?: string[];
  created_case?: boolean;
  created_line?: boolean;
  evidence_created?: number;
};

type ReturnItemPromoteRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  package_id: string | null;
  pallet_id: string | null;
  expected_item_id: string | null;
  resolved_product_id: string | null;
  order_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  conditions: string[] | null;
  photo_evidence: ReturnPhotoEvidenceRow;
  notes: string | null;
  created_at: string | null;
  deleted_at: string | null;
};

function claimLineIdempotencyKey(organizationId: string, returnItemId: string): string {
  return `cl:return_item:${organizationId}:${returnItemId}`;
}

function claimCaseIdempotencyKey(
  organizationId: string,
  returnItemId: string,
  scannerIssueType: CanonicalScannerIssueType,
): string {
  return `cl:case:scanner:${organizationId}:${returnItemId}:${scannerIssueType}`;
}

function evidenceIdempotencyKey(returnItemId: string, publicUrl: string): string {
  return `ce:photo:${returnItemId}:${publicUrl.trim()}`;
}

function collectPhotoEvidenceUrls(pe: ReturnPhotoEvidenceRow): { url: string; label: string }[] {
  const out: { url: string; label: string }[] = [];
  const slots = getReturnPhotoEvidenceUrls(pe);
  for (const [label, url] of Object.entries(slots) as [string, string][]) {
    if (url) out.push({ url, label });
  }
  for (const url of getReturnPhotoEvidenceGalleryUrls(pe)) {
    out.push({ url, label: "gallery" });
  }
  const seen = new Set<string>();
  return out.filter(({ url }) => {
    const k = url.trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

type RoutingResolution = {
  routed_company_key: string | null;
  routed_company_display_name: string | null;
  routing_rule_id: string | null;
};

async function resolveClaimCompanyRouting(
  client: SupabaseClient,
  params: {
    organizationId: string;
    storeId: string | null;
    claimSource: ScannerClaimSource;
    scannerIssueType: CanonicalScannerIssueType | null;
  },
): Promise<RoutingResolution> {
  const base = client
    .from("claim_company_routing_rules")
    .select("id, routed_company_key, routed_company_display_name, store_id, priority")
    .eq("organization_id", params.organizationId)
    .eq("claim_source", params.claimSource)
    .eq("is_active", true)
    .order("priority", { ascending: true });

  const withIssue = params.scannerIssueType
    ? await base.eq("scanner_issue_type", params.scannerIssueType)
    : await base.is("scanner_issue_type", null);

  const rows = (withIssue.data ?? []) as {
    id: string;
    routed_company_key: string;
    routed_company_display_name: string | null;
    store_id: string | null;
    priority: number;
  }[];

  const storeMatch =
    params.storeId && isUuidString(params.storeId)
      ? rows.find((r) => r.store_id === params.storeId)
      : null;
  const orgWide = rows.find((r) => !r.store_id);
  const picked = storeMatch ?? orgWide ?? rows[0];
  if (picked) {
    return {
      routed_company_key: picked.routed_company_key,
      routed_company_display_name: picked.routed_company_display_name,
      routing_rule_id: picked.id,
    };
  }

  const { data: settings } = await client
    .from("organization_settings")
    .select("company_display_name, metadata")
    .eq("organization_id", params.organizationId)
    .maybeSingle();

  const meta = (settings?.metadata ?? {}) as Record<string, unknown>;
  const defaultKey =
    typeof meta.default_claim_company_key === "string" ? meta.default_claim_company_key.trim() : null;
  const display =
    typeof settings?.company_display_name === "string" ? settings.company_display_name.trim() : null;

  return {
    routed_company_key: defaultKey,
    routed_company_display_name: display,
    routing_rule_id: null,
  };
}

function deriveClaimLineStatus(
  canonical: CanonicalScannerIssueType,
  hasPhoto: boolean,
): { status: string; status_reason: string | null } {
  if (canonical === "operator_other") {
    return { status: "detected", status_reason: "needs_review" };
  }
  if (!hasPhoto) {
    return { status: "evidence_needed", status_reason: null };
  }
  return { status: "claim_ready", status_reason: null };
}

async function loadReturnItemForPromote(
  client: SupabaseClient,
  returnItemId: string,
  organizationId?: string | null,
): Promise<ReturnItemPromoteRow | null> {
  let q = client
    .from("return_items")
    .select(
      "id, organization_id, store_id, package_id, pallet_id, expected_item_id, resolved_product_id, order_id, sku, fnsku, asin, conditions, photo_evidence, notes, created_at, deleted_at",
    )
    .eq("id", returnItemId);
  if (organizationId && isUuidString(organizationId)) {
    q = q.eq("organization_id", organizationId);
  }
  const { data, error } = await q.maybeSingle();
  if (error || !data || data.deleted_at) return null;
  return data as ReturnItemPromoteRow;
}

/**
 * Promote one scanner return_item issue into claim_line + claim_case + claim_evidence.
 * Idempotent: safe to call on every save/reload; does not create TRID or filing rows.
 */
export async function promoteScannerReturnItemToClaimStructures(
  returnItemId: string,
  options?: {
    organizationId?: string | null;
    actorProfileId?: string | null;
    client?: SupabaseClient;
  },
): Promise<PromoteScannerClaimResult> {
  const client = options?.client ?? supabaseServer;

  const rid = String(returnItemId ?? "").trim();
  if (!isUuidString(rid)) {
    return { promoted: false, skipped_reason: "invalid_return_item_id" };
  }

  const row = await loadReturnItemForPromote(client, rid, options?.organizationId);
  if (!row) {
    return { promoted: false, skipped_reason: "return_item_not_found" };
  }

  const guard = await evaluateScannerClaimPromoteAllowedForOrg(
    client,
    row.organization_id,
    row.store_id,
  );
  if (!guard.allowed) {
    return { promoted: false, skipped_reason: guard.skipped_reason ?? "promote_disabled" };
  }

  const effectiveSettings = await getEffectiveClaimSettings(
    client,
    row.organization_id,
    row.store_id,
  );

  if (!isPhysicalReturnItemForClaims(row)) {
    return {
      promoted: false,
      skipped_reason: isBulkOrphanReturnItemPattern(row)
        ? "bulk_orphan_excluded"
        : "not_physical_scan",
    };
  }

  const issue = pickPrimaryScannerIssueFromConditions(row.conditions);
  if (!issue) {
    return { promoted: false, skipped_reason: "not_claimable" };
  }

  const wf = effectiveSettings.workflow;
  if (
    wf.require_product_link !== false &&
    !returnHasResolvedProduct(row) &&
    !effectiveSettings.policy.allow_manual_override
  ) {
    return { promoted: false, skipped_reason: "needs_product_resolution" };
  }

  const { canonical, claimSource, tag: sourceTag } = issue;
  if (
    wf.require_operator_note !== false &&
    canonical === "operator_other" &&
    !String(row.notes ?? "").trim()
  ) {
    return { promoted: false, skipped_reason: "missing_operator_note" };
  }
  const hasPhoto = hasReturnPhotoEvidenceUrlSlots(row.photo_evidence);

  const eligibilityClaimSource =
    claimSource === "warehouse_qc_issue" ? "warehouse_qc_issue" : "scanner_operator_issue";
  const eligibility = await evaluateClaimEligibility({
    client,
    organizationId: row.organization_id,
    storeId: row.store_id,
    claimSource: eligibilityClaimSource,
    eventAt: row.created_at,
    hasScannerEvidence: hasPhoto,
    packageId: row.package_id,
    palletId: row.pallet_id,
    moduleDomain: resolveClaimModuleDomain(eligibilityClaimSource, null),
  });
  if (!eligibility.allowed) {
    return { promoted: false, skipped_reason: eligibility.reason };
  }
  const lineStatus = deriveClaimLineStatus(canonical, hasPhoto);
  const discrepancyKind = mapScannerIssueToDiscrepancyKind(canonical);
  const routing = await resolveClaimCompanyRouting(client, {
    organizationId: row.organization_id,
    storeId: row.store_id,
    claimSource,
    scannerIssueType: claimSource === "scanner_operator_issue" ? canonical : null,
  });

  const lineKey = claimLineIdempotencyKey(row.organization_id, rid);
  const caseKey = claimCaseIdempotencyKey(row.organization_id, rid, canonical);

  const { data: existingLine } = await client
    .from("claim_lines")
    .select("id, claim_case_id, scanner_issue_type, status")
    .eq("idempotency_key", lineKey)
    .maybeSingle();

  let claimCaseId = existingLine?.claim_case_id ?? null;
  let createdCase = false;

  const { data: existingCase } = await client
    .from("claim_cases")
    .select("id, status, scanner_issue_type")
    .eq("idempotency_key", caseKey)
    .maybeSingle();

  let packageClosed: boolean | null = null;
  if (row.package_id) {
    const { data: pkg } = await client
      .from("packages")
      .select("status")
      .eq("id", row.package_id)
      .maybeSingle();
    packageClosed = packageStatusIsClosed((pkg as { status?: string } | null)?.status);
  }

  const autoCase = isAutoClaimCaseCreationAllowed(effectiveSettings, { packageClosed });

  if (existingCase?.id) {
    claimCaseId = existingCase.id;
    await client
      .from("claim_cases")
      .update({
        scanner_issue_type: canonical,
        claim_source: claimSource,
        store_id: row.store_id,
        primary_return_item_id: rid,
        primary_package_id: row.package_id,
        primary_resolved_product_id: row.resolved_product_id,
        primary_order_id: row.order_id,
        primary_sku: row.sku,
        routed_company_key: routing.routed_company_key,
        routed_company_display_name: routing.routed_company_display_name,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingCase.id);
  } else if (autoCase.allowed) {
    const { data: insertedCase, error: caseErr } = await client
      .from("claim_cases")
      .insert({
        organization_id: row.organization_id,
        store_id: row.store_id,
        claim_source: claimSource,
        scanner_issue_type: canonical,
        status: "open",
        priority: canonical === "counterfeit_suspect" ? "high" : "normal",
        primary_return_item_id: rid,
        primary_package_id: row.package_id,
        primary_resolved_product_id: row.resolved_product_id,
        primary_order_id: row.order_id,
        primary_sku: row.sku,
        routed_company_key: routing.routed_company_key,
        routed_company_display_name: routing.routed_company_display_name,
        opened_by: options?.actorProfileId ?? null,
        idempotency_key: caseKey,
        metadata: {
          promote_source: "scanner_operator_save",
          source_condition_tag: sourceTag,
          routing_rule_id: routing.routing_rule_id,
        },
      })
      .select("id")
      .single();

    if (caseErr || !insertedCase?.id) {
      return {
        promoted: false,
        skipped_reason: `claim_case_insert_failed:${caseErr?.message ?? "unknown"}`,
      };
    }
    claimCaseId = insertedCase.id;
    createdCase = true;

    await client.from("claim_case_events").insert({
      organization_id: row.organization_id,
      claim_case_id: claimCaseId,
      event_type: "case_opened",
      to_status: "open",
      actor_id: options?.actorProfileId ?? null,
      payload: {
        scanner_issue_type: canonical,
        return_item_id: rid,
        source_condition_tag: sourceTag,
      },
    });
  }

  let claimLineId = existingLine?.id ?? null;
  let createdLine = false;
  const linePatch = {
    organization_id: row.organization_id,
    store_id: row.store_id,
    return_item_id: rid,
    expected_package_id: row.expected_item_id,
    resolved_product_id: row.resolved_product_id,
    package_id: row.package_id,
    pallet_id: row.pallet_id,
    order_id: row.order_id,
    sku: row.sku,
    fnsku: row.fnsku,
    asin: row.asin,
    line_grain: "return_item",
    discrepancy_kind: discrepancyKind,
    quantity_basis: "units",
    count_basis: "scan_count",
    scanner_issue_type: canonical,
    claim_case_id: claimCaseId,
    status: lineStatus.status,
    status_reason: lineStatus.status_reason,
    updated_at: new Date().toISOString(),
    metadata: {
      promote_source: "scanner_operator_save",
      source_condition_tag: sourceTag,
    },
  };

  if (claimLineId) {
    const statusChanged = existingLine?.status !== lineStatus.status;
    await client.from("claim_lines").update(linePatch).eq("id", claimLineId);
    if (statusChanged && claimCaseId) {
      await client.from("claim_case_events").insert({
        organization_id: row.organization_id,
        claim_case_id: claimCaseId,
        event_type: "status_changed",
        from_status: existingLine?.status ?? null,
        to_status: lineStatus.status,
        actor_id: options?.actorProfileId ?? null,
        payload: { claim_line_id: claimLineId, reason: "scanner_promote" },
      });
    }
  } else {
    const { data: insertedLine, error: lineErr } = await client
      .from("claim_lines")
      .insert({
        ...linePatch,
        idempotency_key: lineKey,
      })
      .select("id")
      .single();

    if (lineErr || !insertedLine?.id) {
      return {
        promoted: false,
        skipped_reason: `claim_line_insert_failed:${lineErr?.message ?? "unknown"}`,
        claim_case_id: claimCaseId ?? undefined,
      };
    }
    claimLineId = insertedLine.id;
    createdLine = true;
  }

  if (claimCaseId && claimLineId) {
    await client
      .from("claim_cases")
      .update({ primary_claim_line_id: claimLineId, updated_at: new Date().toISOString() })
      .eq("id", claimCaseId);
  }

  const photoUrls = collectPhotoEvidenceUrls(row.photo_evidence);
  const evidenceIds: string[] = [];
  let evidenceCreated = 0;

  for (const { url, label } of photoUrls) {
    const idem = evidenceIdempotencyKey(rid, url);
    const { data: existingEv } = await client
      .from("claim_evidence")
      .select("id")
      .eq("return_item_id", rid)
      .eq("public_url", url)
      .maybeSingle();

    if (existingEv?.id) {
      evidenceIds.push(existingEv.id);
      await client
        .from("claim_evidence")
        .update({
          claim_case_id: claimCaseId,
          claim_line_id: claimLineId,
          scanner_issue_type: canonical,
          metadata: { idempotency_key: idem, photo_label: label },
        })
        .eq("id", existingEv.id);
      continue;
    }

    const { data: newEv, error: evErr } = await client
      .from("claim_evidence")
      .insert({
        organization_id: row.organization_id,
        claim_case_id: claimCaseId,
        claim_line_id: claimLineId,
        return_item_id: rid,
        package_id: row.package_id,
        product_id: row.resolved_product_id,
        evidence_kind: "photo",
        capture_source: "scanner",
        scanner_issue_type: canonical,
        public_url: url,
        captured_by: options?.actorProfileId ?? null,
        metadata: { idempotency_key: idem, photo_label: label },
      })
      .select("id")
      .single();

    if (!evErr && newEv?.id) {
      evidenceIds.push(newEv.id);
      evidenceCreated += 1;
      if (claimCaseId) {
        await client.from("claim_case_events").insert({
          organization_id: row.organization_id,
          claim_case_id: claimCaseId,
          event_type: "evidence_added",
          actor_id: options?.actorProfileId ?? null,
          payload: { claim_evidence_id: newEv.id, public_url: url, photo_label: label },
        });
      }
    }
  }

  if (row.notes?.trim() && claimCaseId && claimLineId) {
    const noteIdem = `ce:note:${rid}`;
    const { data: existingNote } = await client
      .from("claim_evidence")
      .select("id")
      .eq("return_item_id", rid)
      .eq("evidence_kind", "operator_note")
      .filter("metadata->>idempotency_key", "eq", noteIdem)
      .maybeSingle();

    if (!existingNote?.id) {
      await client.from("claim_evidence").insert({
        organization_id: row.organization_id,
        claim_case_id: claimCaseId,
        claim_line_id: claimLineId,
        return_item_id: rid,
        evidence_kind: "operator_note",
        capture_source: "operator",
        scanner_issue_type: canonical,
        operator_note: row.notes.trim(),
        captured_by: options?.actorProfileId ?? null,
        metadata: { idempotency_key: noteIdem },
      });
    }
  }

  return {
    promoted: true,
    claim_line_id: claimLineId ?? undefined,
    claim_case_id: claimCaseId ?? undefined,
    evidence_ids: evidenceIds,
    created_case: createdCase,
    created_line: createdLine,
    evidence_created: evidenceCreated,
  };
}
