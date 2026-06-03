"use server";

import { loadClaimPolicy, normalizeClaimPolicy } from "../../lib/claim-eligibility-policy";
import {
  getEffectiveClaimSettings,
  toEffectiveClaimSettingsSnapshot,
} from "../../lib/claim-effective-settings";
import type { EffectiveClaimSettingsSnapshot } from "../../lib/claim-effective-settings-shared";
import { resolveClaimQueueDisplayReason } from "../../lib/claim-queue-display";
import type { ClaimPolicyV1 } from "../../lib/claim-policy-types";
import { isClaimModuleDomainEnabled } from "../../lib/claim-module-scope";
import {
  buildReturnsClaimQueueRow,
  filterClaimLinesForReturnsQueue,
  isBulkOrphanReturnItemPattern,
  isPhysicalReturnItemForClaims,
  packageStatusIsClosed,
  returnItemHasScannerClaimIssue,
  type ReturnsClaimQueueRow,
  type ReturnsClaimQueueSourceRow,
} from "../../lib/returns-claims-work-queue";
import type { ReturnPhotoEvidenceRow } from "../../lib/return-photo-evidence";
import {
  CLAIM_FLOW_STAGE_LABELS,
  deriveClaimFlowStage,
  type ClaimFlowStage,
} from "../../lib/claim-flow-status-badges";
import { resolveTenantListScope, type TenantQueryOpts } from "../../lib/server-tenant";
import { supabaseServer } from "../../lib/supabase-server";
import { isUuidString } from "../../lib/uuid";
import { RETURN_ITEMS_TABLE, RETURN_LIST_SELECT } from "./returns-constants";

const QUEUE_SCAN_LIMIT = 500;

async function enrichQueueRowsWithClaimFlow(
  rows: ReturnsClaimQueueRow[],
  organizationId: string,
  settingsSnapshot: EffectiveClaimSettingsSnapshot,
): Promise<ReturnsClaimQueueRow[]> {
  const returnIds = rows.map((r) => r.return_item_id).filter((id) => isUuidString(id));
  if (!returnIds.length) return rows;

  const caseByReturn = new Map<string, { caseId: string; status: string; submissionId: string | null }>();
  const { data: lineLinks, error: lineLinksErr } = await supabaseServer
    .from("claim_lines")
    .select("return_item_id, claim_case_id")
    .eq("organization_id", organizationId)
    .eq("line_grain", "return_item")
    .in("return_item_id", returnIds)
    .not("claim_case_id", "is", null);

  if (lineLinksErr) {
    const msg = lineLinksErr.message.toLowerCase();
    if (!msg.includes("claim_lines") && !msg.includes("schema")) {
      throw new Error(lineLinksErr.message);
    }
  }

  const caseIds = [
    ...new Set(
      (lineLinks ?? [])
        .map((row) => String((row as { claim_case_id: string | null }).claim_case_id ?? "").trim())
        .filter((id) => isUuidString(id)),
    ),
  ];

  const caseMetaById = new Map<string, { status: string; submissionId: string | null }>();
  if (caseIds.length) {
    const loadCases = async (select: string) => {
      return supabaseServer
        .from("claim_cases")
        .select(select)
        .eq("organization_id", organizationId)
        .in("id", caseIds);
    };

    let casesRes = await loadCases("id, status, metadata");
    if (casesRes.error) {
      const msg = casesRes.error.message.toLowerCase();
      if (msg.includes("column") || msg.includes("schema cache")) {
        casesRes = await loadCases("id, case_status");
      } else if (!msg.includes("claim_cases") && !msg.includes("schema")) {
        throw new Error(casesRes.error.message);
      }
    }

    if (!casesRes.error) {
      for (const raw of casesRes.data ?? []) {
        const c = raw as unknown as Record<string, unknown>;
        const id = String(c.id ?? "");
        if (!id) continue;
        const legacyStatus = String(c.case_status ?? "").trim();
        const status = String(c.status ?? "").trim() || legacyStatus;
        const meta = (c.metadata ?? {}) as Record<string, unknown>;
        const subRaw = String(meta.claim_submission_id ?? "").trim();
        caseMetaById.set(id, {
          status,
          submissionId: isUuidString(subRaw) ? subRaw : null,
        });
      }
    }
  }

  for (const row of lineLinks ?? []) {
    const rid = String((row as { return_item_id: string | null }).return_item_id ?? "").trim();
    const caseId = String((row as { claim_case_id: string | null }).claim_case_id ?? "").trim();
    if (!rid || !caseId || caseByReturn.has(rid)) continue;
    const meta = caseMetaById.get(caseId);
    caseByReturn.set(rid, {
      caseId,
      status: meta?.status ?? "",
      submissionId: meta?.submissionId ?? null,
    });
  }

  const subByReturn = new Map<string, { id: string; hasPdf: boolean }>();
  const { data: subs } = await supabaseServer
    .from("claim_submissions")
    .select("id, return_id, report_url")
    .eq("organization_id", organizationId)
    .in("return_id", returnIds);

  for (const s of subs ?? []) {
    const rid = String((s as { return_id: string | null }).return_id ?? "").trim();
    if (!rid) continue;
    subByReturn.set(rid, {
      id: String((s as { id: string }).id),
      hasPdf: !!String((s as { report_url: string | null }).report_url ?? "").trim(),
    });
  }

  return rows.map((row) => {
    const caseInfo = caseByReturn.get(row.return_item_id);
    const subFromReturn = subByReturn.get(row.return_item_id);
    const claim_case_id = caseInfo?.caseId ?? null;
    const claim_submission_id = caseInfo?.submissionId ?? subFromReturn?.id ?? null;
    const submission_has_pdf = subFromReturn?.hasPdf ?? false;
    const flow_stage: ClaimFlowStage = deriveClaimFlowStage({
      queue_state: row.queue_state,
      claim_case_id,
      claim_case_status: caseInfo?.status ?? null,
      claim_submission_id,
      submission_has_pdf,
    });
    const hasOperatorNote = Boolean(String(row.notes ?? "").trim());
    const display = resolveClaimQueueDisplayReason({
      queue_state: row.queue_state,
      eligibility_reason: row.eligibility_reason,
      has_resolved_product: !!(row.resolved_product_id || row.resolved_catalog_product_id),
      has_scanner_evidence: row.has_scanner_evidence,
      has_operator_note: hasOperatorNote,
      settings: settingsSnapshot,
      flow_stage,
      claim_submission_id,
    });
    return {
      ...row,
      claim_case_id,
      claim_submission_id,
      submission_has_pdf,
      flow_stage,
      flow_stage_label: CLAIM_FLOW_STAGE_LABELS[flow_stage],
      eligibility_display_code: display.code,
      eligibility_display_label: display.label,
      eligibility_display_hint: display.hint,
      state_label: display.label,
    };
  });
}

type ReturnItemRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  package_id: string | null;
  pallet_id: string | null;
  expected_item_id: string | null;
  created_at: string | null;
  conditions: string[] | null;
  photo_evidence: ReturnPhotoEvidenceRow;
  notes: string | null;
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
  identifier_resolution_status: string | null;
  order_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  item_name: string | null;
  lpn: string | null;
  status: string | null;
};

type ClaimLineRow = {
  id: string;
  return_item_id: string | null;
  scanner_issue_type: string | null;
  status: string;
  line_grain: string;
};

export type ListReturnsClaimsWorkQueueResult = {
  ok: boolean;
  error?: string;
  rows: ReturnsClaimQueueRow[];
  returns_domain_enabled: boolean;
  policy_summary: {
    scan_go_live_date: string | null;
    claim_start_date: string | null;
    claim_eligibility_window_days: number;
    returns_enabled: boolean;
    allow_manual_override: boolean;
  };
  /** Full policy for client-side draft gate (serialized). */
  claim_policy: ClaimPolicyV1;
  effective_claim_settings: EffectiveClaimSettingsSnapshot | null;
  stats: {
    scanned_return_items: number;
    claimable_conditions_count: number;
    physical_anchor_excluded_count: number;
    bulk_orphan_excluded_count: number;
    queue_rows: number;
    eligible_count: number;
    backfill_lines_excluded_note: string;
    physical_anchor_note: string;
  };
};

