"use server";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadClaimPolicy } from "../../lib/claim-eligibility-policy";
import { isClaimModuleDomainEnabled } from "../../lib/claim-module-scope";
import { hasReturnPhotoEvidenceUrlSlots } from "../../lib/return-photo-evidence";
import { buildReturnsClaimQueueRow, packageStatusIsClosed } from "../../lib/returns-claims-work-queue";
import {
  claimLineIdempotencyKeyForReturnItem,
  evaluateManualDraftPolicyGate,
  filterAmazonReturnsReferenceLines,
  isBlockedGrainForManualDraftCreation,
  manualClaimCaseIdempotencyKey,
  manualClaimLinePatchFromReturnItem,
  validateManualGroupingSelection,
  type AmazonReturnsReferenceLine,
  type ManualGroupingDimension,
  type ManualGroupingReturnItemInput,
} from "../../lib/returns-manual-claim-grouping";
import { pickPrimaryScannerIssueFromConditions } from "../../lib/scanner-claim-issue-pick";
import { resolveTenantListScope, type TenantQueryOpts } from "../../lib/server-tenant";
import { supabaseServer } from "../../lib/supabase-server";
import { isUuidString } from "../../lib/uuid";
import { RETURN_ITEMS_TABLE, RETURN_LIST_SELECT } from "./returns-constants";

export type CreateManualReturnsClaimDraftResult = {
  ok: boolean;
  error?: string;
  claim_case_id?: string;
  claim_line_ids?: string[];
  created_case?: boolean;
  attached_line_count?: number;
  idempotency_key?: string;
};

export type ListAmazonReturnsReferenceResult = {
  ok: boolean;
  error?: string;
  lines: AmazonReturnsReferenceLine[];
  note: string;
};

type ReturnItemDbRow = ManualGroupingReturnItemInput & {
  fnsku?: string | null;
  asin?: string | null;
  deleted_at: string | null;
};

async function resolveRouting(
  client: SupabaseClient,
  organizationId: string,
  storeId: string | null,
  claimSource: string,
  scannerIssueType: string | null,
): Promise<{
  routed_company_key: string | null;
  routed_company_display_name: string | null;
}> {
  let q = client
    .from("claim_company_routing_rules")
    .select("routed_company_key, routed_company_display_name, store_id, priority")
    .eq("organization_id", organizationId)
    .eq("claim_source", claimSource)
    .eq("is_active", true)
    .order("priority", { ascending: true });
  q = scannerIssueType ? q.eq("scanner_issue_type", scannerIssueType) : q.is("scanner_issue_type", null);
  const { data: rows } = await q;
  const list = (rows ?? []) as {
    routed_company_key: string;
    routed_company_display_name: string | null;
    store_id: string | null;
  }[];
  const storeMatch = storeId ? list.find((r) => r.store_id === storeId) : null;
  const picked = storeMatch ?? list.find((r) => !r.store_id) ?? list[0];
  if (picked) {
    return {
      routed_company_key: picked.routed_company_key,
      routed_company_display_name: picked.routed_company_display_name,
    };
  }
  const { data: settings } = await client
    .from("organization_settings")
    .select("company_display_name, metadata")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const meta = (settings?.metadata ?? {}) as Record<string, unknown>;
  const defaultKey =
    typeof meta.default_claim_company_key === "string" ? meta.default_claim_company_key.trim() : null;
  const display =
    typeof settings?.company_display_name === "string" ? settings.company_display_name.trim() : null;
  return { routed_company_key: defaultKey, routed_company_display_name: display };
}

