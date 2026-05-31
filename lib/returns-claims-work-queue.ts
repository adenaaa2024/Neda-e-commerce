import {
  evaluateClaimEligibilitySync,
  type EvaluateClaimEligibilityInput,
} from "./claim-eligibility-policy";
import type { ClaimEligibilityReason, ClaimPolicyV1 } from "./claim-policy-types";
import { isClaimModuleDomainEnabled } from "./claim-module-scope";
import {
  hasReturnPhotoEvidenceCounts,
  hasReturnPhotoEvidenceUrlSlots,
  type ReturnPhotoEvidenceRow,
} from "./return-photo-evidence";
import {
  CANONICAL_SCANNER_ISSUE_TYPES,
  pickPrimaryScannerIssueFromConditions,
  type CanonicalScannerIssueType,
} from "./scanner-claim-issue-pick";
import {
  isBulkOrphanReturnItemPattern,
  isPhysicalReturnItemForClaims,
  type ReturnItemPhysicalAnchorRow,
} from "./return-item-physical-scan";

export type { ReturnItemPhysicalAnchorRow as PhysicalReturnItemAnchorRow };
export { isBulkOrphanReturnItemPattern, isPhysicalReturnItemForClaims };

function asCanonicalScannerIssueType(
  value: string | null | undefined,
): CanonicalScannerIssueType | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  return (CANONICAL_SCANNER_ISSUE_TYPES as readonly string[]).includes(s)
    ? (s as CanonicalScannerIssueType)
    : null;
}

/** Phase-1 Returns claims work queue row state. */
export type ReturnsClaimQueueState =
  | "eligible"
  | "pre_cutoff"
  | "missing_evidence"
  | "needs_product_resolution"
  | "held_until_package_closed"
  | "domain_disabled";

export type ReturnsClaimQueueClaimLineRef = {
  id: string;
  status: string;
  scanner_issue_type: string | null;
  line_grain: string;
};

export type ReturnsClaimQueueSourceRow = ReturnItemPhysicalAnchorRow & {
  return_item_id: string;
  organization_id: string;
  store_id: string | null;
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
  claim_line: ReturnsClaimQueueClaimLineRef | null;
};

export type ReturnsClaimQueueRow = ReturnsClaimQueueSourceRow & {
  queue_state: ReturnsClaimQueueState;
  state_label: string;
  eligibility_reason: ClaimEligibilityReason;
  scanner_issue_type: CanonicalScannerIssueType | null;
  scanner_issue_label: string | null;
  has_scanner_evidence: boolean;
  package_closed: boolean | null;
};

export const RETURNS_CLAIM_QUEUE_STATE_LABELS: Record<ReturnsClaimQueueState, string> = {
  eligible: "Eligible",
  pre_cutoff: "Pre-cutoff",
  missing_evidence: "Missing evidence",
  needs_product_resolution: "Needs product resolution",
  held_until_package_closed: "Held — package open",
  domain_disabled: "Returns module disabled",
};

const BACKFILL_LINE_GRAINS = new Set(["import_source", "expected_group"]);

/** Backfill / detection rows must never appear in the Returns phase-1 queue. */
export function isBackfillClaimLineExcludedFromQueue(lineGrain: string | null | undefined): boolean {
  const g = String(lineGrain ?? "").trim().toLowerCase();
  return BACKFILL_LINE_GRAINS.has(g);
}

/** Only operational return_item grain lines may attach to the queue. */
export function isReturnsWorkQueueClaimLine(line: {
  line_grain: string | null | undefined;
  return_item_id?: string | null;
}): boolean {
  if (isBackfillClaimLineExcludedFromQueue(line.line_grain)) return false;
  return String(line.line_grain ?? "").trim() === "return_item" && !!line.return_item_id;
}

export function returnItemHasScannerClaimIssue(conditions: string[] | null | undefined): boolean {
  return pickPrimaryScannerIssueFromConditions(conditions) !== null;
}

