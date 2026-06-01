import {
  evaluateClaimEligibilitySync,
  type EvaluateClaimEligibilityInput,
} from "./claim-eligibility-policy";
import type { ClaimEligibilityReason, ClaimEligibilityResult, ClaimPolicyV1 } from "./claim-policy-types";
import { isClaimModuleDomainEnabled } from "./claim-module-scope";
import {
  hasReturnPhotoEvidenceUrlSlots,
  type ReturnPhotoEvidenceRow,
} from "./return-photo-evidence";
import { isPhysicalReturnItemForClaims, type ReturnItemPhysicalAnchorRow } from "./return-item-physical-scan";
import {
  isBackfillClaimLineExcludedFromQueue,
  returnHasResolvedProduct,
  returnHasScannerPhotoEvidence,
  type ReturnsClaimQueueRow,
  type ReturnsClaimQueueState,
} from "./returns-claims-work-queue";
import {
  mapScannerIssueToDiscrepancyKind,
  pickPrimaryScannerIssueFromConditions,
  type CanonicalScannerIssueType,
} from "./scanner-claim-issue-pick";

/** Phase-1 manual grouping dimensions for live physical return_items. */
export type ManualGroupingDimension = "product" | "order" | "package" | "pallet" | "issue";

export type ManualGroupingReturnItemInput = ReturnItemPhysicalAnchorRow & {
  return_item_id: string;
  organization_id: string;
  store_id?: string | null;
  pallet_id?: string | null;
  package_id?: string | null;
  expected_item_id?: string | null;
  conditions?: string[] | null;
  photo_evidence?: ReturnPhotoEvidenceRow;
  resolved_product_id?: string | null;
  resolved_catalog_product_id?: string | null;
  order_id?: string | null;
  sku?: string | null;
  notes?: string | null;
  created_at?: string | null;
};

export type ManualDraftPolicyGateContext = {
  packageClosedByReturnItemId?: Record<string, boolean | null>;
  evaluationDate?: string | Date;
};

export type ManualDraftPolicyGateResult = {
  allowed: boolean;
  reason: ClaimEligibilityReason | string;
  eligibility: ClaimEligibilityResult;
};

export type AmazonReturnsReferenceLine = {
  claim_line_id: string;
  source_table: "amazon_returns";
  source_row_id: string;
  order_id: string | null;
  sku: string | null;
  status: string;
  line_grain: "import_source";
  read_only: true;
};

/** Only return_item grain is operator returns-first; backfill grains are excluded. */
export function isReturnsFirstOperatorClaimLineGrain(lineGrain: string | null | undefined): boolean {
  return String(lineGrain ?? "").trim() === "return_item";
}

export function isExcludedFromReturnsFirstGrouping(lineGrain: string | null | undefined): boolean {
  return isBackfillClaimLineExcludedFromQueue(lineGrain);
}

/** Backfill / financial grains must never seed a returns-first manual draft. */
export function isBlockedGrainForManualDraftCreation(
  lineGrain: string | null | undefined,
  sourceTable?: string | null,
): boolean {
  const grain = String(lineGrain ?? "").trim();
  if (isBackfillClaimLineExcludedFromQueue(grain)) return true;
  if (grain === "import_source") {
    const st = String(sourceTable ?? "").trim();
    if (st === "amazon_removals" || st === "amazon_removal_shipments") return true;
  }
  return grain !== "return_item";
}

export function canCreateDraftFromUnresolvedProduct(policy: ClaimPolicyV1): boolean {
  return policy.allow_manual_override === true;
}

function hasOperatorNote(notes: string | null | undefined): boolean {
  return Boolean(String(notes ?? "").trim());
}

function hasScannerEvidenceForRow(row: ManualGroupingReturnItemInput): boolean {
  return (
    returnHasScannerPhotoEvidence(row.photo_evidence ?? {}) ||
    hasReturnPhotoEvidenceUrlSlots(row.photo_evidence ?? {})
  );
}

/**
 * Single policy gate for manual returns draft — must pass before any claim_cases/claim_lines insert.
 */