async function loadReturnItemsForManualGrouping(
  returnItemIds: string[],
  organizationId: string,
): Promise<ReturnItemDbRow[]> {
  const ids = returnItemIds.filter((id) => isUuidString(id));
  if (!ids.length) return [];
  const { data, error } = await supabaseServer
    .from(RETURN_ITEMS_TABLE)
    .select(RETURN_LIST_SELECT)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .in("id", ids);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => {
    const row = r as unknown as Record<string, unknown>;
    return {
      return_item_id: String(row.id),
      organization_id: String(row.organization_id),
      store_id: (row.store_id as string | null) ?? null,
      package_id: (row.package_id as string | null) ?? null,
      pallet_id: (row.pallet_id as string | null) ?? null,
      expected_item_id: (row.expected_item_id as string | null) ?? null,
      conditions: (row.conditions as string[] | null) ?? null,
      photo_evidence: row.photo_evidence as ReturnItemDbRow["photo_evidence"],
      resolved_product_id: (row.resolved_product_id as string | null) ?? null,
      resolved_catalog_product_id: (row.resolved_catalog_product_id as string | null) ?? null,
      order_id: (row.order_id as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      sku: (row.sku as string | null) ?? null,
      fnsku: (row.fnsku as string | null) ?? null,
      asin: (row.asin as string | null) ?? null,
      created_at: (row.created_at as string | null) ?? null,
      deleted_at: (row.deleted_at as string | null) ?? null,
    };
  });
}

/**
 * Create or attach a Phase-1 manual draft claim case from live physical return_items only.
 * Does not call scanner auto-promote or bulk backfill execute.
 */
