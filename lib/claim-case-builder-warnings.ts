import { claimEligibilityReasonLabel, toUtcDateString } from "./claim-eligibility-policy";
import type { EffectiveClaimSettingsSnapshot } from "./claim-effective-settings-shared";
import type { ClaimPolicyV1 } from "./claim-policy-types";
import type { ClaimEligibilityReason } from "./claim-policy-types";
import { evaluateManualDraftEligibility } from "./returns-manual-claim-grouping";
import type { ReturnsClaimQueueRow } from "./returns-claims-work-queue";
import {
  clusterRowsByManualDimension,
  type ManualGroupingDimension,
  type ManualGroupingReturnItemInput,
} from "./returns-manual-claim-grouping";
import { pickPrimaryScannerIssueFromConditions } from "./scanner-claim-issue-pick";

export type CaseBuilderWarningCode =
  | "mixed_product"
  | "mixed_issue"
  | "mixed_source"
  | "mixed_package"
  | "mixed_pallet"
  | "mixed_order"
  | "mixed_cutoff"
  | "missing_evidence"
  | "missing_product_link"
  | "policy_hold";

export type CaseBuilderWarning = {
  code: CaseBuilderWarningCode;
  message: string;
  severity: "info" | "warn" | "block";
};

function rowToManualInput(row: ReturnsClaimQueueRow): ManualGroupingReturnItemInput {
  return {
    return_item_id: row.return_item_id,
    organization_id: row.organization_id,
    store_id: row.store_id,
    package_id: row.package_id,
    pallet_id: row.pallet_id,
    expected_item_id: row.expected_item_id,
    conditions: row.conditions,
    photo_evidence: row.photo_evidence,
    resolved_product_id: row.resolved_product_id,
    resolved_catalog_product_id: row.resolved_catalog_product_id,
    order_id: row.order_id,
    sku: row.sku,
    notes: row.notes,
    created_at: row.created_at,
  };
}

function uniqueNonEmpty(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean))];
}

export function analyzeCaseBuilderWarnings(
  rows: ReturnsClaimQueueRow[],
  policy: ClaimPolicyV1 | null | undefined,
  settings?: EffectiveClaimSettingsSnapshot | null,
  policyOverride?: ClaimPolicyV1 | null,
): { warnings: CaseBuilderWarning[]; blocking: boolean } {
  const workflow = settings?.workflow;
  const effectivePolicy = policyOverride ?? policy;
  const warnings: CaseBuilderWarning[] = [];
  if (!rows.length) {
    return { warnings: [{ code: "mixed_product", message: "Select at least one eligible row.", severity: "block" }], blocking: true };
  }

  const products = uniqueNonEmpty(
    rows.map((r) => r.resolved_product_id ?? r.resolved_catalog_product_id ?? r.sku ?? ""),
  );
  if (products.length > 1) {
    const allowMixed =
      workflow?.allow_mixed_products === true ||
      settings?.allow_manual_override === true;
    warnings.push({
      code: "mixed_product",
      message: `${products.length} different products in selection.`,
      severity: allowMixed ? "warn" : "block",
    });
  }

  const issues = uniqueNonEmpty(
    rows.map((r) => {
      const issue = pickPrimaryScannerIssueFromConditions(r.conditions);
      return issue?.canonical ?? r.scanner_issue_type ?? "";
    }),
  );
  if (issues.length > 1) {
    const allowMixed = workflow?.allow_mixed_issue_types === true;
    warnings.push({
      code: "mixed_issue",
      message: `${issues.length} different issue types — consider splitting by issue.`,
      severity: allowMixed ? "warn" : "block",
    });
  }

  if (uniqueNonEmpty(rows.map((r) => r.package_id)).length > 1) {
    warnings.push({ code: "mixed_package", message: "Multiple packages in one case.", severity: "warn" });
  }
  if (uniqueNonEmpty(rows.map((r) => r.pallet_id)).length > 1) {
    warnings.push({ code: "mixed_pallet", message: "Multiple pallets in one case.", severity: "warn" });
  }
  if (uniqueNonEmpty(rows.map((r) => r.order_id)).length > 1) {
    warnings.push({ code: "mixed_order", message: "Multiple order IDs in one case.", severity: "warn" });
  }

  const dates = uniqueNonEmpty(rows.map((r) => toUtcDateString(r.created_at) ?? ""));
  if (dates.length > 1) {
    warnings.push({
      code: "mixed_cutoff",
      message: "Scan dates span multiple days — verify claim window / cutoff policy.",
      severity: "warn",
    });
  }

  const missingProduct = rows.filter((r) => !(r.resolved_product_id || r.resolved_catalog_product_id));
  if (missingProduct.length) {
    const requireLink = workflow?.require_product_link !== false;
    warnings.push({
      code: "missing_product_link",
      message: `${missingProduct.length} row(s) without resolved product link.`,
      severity: !requireLink || effectivePolicy?.allow_manual_override ? "warn" : "block",
    });
  }

  const missingEvidence = rows.filter((r) => r.queue_state === "missing_evidence");
  if (missingEvidence.length) {
    warnings.push({
      code: "missing_evidence",
      message: `${missingEvidence.length} row(s) missing scanner evidence or operator note.`,
      severity: "warn",
    });
  }

  warnings.push({
    code: "mixed_source",
    message: "Physical return scans only — import/removal lines are not attached via this builder.",
    severity: "info",
  });

  if (effectivePolicy) {
    for (const row of rows) {
      const gate = evaluateManualDraftEligibility(row, effectivePolicy, {
        workflow: workflow ?? undefined,
      });
      if (!gate.allowed && gate.reason) {
        const reasonLabel =
          typeof gate.reason === "string" &&
          (["allowed", "scan_not_live", "import_pre_cutoff", "outside_window", "hold_package_open", "hold_pallet_open", "hold_order_incomplete", "manual_review_required", "missing_scanner_evidence", "promote_disabled", "module_scope_disabled"] as const).includes(
            gate.reason as ClaimEligibilityReason,
          )
            ? claimEligibilityReasonLabel(gate.reason as ClaimEligibilityReason)
            : String(gate.reason);
        warnings.push({
          code: "policy_hold",
          message: `Item ${row.return_item_id.slice(0, 8)}…: ${reasonLabel}`,
          severity: "block",
        });
      }
    }
  }

  const blocking = warnings.some((w) => w.severity === "block");
  return { warnings, blocking };
}

export function splitSelectionByDimension(
  rows: ReturnsClaimQueueRow[],
  dimension: ManualGroupingDimension,
): Array<{ key: string; rows: ReturnsClaimQueueRow[] }> {
  const inputs = rows.map(rowToManualInput);
  const clusters = clusterRowsByManualDimension(inputs, dimension);
  const byId = new Map(rows.map((r) => [r.return_item_id, r]));
  return [...clusters.entries()].map(([key, items]) => ({
    key,
    rows: items.map((i) => byId.get(i.return_item_id)).filter((r): r is ReturnsClaimQueueRow => !!r),
  }));
}