export function evaluateManualDraftPolicyGate(
  row: ManualGroupingReturnItemInput,
  policy: ClaimPolicyV1,
  context?: ManualDraftPolicyGateContext,
): ManualDraftPolicyGateResult {
  const issue = pickPrimaryScannerIssueFromConditions(row.conditions);
  const claimSource =
    issue?.claimSource === "warehouse_qc_issue" ? "warehouse_qc_issue" : "scanner_operator_issue";

  const packageClosed =
    context?.packageClosedByReturnItemId?.[row.return_item_id] ?? null;

  const eligibility = evaluateClaimEligibilitySync({
    policy,
    claimSource,
    eventAt: row.created_at ?? null,
    hasScannerEvidence: hasScannerEvidenceForRow(row),
    evaluationDate: context?.evaluationDate,
    packageClosed,
    moduleDomain: "returns",
  } satisfies EvaluateClaimEligibilityInput);

  if (!isPhysicalReturnItemForClaims(row)) {
    return { allowed: false, reason: "not_physical_scan", eligibility };
  }
  if (!issue) {
    return { allowed: false, reason: "not_claimable", eligibility };
  }
  if (!returnHasResolvedProduct(row) && !canCreateDraftFromUnresolvedProduct(policy)) {
    return { allowed: false, reason: "needs_product_resolution", eligibility };
  }
  if (issue.canonical === "operator_other" && !hasOperatorNote(row.notes)) {
    return { allowed: false, reason: "missing_operator_note", eligibility };
  }
  if (!eligibility.allowed) {
    return { allowed: false, reason: eligibility.reason, eligibility };
  }
  return { allowed: true, reason: "allowed", eligibility };
}

export function buildManualGroupKey(
  row: ManualGroupingReturnItemInput,
  dimension: ManualGroupingDimension,
  issueType: CanonicalScannerIssueType | null,
): string {
  switch (dimension) {
    case "product": {
      const pid = String(row.resolved_product_id ?? row.resolved_catalog_product_id ?? "").trim();
      return pid ? `product:${pid}` : `sku:${String(row.sku ?? "").trim() || "unknown"}`;
    }
    case "order":
      return `order:${String(row.order_id ?? "").trim() || "unknown"}`;
    case "package":
      return `package:${String(row.package_id ?? "").trim() || "unknown"}`;
    case "pallet":
      return `pallet:${String(row.pallet_id ?? "").trim() || "unknown"}`;
    case "issue":
      return `issue:${issueType ?? "unknown"}`;
    default:
      return "unknown";
  }
}