/** Physical scan + scanner claimable issue — queue and promote candidate selector. */
export function isReturnItemClaimCandidateForReturns(
  row: ReturnItemPhysicalAnchorRow & { conditions?: string[] | null },
): boolean {
  if (!isPhysicalReturnItemForClaims(row)) return false;
  return returnItemHasScannerClaimIssue(row.conditions);
}

export function returnHasScannerPhotoEvidence(photoEvidence: ReturnPhotoEvidenceRow): boolean {
  return hasReturnPhotoEvidenceUrlSlots(photoEvidence) || hasReturnPhotoEvidenceCounts(photoEvidence);
}

export function returnHasResolvedProduct(row: {
  resolved_product_id?: string | null;
  resolved_catalog_product_id?: string | null;
}): boolean {
  const a = String(row.resolved_product_id ?? "").trim();
  const b = String(row.resolved_catalog_product_id ?? "").trim();
  return Boolean(a || b);
}

export function packageStatusIsClosed(status: string | null | undefined): boolean | null {
  const s = String(status ?? "").trim().toLowerCase();
  if (!s) return null;
  return s === "closed" || s === "submitted";
}

export type DeriveQueueStateInput = {
  policy: ClaimPolicyV1;
  eligibility: { allowed: boolean; reason: ClaimEligibilityReason };
  hasResolvedProduct: boolean;
  hasScannerEvidence: boolean;
};

export function deriveReturnsClaimQueueState(input: DeriveQueueStateInput): ReturnsClaimQueueState {
  if (!isClaimModuleDomainEnabled(input.policy, "returns")) {
    return "domain_disabled";
  }
  const reason = input.eligibility.reason;
  if (reason === "module_scope_disabled") return "domain_disabled";
  if (
    reason === "scan_not_live" ||
    reason === "import_pre_cutoff" ||
    reason === "outside_window"
  ) {
    return "pre_cutoff";
  }
  if (reason === "hold_package_open") return "held_until_package_closed";
  if (!input.hasResolvedProduct) return "needs_product_resolution";
  if (reason === "missing_scanner_evidence" || !input.hasScannerEvidence) {
    return "missing_evidence";
  }
  if (input.eligibility.allowed) return "eligible";
  if (reason === "hold_pallet_open" || reason === "manual_review_required") {
    return "missing_evidence";
  }
  return "pre_cutoff";
}

export function buildReturnsClaimQueueRow(
  source: ReturnsClaimQueueSourceRow,
  policy: ClaimPolicyV1,
  packageClosed: boolean | null,
): ReturnsClaimQueueRow {
  const issue = pickPrimaryScannerIssueFromConditions(source.conditions);
  const hasScannerEvidence = returnHasScannerPhotoEvidence(source.photo_evidence);
  const hasResolvedProduct = returnHasResolvedProduct(source);

  const eligibilityClaimSource =
    issue?.claimSource === "warehouse_qc_issue" ? "warehouse_qc_issue" : "scanner_operator_issue";

  const eligibility = evaluateClaimEligibilitySync({
    policy,
    claimSource: eligibilityClaimSource,
    eventAt: source.created_at,
    hasScannerEvidence,
    packageClosed,
    moduleDomain: "returns",
  } satisfies EvaluateClaimEligibilityInput);

  const queue_state = deriveReturnsClaimQueueState({
    policy,
    eligibility,
    hasResolvedProduct,
    hasScannerEvidence,
  });

  return {
    ...source,
    queue_state,
    state_label: RETURNS_CLAIM_QUEUE_STATE_LABELS[queue_state],
    eligibility_reason: eligibility.reason,
    scanner_issue_type:
      issue?.canonical ?? asCanonicalScannerIssueType(source.claim_line?.scanner_issue_type),
    scanner_issue_label: issue?.tag ?? null,
    has_scanner_evidence: hasScannerEvidence,
    package_closed: packageClosed,
  };
}

/** Filter persisted claim_lines to queue-safe return_item rows only. */
export function filterClaimLinesForReturnsQueue<T extends { line_grain: string; return_item_id?: string | null }>(
  lines: T[],
): T[] {
  return lines.filter(isReturnsWorkQueueClaimLine);
}
