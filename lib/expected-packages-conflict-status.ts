/**
 * Read-model classification for expected_packages build_status — clean vs disputed.
 * No DB writes; used by Shipment Entry display and claim intake gating.
 */

export const CLEAN_BUILD_STATUSES = [
  "matched",
  "expected",
  "resolved",
  "complete",
] as const;

export const DISPUTED_BUILD_STATUSES = [
  "shipment_overflow_conflict",
  "detail_remainder",
  "source_conflict",
  "stale_partial_snapshot",
  "duplicate_source_conflict",
] as const;

export type ExpectedPackageStatusClass = "clean" | "disputed";

export type ExpectedPackageClaimReadiness = "claim_ready" | "needs_source_reconciliation" | "review_needed";

export type ExpectedPackageReviewSignal = {
  expected_package_id: string | null;
  tracking_number: string | null;
  fnsku: string | null;
  sku: string | null;
  build_status: string;
  quantity: number;
  readiness: ExpectedPackageClaimReadiness;
  message: string;
};

/** Operator-facing copy — Shipment Entry and claim review surfaces. */
export const EXPECTED_PACKAGE_UI_COPY = {
  expectedClean: "Expected clean",
  needsReconciliation: "Needs reconciliation",
  amazonSourceMismatch: "Amazon source mismatch",
  shipmentDetailQtyDisagree: "Shipment qty and removal detail qty disagree",
} as const;

const CLEAN_SET = new Set<string>(CLEAN_BUILD_STATUSES);
const DISPUTED_SET = new Set<string>(DISPUTED_BUILD_STATUSES);

function normStatus(buildStatus: string | null | undefined): string {
  return String(buildStatus ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/** Treat resolved/matched equivalents as clean; unknown statuses are disputed. */
export function classifyExpectedPackageBuildStatus(
  buildStatus: string | null | undefined,
): ExpectedPackageStatusClass {
  const s = normStatus(buildStatus);
  if (!s) return "disputed";
  if (CLEAN_SET.has(s)) return "clean";
  if (DISPUTED_SET.has(s)) return "disputed";
  if (s.includes("matched") && !s.includes("conflict") && !s.includes("overflow")) return "clean";
  if (s.includes("expected") && !s.includes("no_shipment")) return "clean";
  return "disputed";
}

export function isCleanExpectedPackageBuildStatus(buildStatus: string | null | undefined): boolean {
  return classifyExpectedPackageBuildStatus(buildStatus) === "clean";
}

export function isDisputedExpectedPackageBuildStatus(buildStatus: string | null | undefined): boolean {
  return classifyExpectedPackageBuildStatus(buildStatus) === "disputed";
}

export function splitExpectedQuantityByBuildStatus(
  buildStatus: string | null | undefined,
  quantity: number,
): { clean: number; disputed: number } {
  const qty = Math.max(0, Math.trunc(quantity));
  return classifyExpectedPackageBuildStatus(buildStatus) === "clean"
    ? { clean: qty, disputed: 0 }
    : { clean: 0, disputed: qty };
}

export function expectedPackageClaimReadinessFromBuildStatus(
  buildStatus: string | null | undefined,
): ExpectedPackageClaimReadiness {
  return classifyExpectedPackageBuildStatus(buildStatus) === "clean"
    ? "claim_ready"
    : "needs_source_reconciliation";
}

export type ExpectedPackageRowLike = {
  id?: string | null;
  build_status?: string | null;
  expected_scan_quantity?: number | null;
  tracking_number?: string | null;
  fnsku?: string | null;
  sku?: string | null;
};

export function filterExpectedPackagesForClaimGeneration<T extends ExpectedPackageRowLike>(
  rows: T[],
): { claimReady: T[]; reviewNeeded: T[] } {
  const claimReady: T[] = [];
  const reviewNeeded: T[] = [];
  for (const row of rows) {
    if (isCleanExpectedPackageBuildStatus(row.build_status)) claimReady.push(row);
    else reviewNeeded.push(row);
  }
  return { claimReady, reviewNeeded };
}

export function buildExpectedPackageReviewSignals(rows: ExpectedPackageRowLike[]): ExpectedPackageReviewSignal[] {
  const signals: ExpectedPackageReviewSignal[] = [];
  for (const row of rows) {
    if (isCleanExpectedPackageBuildStatus(row.build_status)) continue;
    const qty = Math.max(0, Math.trunc(Number(row.expected_scan_quantity ?? 0)));
    if (qty <= 0) continue;
    const buildStatus = String(row.build_status ?? "").trim() || "unknown";
    signals.push({
      expected_package_id: row.id != null ? String(row.id).trim() || null : null,
      tracking_number: row.tracking_number != null ? String(row.tracking_number).trim() || null : null,
      fnsku: row.fnsku != null ? String(row.fnsku).trim() || null : null,
      sku: row.sku != null ? String(row.sku).trim() || null : null,
      build_status: buildStatus,
      quantity: qty,
      readiness: "needs_source_reconciliation",
      message: reconciliationMessageForBuildStatus(buildStatus),
    });
  }
  return signals;
}

export function reviewSignalNotes(signals: ExpectedPackageReviewSignal[]): string[] {
  return signals.map(
    (s) =>
      `review_needed: ${s.readiness} expected_package_id=${s.expected_package_id ?? "—"} build_status=${s.build_status} qty=${s.quantity} — ${s.message}`,
  );
}

export function reconciliationMessageForBuildStatus(buildStatus: string | null | undefined): string {
  const s = normStatus(buildStatus);
  if (s === "shipment_overflow_conflict") {
    return EXPECTED_PACKAGE_UI_COPY.shipmentDetailQtyDisagree;
  }
  if (
    s === "source_conflict" ||
    s === "duplicate_source_conflict" ||
    s === "stale_partial_snapshot" ||
    s === "detail_remainder"
  ) {
    return EXPECTED_PACKAGE_UI_COPY.amazonSourceMismatch;
  }
  return EXPECTED_PACKAGE_UI_COPY.needsReconciliation;
}

/**
 * Source priority for removal/shipment expected quantity (read-model only).
 * Shipment row qty is primary physical evidence; newer full detail informs order qty;
 * stale partial detail is disputed — never auto-pick a final claim quantity when sources disagree.
 */
export const EXPECTED_PACKAGE_SOURCE_PRIORITY_RULES = {
  primary_physical_evidence: "amazon_removal_shipments.shipped_quantity (shipment row)",
  secondary_order_evidence: "newer full amazon_removals detail upload/API row",
  stale_partial_marker: "stale_partial_snapshot / superseded partial detail",
  disagreement_policy: "do_not_auto_pick_claim_quantity_when_sources_disagree",
  clean_quantity_policy: "sum only clean build_status rows unless source priority explicitly promotes a row",
} as const;

export function hasAmazonSourceMismatch(buildStatuses: string[]): boolean {
  return buildStatuses.some((s) => {
    const n = normStatus(s);
    return (
      n === "shipment_overflow_conflict" ||
      n === "source_conflict" ||
      n === "stale_partial_snapshot" ||
      n === "duplicate_source_conflict" ||
      n === "detail_remainder"
    );
  });
}