export function clusterRowsByManualDimension(
  rows: ManualGroupingReturnItemInput[],
  dimension: ManualGroupingDimension,
): Map<string, ManualGroupingReturnItemInput[]> {
  const map = new Map<string, ManualGroupingReturnItemInput[]>();
  for (const row of rows) {
    const issue = pickPrimaryScannerIssueFromConditions(row.conditions);
    const key = buildManualGroupKey(row, dimension, issue?.canonical ?? null);
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

export type ManualDraftEligibilityResult = {
  allowed: boolean;
  reason?: string;
  queue_state?: ReturnsClaimQueueState;
};

/** Whether a queue row may be selected for manual draft case creation (UI + server preview). */
export function evaluateManualDraftEligibility(
  row: Pick<
    ReturnsClaimQueueRow,
    | "return_item_id"
    | "queue_state"
    | "has_scanner_evidence"
    | "package_id"
    | "pallet_id"
    | "expected_item_id"
    | "conditions"
    | "photo_evidence"
    | "notes"
    | "resolved_product_id"
    | "resolved_catalog_product_id"
    | "created_at"
    | "package_closed"
  >,
  policy: ClaimPolicyV1,
): ManualDraftEligibilityResult {
  const gate = evaluateManualDraftPolicyGate(
    {
      return_item_id: row.return_item_id,
      organization_id: "",
      package_id: row.package_id,
      pallet_id: row.pallet_id,
      expected_item_id: row.expected_item_id,
      conditions: row.conditions,
      photo_evidence: row.photo_evidence,
      notes: row.notes,
      resolved_product_id: row.resolved_product_id,
      resolved_catalog_product_id: row.resolved_catalog_product_id,
      created_at: row.created_at,
    },
    policy,
    {
      packageClosedByReturnItemId: { [row.return_item_id]: row.package_closed ?? null },
    },
  );
  const queue_state = row.queue_state;
  if (!gate.allowed) {
    const reason = String(gate.reason);
    if (reason === "scan_not_live" || reason === "import_pre_cutoff" || reason === "outside_window") {
      return { allowed: false, reason, queue_state: "pre_cutoff" };
    }
    if (reason === "module_scope_disabled") {
      return { allowed: false, reason, queue_state: "domain_disabled" };
    }
    if (reason === "hold_package_open") {
      return { allowed: false, reason, queue_state: "held_until_package_closed" };
    }
    if (reason === "needs_product_resolution") {
      return { allowed: false, reason, queue_state: "needs_product_resolution" };
    }
    if (reason === "missing_scanner_evidence" || reason === "missing_operator_note") {
      return { allowed: false, reason, queue_state: "missing_evidence" };
    }
    return { allowed: false, reason, queue_state };
  }
  return { allowed: true, queue_state };
}

export function validateManualGroupingSelection(
  rows: ManualGroupingReturnItemInput[],
  policy: ClaimPolicyV1,
  context?: ManualDraftPolicyGateContext,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!rows.length) errors.push("Select at least one return item.");
  if (!isClaimModuleDomainEnabled(policy, "returns")) {
    errors.push("Returns claim module is disabled.");
    return { ok: false, errors };
  }
  const orgs = new Set(rows.map((r) => r.organization_id));
  if (orgs.size > 1) errors.push("All items must belong to the same organization.");
  for (const row of rows) {
    const gate = evaluateManualDraftPolicyGate(row, policy, context);
    if (!gate.allowed) {
      errors.push(`Return item ${row.return_item_id}: ${gate.reason}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Reference import_source lines must never receive claim_case_id from manual draft flow. */
export function assertImportReferenceNotAttachedToDraft(
  lines: Array<{ claim_line_id: string; line_grain: string; read_only?: boolean }>,
  claimCaseId: string | null,
): boolean {
  if (!claimCaseId) return true;
  return lines.every((l) => l.read_only === true && l.line_grain === "import_source");
}

export function manualClaimCaseIdempotencyKey(
  organizationId: string,
  returnItemIds: string[],
  scannerIssueType: CanonicalScannerIssueType | null,
): string {
  const sorted = [...returnItemIds].map((id) => id.trim()).filter(Boolean).sort();
  const issue = scannerIssueType ?? "mixed";
  return `cl:case:manual:${organizationId}:${issue}:${sorted.join(",")}`;
}

export function claimLineIdempotencyKeyForReturnItem(organizationId: string, returnItemId: string): string {
  return `cl:return_item:${organizationId}:${returnItemId}`;
}

export function deriveManualClaimLineStatus(
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

export function manualClaimLinePatchFromReturnItem(
  row: ManualGroupingReturnItemInput,
  claimCaseId: string,
  canonical: CanonicalScannerIssueType,
  sourceTag: string,
) {
  const hasPhoto =
    returnHasScannerPhotoEvidence(row.photo_evidence ?? {}) ||
    hasReturnPhotoEvidenceUrlSlots(row.photo_evidence ?? {});
  const lineStatus = deriveManualClaimLineStatus(canonical, hasPhoto);
  return {
    organization_id: row.organization_id,
    store_id: row.store_id ?? null,
    return_item_id: row.return_item_id,
    expected_package_id: row.expected_item_id ?? null,
    resolved_product_id: row.resolved_product_id ?? null,
    package_id: row.package_id ?? null,
    pallet_id: row.pallet_id ?? null,
    order_id: row.order_id ?? null,
    sku: row.sku ?? null,
    line_grain: "return_item" as const,
    discrepancy_kind: mapScannerIssueToDiscrepancyKind(canonical),
    quantity_basis: "units",
    count_basis: "scan_count",
    scanner_issue_type: canonical,
    claim_case_id: claimCaseId,
    status: lineStatus.status,
    status_reason: lineStatus.status_reason,
    metadata: {
      promote_source: "returns_manual_grouping_phase1",
      source_condition_tag: sourceTag,
      phase1_manual_draft: true,
      policy_gate: "returns_manual_draft_v1",
      returns_first_only: true,
    },
  };
}

/** Read-only TRID/inbox context — never used to create returns-first cases. */
export function filterAmazonReturnsReferenceLines(
  lines: Array<{
    id: string;
    line_grain: string;
    source_table: string | null;
    source_row_id: string | null;
    order_id: string | null;
    sku: string | null;
    status: string;
  }>,
  opts: { order_ids: string[]; skus: string[] },
  limit = 15,
): AmazonReturnsReferenceLine[] {
  const orderSet = new Set(opts.order_ids.map((o) => o.trim()).filter(Boolean));
  const skuSet = new Set(opts.skus.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const out: AmazonReturnsReferenceLine[] = [];
  for (const line of lines) {
    if (line.line_grain !== "import_source") continue;
    if (String(line.source_table ?? "").trim() !== "amazon_returns") continue;
    const order = String(line.order_id ?? "").trim();
    const sku = String(line.sku ?? "").trim().toLowerCase();
    const match = (order && orderSet.has(order)) || (sku && skuSet.has(sku));
    if (!match) continue;
    out.push({
      claim_line_id: line.id,
      source_table: "amazon_returns",
      source_row_id: String(line.source_row_id ?? ""),
      order_id: line.order_id,
      sku: line.sku,
      status: line.status,
      line_grain: "import_source",
      read_only: true,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Guard: backfill execute scripts must not run in manual grouping flow. */
export function assertNoBulkBackfillExecuteInManualFlow(caller: string): void {
  const blocked = ["claim-return-line-backfill-execute", "claim-return-line-backfill-dryrun"];
  if (blocked.some((b) => caller.includes(b))) {
    throw new Error("Bulk claim_lines backfill is forbidden in returns-first manual grouping.");
  }
}
