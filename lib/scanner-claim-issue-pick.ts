import { CLAIM_CONDITIONS } from "@/app/returns/claim-queue-helpers";
import {
  ITEM_UNIT_DAMAGE_TAG_KEYS,
  ITEM_UNIT_SELLABLE_OK_TAG,
} from "@/lib/scanner/item-unit-discrepancy-tags";

/** Canonical values accepted by claim_cases / claim_lines / claim_evidence CHECK constraints. */
export const CANONICAL_SCANNER_ISSUE_TYPES = [
  "damaged_product",
  "scratched",
  "expired",
  "missing_parts",
  "wrong_item",
  "empty_box",
  "damaged_box",
  "wet",
  "counterfeit_suspect",
  "operator_other",
] as const;

export type CanonicalScannerIssueType = (typeof CANONICAL_SCANNER_ISSUE_TYPES)[number];

export type ScannerClaimSource = "scanner_operator_issue" | "warehouse_qc_issue";

const SCANNER_TAG_PRIORITY: readonly string[] = [
  "damaged_product",
  "scratched",
  "wrong_item",
  "expired",
  "missing_parts",
  "missing_item",
];

const LEGACY_CONDITION_TO_CANONICAL: Record<string, CanonicalScannerIssueType> = {
  damaged_product: "damaged_product",
  scratched: "scratched",
  expired: "expired",
  missing_parts: "missing_parts",
  missing_item: "missing_parts",
  wrong_item: "wrong_item",
  wrong_item_junk: "wrong_item",
  wrong_item_different: "wrong_item",
  empty_box: "empty_box",
  damaged_box: "damaged_box",
  damaged_warehouse: "operator_other",
  damaged_customer: "operator_other",
  damaged_carrier: "operator_other",
};

export const SCANNER_ISSUE_TO_DISCREPANCY: Record<CanonicalScannerIssueType, string> = {
  damaged_product: "damage",
  scratched: "damage",
  expired: "other",
  missing_parts: "other",
  wrong_item: "wrong_item",
  empty_box: "other",
  damaged_box: "damage",
  wet: "damage",
  counterfeit_suspect: "other",
  operator_other: "other",
};

/** Scanner item-unit damage tags plus legacy claim conditions that may appear on return_items. */
export function isScannerClaimableConditionTag(tag: string): boolean {
  const k = String(tag ?? "").trim();
  if (!k || k === ITEM_UNIT_SELLABLE_OK_TAG) return false;
  if ((ITEM_UNIT_DAMAGE_TAG_KEYS as readonly string[]).includes(k)) return true;
  return CLAIM_CONDITIONS.has(k);
}

export function pickPrimaryScannerIssueFromConditions(
  conditions: string[] | null | undefined,
): { tag: string; canonical: CanonicalScannerIssueType; claimSource: ScannerClaimSource } | null {
  const list = (conditions ?? []).map((c) => String(c ?? "").trim()).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1 && list[0] === ITEM_UNIT_SELLABLE_OK_TAG) return null;

  let picked: string | null = null;
  for (const p of SCANNER_TAG_PRIORITY) {
    if (list.includes(p)) {
      picked = p;
      break;
    }
  }
  if (!picked) {
    for (const c of list) {
      if (isScannerClaimableConditionTag(c)) {
        picked = c;
        break;
      }
    }
  }
  if (!picked || !isScannerClaimableConditionTag(picked)) return null;

  const canonical = LEGACY_CONDITION_TO_CANONICAL[picked];
  if (!canonical) return null;

  const claimSource: ScannerClaimSource =
    picked === "damaged_warehouse" ||
    picked === "damaged_customer" ||
    picked === "damaged_carrier"
      ? "warehouse_qc_issue"
      : "scanner_operator_issue";

  return { tag: picked, canonical, claimSource };
}

export function mapScannerIssueToDiscrepancyKind(canonical: CanonicalScannerIssueType): string {
  return SCANNER_ISSUE_TO_DISCREPANCY[canonical] ?? "other";
}