export async function createManualReturnsClaimDraft(
  returnItemIds: string[],
  opts?: {
    grouping_dimension?: ManualGroupingDimension;
    actorProfileId?: string | null;
    tenant?: TenantQueryOpts;
  },
): Promise<CreateManualReturnsClaimDraftResult> {
  try {
    const scope = await resolveTenantListScope(opts?.tenant);
    if (scope.mode !== "single") {
      return { ok: false, error: "Select a single organization to create a manual claim draft." };
    }
    const orgId = scope.organizationId;
    const ids = [...new Set(returnItemIds.map((id) => id.trim()).filter((id) => isUuidString(id)))];
    if (!ids.length) return { ok: false, error: "No valid return item IDs." };

    const policy = await loadClaimPolicy(supabaseServer, orgId);
    if (!isClaimModuleDomainEnabled(policy, "returns")) {
      return { ok: false, error: "Returns claim module is disabled for this organization." };
    }

    const dbRows = await loadReturnItemsForManualGrouping(ids, orgId);
    if (dbRows.length !== ids.length) {
      return { ok: false, error: "One or more return items were not found or are not active." };
    }

    const inputs: ManualGroupingReturnItemInput[] = dbRows.map((r) => ({
      ...r,
      return_item_id: r.return_item_id,
    }));

    const packageIds = [...new Set(inputs.map((r) => r.package_id).filter((id): id is string => !!id))];
    const packageClosedById = new Map<string, boolean | null>();
    if (packageIds.length) {
      const { data: packages } = await supabaseServer
        .from("packages")
        .select("id, status")
        .in("id", packageIds);
      for (const p of packages ?? []) {
        const row = p as { id: string; status: string | null };
        packageClosedById.set(row.id, packageStatusIsClosed(row.status));
      }
    }

    const packageClosedByReturnItemId: Record<string, boolean | null> = {};
    for (const row of inputs) {
      packageClosedByReturnItemId[row.return_item_id] = row.package_id
        ? (packageClosedById.get(row.package_id) ?? null)
        : null;
    }

    const validation = validateManualGroupingSelection(inputs, policy, {
      packageClosedByReturnItemId,
    });
    if (!validation.ok) {
      return { ok: false, error: validation.errors[0] ?? "Selection failed policy validation." };
    }

    const primaryGate = evaluateManualDraftPolicyGate(inputs[0]!, policy, {
      packageClosedByReturnItemId,
    });
    if (!primaryGate.allowed) {
      return { ok: false, error: `Policy gate failed: ${primaryGate.reason}` };
    }

    const primary = inputs[0]!;
    const primaryIssue = pickPrimaryScannerIssueFromConditions(primary.conditions)!;
    const caseKey = manualClaimCaseIdempotencyKey(orgId, ids, primaryIssue.canonical);
    const routing = await resolveRouting(
      supabaseServer,
      orgId,
      primary.store_id ?? null,
      primaryIssue.claimSource,
      primaryIssue.claimSource === "scanner_operator_issue" ? primaryIssue.canonical : null,
    );

    const { data: existingCase } = await supabaseServer
      .from("claim_cases")
      .select("id")
      .eq("idempotency_key", caseKey)
      .maybeSingle();

    let claimCaseId = existingCase?.id as string | undefined;
    let createdCase = false;

    if (!claimCaseId) {
      const { data: insertedCase, error: caseErr } = await supabaseServer
        .from("claim_cases")
        .insert({
          organization_id: orgId,
          store_id: primary.store_id,
          claim_source: primaryIssue.claimSource,
          scanner_issue_type: primaryIssue.canonical,
          status: "open",
          priority: primaryIssue.canonical === "counterfeit_suspect" ? "high" : "normal",
          primary_return_item_id: primary.return_item_id,
          primary_package_id: primary.package_id,
          primary_resolved_product_id: primary.resolved_product_id,
          primary_order_id: primary.order_id,
          primary_sku: primary.sku,
          routed_company_key: routing.routed_company_key,
          routed_company_display_name: routing.routed_company_display_name,
          opened_by: opts?.actorProfileId ?? null,
          idempotency_key: caseKey,
          metadata: {
            phase1_manual_draft: true,
            policy_gate: "returns_manual_draft_v1",
            policy_gate_passed_at: new Date().toISOString(),
            eligibility_reason: primaryGate.reason,
            grouping_dimension: opts?.grouping_dimension ?? "issue",
            grouped_return_item_ids: ids,
            returns_first_only: true,
            no_auto_promote: true,
            no_marketplace_submit: true,
          },
        })
        .select("id")
        .single();

      if (caseErr || !insertedCase?.id) {
        return { ok: false, error: caseErr?.message ?? "Failed to create claim case." };
      }
      claimCaseId = insertedCase.id;
      createdCase = true;

      await supabaseServer.from("claim_case_events").insert({
        organization_id: orgId,
        claim_case_id: claimCaseId,
        event_type: "case_opened",
        to_status: "open",
        actor_id: opts?.actorProfileId ?? null,
        payload: {
          source: "returns_manual_grouping_phase1",
          return_item_ids: ids,
          grouping_dimension: opts?.grouping_dimension ?? "issue",
        },
      });
    }

    const claimLineIds: string[] = [];
    let primaryLineId: string | null = null;

    for (const row of inputs) {
      const issue = pickPrimaryScannerIssueFromConditions(row.conditions)!;
      const lineKey = claimLineIdempotencyKeyForReturnItem(orgId, row.return_item_id);
      const linePatch = manualClaimLinePatchFromReturnItem(row, claimCaseId!, issue.canonical, issue.tag);

      const { data: existingLine } = await supabaseServer
        .from("claim_lines")
        .select("id, line_grain, claim_case_id")
        .eq("idempotency_key", lineKey)
        .maybeSingle();

      if (existingLine?.id) {
        const grain = String((existingLine as { line_grain: string }).line_grain ?? "");
        const sourceTable = String((existingLine as { source_table?: string }).source_table ?? "");
        if (isBlockedGrainForManualDraftCreation(grain, sourceTable)) {
          return {
            ok: false,
            error: `Existing claim line for ${row.return_item_id} uses blocked grain ${grain} (not returns-first).`,
          };
        }
        await supabaseServer.from("claim_lines").update(linePatch).eq("id", existingLine.id);
        claimLineIds.push(existingLine.id);
        if (!primaryLineId) primaryLineId = existingLine.id;
        continue;
      }

      const { data: insertedLine, error: lineErr } = await supabaseServer
        .from("claim_lines")
        .insert({
          ...linePatch,
          idempotency_key: lineKey,
        })
        .select("id")
        .single();

      if (lineErr || !insertedLine?.id) {
        return { ok: false, error: lineErr?.message ?? `Failed to create claim line for ${row.return_item_id}.` };
      }
      claimLineIds.push(insertedLine.id);
      if (!primaryLineId) primaryLineId = insertedLine.id;
    }

    if (primaryLineId) {
      await supabaseServer
        .from("claim_cases")
        .update({
          primary_claim_line_id: primaryLineId,
          primary_return_item_id: primary.return_item_id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", claimCaseId);
    }

    return {
      ok: true,
      claim_case_id: claimCaseId,
      claim_line_ids: claimLineIds,
      created_case: createdCase,
      attached_line_count: claimLineIds.length,
      idempotency_key: caseKey,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to create manual claim draft.",
    };
  }
}

/** Read-only amazon_returns import_source lines for TRID/inbox context (never grouped into cases). */
export async function listAmazonReturnsImportReferences(
  opts: { order_ids: string[]; skus: string[]; tenant?: TenantQueryOpts },
): Promise<ListAmazonReturnsReferenceResult> {
  const note =
    "Read-only detection lines (import_source / amazon_returns). Not used for returns-first manual grouping.";
  try {
    const scope = await resolveTenantListScope(opts.tenant);
    if (scope.mode !== "single") {
      return { ok: true, lines: [], note };
    }
    const orderIds = [...new Set(opts.order_ids.map((o) => o.trim()).filter(Boolean))];
    const skus = [...new Set(opts.skus.map((s) => s.trim()).filter(Boolean))];
    if (!orderIds.length && !skus.length) {
      return { ok: true, lines: [], note };
    }

    let q = supabaseServer
      .from("claim_lines")
      .select("id, line_grain, source_table, source_row_id, order_id, sku, status")
      .eq("organization_id", scope.organizationId)
      .eq("line_grain", "import_source")
      .eq("source_table", "amazon_returns")
      .limit(50);

    if (orderIds.length) {
      q = q.in("order_id", orderIds.slice(0, 20));
    }

    const { data, error } = await q;
    if (error) {
      const msg = error.message.toLowerCase();
      if (msg.includes("claim_lines")) return { ok: true, lines: [], note };
      throw new Error(error.message);
    }

    const lines = filterAmazonReturnsReferenceLines(
      (data ?? []) as Parameters<typeof filterAmazonReturnsReferenceLines>[0],
      { order_ids: orderIds, skus },
      15,
    );

    return { ok: true, lines, note };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to load reference lines.",
      lines: [],
      note,
    };
  }
}

/** Re-export queue row builder helper for tests — validates policy + physical gate on server rows. */
export async function evaluateReturnItemForManualDraftFromDb(
  returnItemId: string,
  organizationId: string,
): Promise<{ ok: boolean; queue_state?: string; error?: string }> {
  const rows = await loadReturnItemsForManualGrouping([returnItemId], organizationId);
  if (!rows.length) return { ok: false, error: "not_found" };
  const r = rows[0]!;
  const policy = await loadClaimPolicy(supabaseServer, organizationId);
  let packageClosed: boolean | null = null;
  if (r.package_id) {
    const { data: pkg } = await supabaseServer.from("packages").select("status").eq("id", r.package_id).maybeSingle();
    packageClosed = packageStatusIsClosed((pkg as { status?: string } | null)?.status);
  }
  const queueRow = buildReturnsClaimQueueRow(
    {
      return_item_id: r.return_item_id,
      organization_id: r.organization_id,
      store_id: r.store_id ?? null,
      package_id: r.package_id ?? null,
      pallet_id: r.pallet_id ?? null,
      expected_item_id: r.expected_item_id ?? null,
      created_at: r.created_at ?? null,
      conditions: r.conditions ?? null,
      photo_evidence: r.photo_evidence ?? {},
      notes: null,
      resolved_product_id: r.resolved_product_id ?? null,
      resolved_catalog_product_id: r.resolved_catalog_product_id ?? null,
      identifier_resolution_status: null,
      order_id: r.order_id ?? null,
      sku: r.sku ?? null,
      fnsku: r.fnsku ?? null,
      asin: r.asin ?? null,
      item_name: null,
      lpn: null,
      status: null,
      claim_line: null,
    },
    policy,
    packageClosed,
  );
  const hasPhoto = hasReturnPhotoEvidenceUrlSlots(queueRow.photo_evidence);
  if (queueRow.queue_state === "eligible") return { ok: true, queue_state: queueRow.queue_state };
  if (queueRow.queue_state === "missing_evidence" && (queueRow.has_scanner_evidence || hasPhoto)) {
    return { ok: true, queue_state: queueRow.queue_state };
  }
  return { ok: false, queue_state: queueRow.queue_state, error: queueRow.queue_state };
}