export async function listReturnsClaimsWorkQueue(
  tenant?: TenantQueryOpts,
): Promise<ListReturnsClaimsWorkQueueResult> {
  const emptyStats = {
    scanned_return_items: 0,
    claimable_conditions_count: 0,
    physical_anchor_excluded_count: 0,
    bulk_orphan_excluded_count: 0,
    queue_rows: 0,
    eligible_count: 0,
    backfill_lines_excluded_note:
      "claim_lines with line_grain import_source or expected_group are never loaded for this queue.",
    physical_anchor_note:
      "Only return_items with package_id and without bulk-orphan pattern (expected_item_id only) are shown.",
  };

  try {
    const scope = await resolveTenantListScope(tenant);
    const orgId = scope.mode === "single" ? scope.organizationId : null;

    let policyOrgId = orgId;
    if (!policyOrgId) {
      const { data: firstOrg } = await supabaseServer
        .from("organization_settings")
        .select("organization_id")
        .limit(1)
        .maybeSingle();
      policyOrgId = (firstOrg as { organization_id?: string } | null)?.organization_id ?? null;
    }

    const policy = policyOrgId
      ? await loadClaimPolicy(supabaseServer, policyOrgId)
      : await loadClaimPolicy(supabaseServer, "00000000-0000-0000-0000-000000000001");

    const effectiveSettings = policyOrgId
      ? await getEffectiveClaimSettings(supabaseServer, policyOrgId)
      : null;
    const settingsSnapshot = effectiveSettings
      ? toEffectiveClaimSettingsSnapshot(effectiveSettings)
      : null;

    const returnsEnabled = isClaimModuleDomainEnabled(policy, "returns");
    const policy_summary = {
      scan_go_live_date: policy.scan_go_live_date,
      claim_start_date: policy.claim_start_date,
      claim_eligibility_window_days: policy.claim_eligibility_window_days,
      returns_enabled: returnsEnabled,
      allow_manual_override: policy.allow_manual_override === true,
      auto_create_drafts_on_scan: settingsSnapshot?.auto_create_drafts_on_scan ?? false,
      create_case_when: settingsSnapshot?.workflow.create_case_when ?? "package_closed",
      auto_generate_pdf_reports: settingsSnapshot?.auto_generate_pdf_reports ?? true,
    };
    if (!returnsEnabled) {
      return {
        ok: true,
        rows: [],
        returns_domain_enabled: false,
        policy_summary,
        claim_policy: policy,
        effective_claim_settings: settingsSnapshot,
        stats: emptyStats,
      };
    }

    let q = supabaseServer
      .from(RETURN_ITEMS_TABLE)
      .select(RETURN_LIST_SELECT)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(QUEUE_SCAN_LIMIT);
    if (scope.mode === "single") q = q.eq("organization_id", scope.organizationId);

    const { data: items, error: itemsErr } = await q;
    if (itemsErr) throw new Error(itemsErr.message);

    const scanned = (items ?? []) as unknown as ReturnItemRow[];
    const anchorRow = (r: ReturnItemRow) => ({
      package_id: r.package_id,
      pallet_id: r.pallet_id,
      expected_item_id: r.expected_item_id,
    });
    const withClaimableConditions = scanned.filter((r) =>
      returnItemHasScannerClaimIssue(r.conditions),
    );
    const claimable = withClaimableConditions.filter((r) =>
      isPhysicalReturnItemForClaims(anchorRow(r)),
    );
    const bulkOrphanExcludedCount = withClaimableConditions.filter((r) =>
      isBulkOrphanReturnItemPattern(anchorRow(r)),
    ).length;
    const physicalAnchorExcludedCount = withClaimableConditions.length - claimable.length;

    if (!claimable.length) {
      return {
        ok: true,
        rows: [],
        returns_domain_enabled: true,
        policy_summary,
        claim_policy: policy,
        effective_claim_settings: settingsSnapshot,
        stats: {
          ...emptyStats,
          scanned_return_items: scanned.length,
          claimable_conditions_count: withClaimableConditions.length,
          physical_anchor_excluded_count: physicalAnchorExcludedCount,
          bulk_orphan_excluded_count: bulkOrphanExcludedCount,
        },
      };
    }

    const returnIds = claimable.map((r) => r.id);
    const packageIds = [
      ...new Set(claimable.map((r) => r.package_id).filter((id): id is string => !!id)),
    ];

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

    let linesQ = supabaseServer
      .from("claim_lines")
      .select("id, return_item_id, scanner_issue_type, status, line_grain")
      .eq("line_grain", "return_item")
      .in("return_item_id", returnIds);
    if (scope.mode === "single") linesQ = linesQ.eq("organization_id", scope.organizationId);

    const { data: rawLines, error: linesErr } = await linesQ;
    if (linesErr) {
      const msg = linesErr.message.toLowerCase();
      if (!msg.includes("claim_lines") && !msg.includes("schema")) {
        throw new Error(linesErr.message);
      }
    }

    const lineByReturnId = new Map<string, ClaimLineRow>();
    for (const line of filterClaimLinesForReturnsQueue((rawLines ?? []) as ClaimLineRow[])) {
      if (line.return_item_id) lineByReturnId.set(line.return_item_id, line);
    }

    const effectivePolicy =
      scope.mode === "single" && policyOrgId !== scope.organizationId
        ? await loadClaimPolicy(supabaseServer, scope.organizationId)
        : policy;

    const rowSettings =
      scope.mode === "single"
        ? await getEffectiveClaimSettings(supabaseServer, scope.organizationId)
        : effectiveSettings;
    const rowWorkflow = rowSettings?.workflow ?? settingsSnapshot?.workflow ?? null;

    const rows: ReturnsClaimQueueRow[] = claimable.map((r) => {
      const source: ReturnsClaimQueueSourceRow = {
        return_item_id: r.id,
        organization_id: r.organization_id,
        store_id: r.store_id,
        package_id: r.package_id,
        pallet_id: r.pallet_id,
        expected_item_id: r.expected_item_id,
        created_at: r.created_at,
        conditions: r.conditions,
        photo_evidence: r.photo_evidence,
        notes: r.notes,
        resolved_product_id: r.resolved_product_id,
        resolved_catalog_product_id: r.resolved_catalog_product_id,
        identifier_resolution_status: r.identifier_resolution_status,
        order_id: r.order_id,
        sku: r.sku,
        fnsku: r.fnsku,
        asin: r.asin,
        item_name: r.item_name,
        lpn: r.lpn,
        status: r.status,
        claim_line: lineByReturnId.has(r.id)
          ? {
              id: lineByReturnId.get(r.id)!.id,
              status: lineByReturnId.get(r.id)!.status,
              scanner_issue_type: lineByReturnId.get(r.id)!.scanner_issue_type,
              line_grain: lineByReturnId.get(r.id)!.line_grain,
            }
          : null,
      };
      const packageClosed = r.package_id
        ? (packageClosedById.get(r.package_id) ?? null)
        : null;
      return buildReturnsClaimQueueRow(source, effectivePolicy, packageClosed, rowWorkflow);
    });

    rows.sort((a, b) => {
      const stateOrder: ReturnsClaimQueueRow["queue_state"][] = [
        "eligible",
        "missing_evidence",
        "needs_product_resolution",
        "held_until_package_closed",
        "pre_cutoff",
        "domain_disabled",
      ];
      const ai = stateOrder.indexOf(a.queue_state);
      const bi = stateOrder.indexOf(b.queue_state);
      if (ai !== bi) return ai - bi;
      return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
    });

    const rowSnapshot = rowSettings ? toEffectiveClaimSettingsSnapshot(rowSettings) : settingsSnapshot;
    const enrichedRows =
      scope.mode === "single" && rowSnapshot
        ? await enrichQueueRowsWithClaimFlow(rows, scope.organizationId, rowSnapshot)
        : rows;

    return {
      ok: true,
      rows: enrichedRows,
      returns_domain_enabled: true,
      policy_summary,
      claim_policy: effectivePolicy,
      effective_claim_settings: rowSnapshot ?? settingsSnapshot,
      stats: {
        scanned_return_items: scanned.length,
        claimable_conditions_count: withClaimableConditions.length,
        physical_anchor_excluded_count: physicalAnchorExcludedCount,
        bulk_orphan_excluded_count: bulkOrphanExcludedCount,
        queue_rows: rows.length,
        eligible_count: rows.filter((r) => r.queue_state === "eligible").length,
        backfill_lines_excluded_note: emptyStats.backfill_lines_excluded_note,
        physical_anchor_note: emptyStats.physical_anchor_note,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to load Returns claims queue.",
      rows: [],
      returns_domain_enabled: false,
      policy_summary: {
        scan_go_live_date: null,
        claim_start_date: null,
        claim_eligibility_window_days: 90,
        returns_enabled: false,
        allow_manual_override: false,
      },
      claim_policy: normalizeClaimPolicy(null),
      effective_claim_settings: null,
      stats: emptyStats,
    };
  }
}
