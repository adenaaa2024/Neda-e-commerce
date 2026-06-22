/**
 * Phase 1 — Returns report scanner-operation columns (read-only derivations).
 * Uses list payloads already loaded on `/returns` — no extra queries, no schema changes.
 */

import type { PackageRecord, PalletRecord, ReturnRecord } from "@/app/returns/returns-action-types";
import { isPhysicalReturnItemForClaims } from "@/lib/return-item-physical-scan";
import { packageStatusIsClosed, returnHasScannerPhotoEvidence } from "@/lib/returns-claims-work-queue";
import { returnItemNotesMarkOffSlip } from "@/lib/scanner/item-scan-off-slip";
import { readBoxSlipEvidenceReview } from "@/lib/scanner/package-box-slip-evidence";
import {
  parseOperatorItemScanFromManifestData,
  type OperatorItemScanManifest,
} from "@/lib/scanner/package-operator-item-scan";
import { readMissingReviewEntries } from "@/lib/scanner/package-missing-review-manifest";

export type ItemScanSourceLabel = "Scanner" | "Packing Slip" | "Expected" | "Manual" | "Unknown";

export type ItemExceptionBadgeLabel =
  | "Only Slip"
  | "Only Shipment"
  | "Missing"
  | "Over"
  | "Voided";

export type PackageSlipReviewLabel =
  | "Not uploaded"
  | "Needs review"
  | "Confirmed"
  | "Edited"
  | "Unreadable";

export type ReturnItemScannerRow = {
  boxCode: string | null;
  palletNumber: string | null;
  scanSource: ItemScanSourceLabel | null;
  exceptionBadge: ItemExceptionBadgeLabel | null;
};

export type PackageScannerRow = {
  expected: number | null;
  scanned: number;
  missing: number | null;
  markedMissing: number | null;
  slipReview: PackageSlipReviewLabel | null;
  lastOperatorId: string | null;
  lastActivityAt: string | null;
};

/** Human-readable issue categories surfaced on the Pallets tab Issues column. */
export type PalletIssueLabel =
  | "Missing units"
  | "Marked missing"
  | "Open box"
  | "Slip review"
  | "Discrepancy";

export type PalletScannerRow = {
  boxesClosed: number;
  boxesTotal: number;
  expected: number | null;
  scanned: number;
  missing: number | null;
  issues: number;
  /** Deduped issue categories present on this pallet (derived from packages that count toward `issues`). */
  issueLabels: PalletIssueLabel[];
  lastOperatorId: string | null;
  lastActivityAt: string | null;
};

export type PalletIssuesDisplay = {
  primaryLabel: string;
  title: string;
  kind: "muted" | "warn";
  /** Extra compact type badges when multiple issue categories apply (display labels). */
  typeBadges: string[];
};

/** UI-facing issue labels — does not affect issue detection/counting. */
const ISSUE_LABEL_DISPLAY: Record<PalletIssueLabel, string> = {
  "Missing units": "Missing",
  "Marked missing": "Marked missing",
  "Open box": "Open box",
  "Slip review": "Slip review",
  Discrepancy: "Qty mismatch",
};

function toIssueDisplayLabels(labels: PalletIssueLabel[]): string[] {
  return labels.map((label) => ISSUE_LABEL_DISPLAY[label]);
}

export type ReturnsReportScannerIndex = {
  itemByReturnId: Map<string, ReturnItemScannerRow>;
  packageById: Map<string, PackageScannerRow>;
  palletById: Map<string, PalletScannerRow>;
  /** Operator UUIDs referenced by last-operator cells — batch-resolve with useProfileNames. */
  extraOperatorIds: string[];
};

function normKey(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

function manifestBlob(pkg: PackageRecord): unknown {
  const raw = (pkg as PackageRecord & { manifest_data_raw?: unknown }).manifest_data_raw;
  if (raw != null) return raw;
  const md = pkg.manifest_data;
  if (md != null && typeof md === "object" && !Array.isArray(md)) return md;
  return null;
}

function slipProductKeys(pkg: PackageRecord): Set<string> {
  const keys = new Set<string>();
  const add = (...vals: unknown[]) => {
    for (const v of vals) {
      const k = normKey(v);
      if (k) keys.add(k);
    }
  };

  const arr = Array.isArray(pkg.manifest_data) ? pkg.manifest_data : [];
  for (const line of arr) {
    add(line.sku, line.fnsku, line.asin, line.description);
  }

  const review = readBoxSlipEvidenceReview(manifestBlob(pkg));
  if (review) {
    for (const line of review.lines) {
      add(line.sku, line.fnsku, line.printed_asin, line.upc, line.description);
    }
  }

  return keys;
}

function itemMatchesSlip(item: ReturnRecord, slipKeys: Set<string>): boolean {
  if (slipKeys.size === 0) return false;
  return [item.fnsku, item.sku, item.asin, item.product_identifier, item.item_name].some((v) => {
    const k = normKey(v);
    if (!k) return false;
    if (slipKeys.has(k)) return true;
    for (const sk of slipKeys) {
      if (k.length >= 4 && (k.includes(sk) || sk.includes(k))) return true;
    }
    return false;
  });
}

function notesMarkVoided(notes: string | null | undefined): boolean {
  return /\bvoided\b/i.test(String(notes ?? ""));
}

function notesMarkMissing(notes: string | null | undefined): boolean {
  const s = String(notes ?? "").trim();
  if (!s) return false;
  if (/missing_expected/i.test(s)) return true;
  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      return o.type === "missing_expected" || o.missing === true;
    } catch {
      return false;
    }
  }
  return false;
}

export function deriveItemScanSource(
  item: ReturnRecord,
  pkg: PackageRecord | null | undefined,
): ItemScanSourceLabel | null {
  const hasOperator = Boolean(item.created_by?.trim());
  const hasPackage = Boolean(item.package_id);
  const hasExpectedLink = Boolean(item.expected_item_id?.trim());
  const scannerEvidence = returnHasScannerPhotoEvidence(item.photo_evidence);
  const slipKeys = pkg ? slipProductKeys(pkg) : new Set<string>();
  const onSlip = pkg ? itemMatchesSlip(item, slipKeys) : false;

  if (scannerEvidence || (hasOperator && hasPackage && isPhysicalReturnItemForClaims(item))) {
    return "Scanner";
  }
  if (hasExpectedLink) return "Expected";
  if (onSlip && slipKeys.size > 0) return "Packing Slip";
  if (hasOperator && !hasPackage) return "Manual";
  if (hasOperator) return "Manual";
  if (hasPackage) return "Scanner";
  return "Unknown";
}

export function deriveItemExceptionBadge(
  item: ReturnRecord,
  pkg: PackageRecord | null | undefined,
  opts?: { overScanReturnItemIds?: Set<string> },
): ItemExceptionBadgeLabel | null {
  if (notesMarkVoided(item.notes)) return "Voided";
  if (opts?.overScanReturnItemIds?.has(item.id)) return "Over";
  if (notesMarkMissing(item.notes)) return "Missing";
  if (returnItemNotesMarkOffSlip(item.notes)) return "Only Shipment";

  const hasExpectedLink = Boolean(item.expected_item_id?.trim());
  const slipKeys = pkg ? slipProductKeys(pkg) : new Set<string>();
  const onSlip = pkg ? itemMatchesSlip(item, slipKeys) : false;
  if (onSlip && slipKeys.size > 0 && !hasExpectedLink && !returnItemNotesMarkOffSlip(item.notes)) {
    return "Only Slip";
  }

  return null;
}

function sumMarkedMissingQty(manifestRaw: unknown, ois: OperatorItemScanManifest): number {
  let sum = 0;
  for (const entry of readMissingReviewEntries(manifestRaw)) {
    sum += Math.max(0, Math.floor(entry.operator_marked_missing_qty));
  }
  for (const entry of Object.values(ois.missing_review.by_slip_content_id)) {
    sum += Math.max(0, Math.floor(entry.marked_missing_qty));
  }
  return sum;
}

export function derivePackageSlipReview(pkg: PackageRecord): PackageSlipReviewLabel | null {
  const hasSlipPhotos = (pkg.slip_photo_urls?.length ?? 0) > 0;
  const review = readBoxSlipEvidenceReview(manifestBlob(pkg));

  if (!hasSlipPhotos && !review) return "Not uploaded";
  if (review?.status === "unreadable") return "Unreadable";
  if (review?.status === "confirmed") return "Confirmed";
  const edited =
    Boolean(review?.edited_at?.trim()) ||
    Boolean(review?.lines.some((l) => (l.line_audit?.edited_fields?.length ?? 0) > 0));
  if (edited) return "Edited";
  if (
    review?.status === "needs_review" ||
    review?.status === "detected" ||
    review?.status === "draft"
  ) {
    return "Needs review";
  }
  if (hasSlipPhotos) return "Needs review";
  return null;
}

function latestActivityOnPackage(
  pkg: PackageRecord,
  items: ReturnRecord[],
): { operatorId: string | null; at: string | null } {
  let bestItem: ReturnRecord | null = null;
  for (const r of items) {
    if (!bestItem || r.updated_at > bestItem.updated_at) bestItem = r;
  }
  const itemAt = bestItem?.updated_at ?? null;
  const pkgAt = pkg.updated_at ?? null;
  const useItem = itemAt && (!pkgAt || itemAt >= pkgAt);
  return {
    operatorId: useItem
      ? (bestItem?.updated_by ?? bestItem?.created_by ?? null)
      : (pkg.updated_by ?? pkg.created_by ?? null),
    at: useItem ? itemAt : pkgAt,
  };
}

const PALLET_ISSUE_LABEL_ORDER: PalletIssueLabel[] = [
  "Missing units",
  "Marked missing",
  "Open box",
  "Slip review",
  "Discrepancy",
];

/** Issue categories for one package — mirrors prior `packageHasIssue` predicates (labels only). */
function packageIssueLabels(pkg: PackageRecord, summary: PackageScannerRow): PalletIssueLabel[] {
  const labels = new Set<PalletIssueLabel>();
  if (pkg.status === "suspicious" || pkg.discrepancy_note?.trim()) labels.add("Discrepancy");
  if ((summary.markedMissing ?? 0) > 0) labels.add("Marked missing");
  if (summary.slipReview === "Needs review" || summary.slipReview === "Unreadable") {
    labels.add("Slip review");
  }
  if (
    summary.expected != null &&
    summary.expected > 0 &&
    summary.scanned < summary.expected &&
    !packageStatusIsClosed(pkg.status)
  ) {
    labels.add("Missing units");
  }
  return PALLET_ISSUE_LABEL_ORDER.filter((l) => labels.has(l));
}

function packageHasIssue(pkg: PackageRecord, summary: PackageScannerRow): boolean {
  return packageIssueLabels(pkg, summary).length > 0;
}

/** Issue categories for one package — read-only; mirrors `packageHasIssue` predicates. */
export function derivePackageIssueLabels(
  pkg: PackageRecord,
  summary: PackageScannerRow | null | undefined,
): PalletIssueLabel[] {
  if (!summary) return [];
  return packageIssueLabels(pkg, summary);
}

/** Compact Issues cell copy + tooltip for the Boxes report table. */
export function formatPackageIssuesDisplay(
  pkg: PackageRecord,
  summary: PackageScannerRow | null | undefined,
): PalletIssuesDisplay {
  const labels = derivePackageIssueLabels(pkg, summary);
  const displayLabels = toIssueDisplayLabels(labels);

  if (labels.length <= 0) {
    return {
      primaryLabel: "—",
      title: summary ? "No issues" : "",
      kind: "muted",
      typeBadges: [],
    };
  }

  if (labels.length === 1) {
    return {
      primaryLabel: displayLabels[0],
      title: displayLabels[0],
      kind: "warn",
      typeBadges: [],
    };
  }

  const title = displayLabels.join(", ");
  return {
    primaryLabel: `${labels.length} issues`,
    title,
    kind: "warn",
    typeBadges: displayLabels.slice(0, 2),
  };
}

/** Compact Issues cell copy + tooltip for the Pallets report table. */
export function formatPalletIssuesDisplay(row: PalletScannerRow | null | undefined): PalletIssuesDisplay {
  if (!row || row.issues <= 0) {
    return {
      primaryLabel: "—",
      title: row && row.boxesTotal > 0 ? "No issues" : "",
      kind: "muted",
      typeBadges: [],
    };
  }

  const types = row.issueLabels;
  const displayTypes = toIssueDisplayLabels(types);
  const boxWord = row.issues === 1 ? "box" : "boxes";
  const fallbackTitle = `${row.issues} ${boxWord} with scanner discrepancies`;
  const title = types.length > 0 ? displayTypes.join(", ") : fallbackTitle;

  if (row.issues === 1 && types.length === 1) {
    return { primaryLabel: displayTypes[0], title, kind: "warn", typeBadges: [] };
  }

  const countLabel = row.issues === 1 ? "1 issue" : `${row.issues} issues`;
  return {
    primaryLabel: countLabel,
    title,
    kind: "warn",
    typeBadges: displayTypes.length > 1 ? displayTypes.slice(0, 2) : displayTypes,
  };
}

function buildOverScanReturnItemIds(
  packages: PackageRecord[],
  returns: ReturnRecord[],
): Set<string> {
  const over = new Set<string>();
  const byPackage = new Map<string, ReturnRecord[]>();
  for (const r of returns) {
    if (!r.package_id) continue;
    const list = byPackage.get(r.package_id) ?? [];
    list.push(r);
    byPackage.set(r.package_id, list);
  }

  for (const pkg of packages) {
    const expected = pkg.expected_item_count > 0 ? pkg.expected_item_count : null;
    if (expected == null) continue;
    const items = byPackage.get(pkg.id) ?? [];
    const scanned = items.length;
    if (scanned > expected) {
      for (const r of items) over.add(r.id);
    }
  }
  return over;
}

/** Single-pass indexes for Items / Packages / Pallets scanner columns — O(n) over loaded rows. */
export function buildReturnsReportScannerIndex(input: {
  returns: ReturnRecord[];
  packages: PackageRecord[];
  pallets: PalletRecord[];
}): ReturnsReportScannerIndex {
  const pkgMap = new Map(input.packages.map((p) => [p.id, p]));
  const pltMap = new Map(input.pallets.map((p) => [p.id, p]));
  const returnsByPackage = new Map<string, ReturnRecord[]>();
  const returnsByPallet = new Map<string, ReturnRecord[]>();

  for (const r of input.returns) {
    if (r.package_id) {
      const list = returnsByPackage.get(r.package_id) ?? [];
      list.push(r);
      returnsByPackage.set(r.package_id, list);
    }
    if (r.pallet_id) {
      const list = returnsByPallet.get(r.pallet_id) ?? [];
      list.push(r);
      returnsByPallet.set(r.pallet_id, list);
    }
  }

  const overScanReturnItemIds = buildOverScanReturnItemIds(input.packages, input.returns);

  const itemByReturnId = new Map<string, ReturnItemScannerRow>();
  for (const item of input.returns) {
    const pkg = item.package_id ? pkgMap.get(item.package_id) : undefined;
    const plt = item.pallet_id ? pltMap.get(item.pallet_id) : undefined;
    itemByReturnId.set(item.id, {
      boxCode: pkg?.package_code ?? null,
      palletNumber: plt?.pallet_number ?? null,
      scanSource: deriveItemScanSource(item, pkg),
      exceptionBadge: deriveItemExceptionBadge(item, pkg, { overScanReturnItemIds }),
    });
  }

  const packageById = new Map<string, PackageScannerRow>();
  const extraOperatorIds: string[] = [];
  const pushOperatorId = (id: string | null | undefined) => {
    const t = id?.trim();
    if (t) extraOperatorIds.push(t);
  };

  for (const pkg of input.packages) {
    const items = returnsByPackage.get(pkg.id) ?? [];
    const scanned = items.length;
    const expected = pkg.expected_item_count > 0 ? pkg.expected_item_count : null;
    const manifestRaw = manifestBlob(pkg);
    const ois = parseOperatorItemScanFromManifestData(manifestRaw ?? pkg.manifest_data);
    const markedMissing = sumMarkedMissingQty(manifestRaw, ois);
    const missing =
      expected != null ? Math.max(0, expected - scanned - markedMissing) : null;
    const activity = latestActivityOnPackage(pkg, items);
    pushOperatorId(activity.operatorId);

    const row: PackageScannerRow = {
      expected,
      scanned,
      missing,
      markedMissing: markedMissing > 0 ? markedMissing : null,
      slipReview: derivePackageSlipReview(pkg),
      lastOperatorId: activity.operatorId,
      lastActivityAt: activity.at,
    };
    packageById.set(pkg.id, row);
  }

  const palletById = new Map<string, PalletScannerRow>();
  for (const plt of input.pallets) {
    const pkgsOnPallet = input.packages.filter((p) => p.pallet_id === plt.id);
    const itemsOnPallet = returnsByPallet.get(plt.id) ?? [];
    let boxesClosed = 0;
    let expectedSum = 0;
    let hasExpected = false;
    let scannedSum = 0;
    let missingSum = 0;
    let hasMissing = false;
    let issues = 0;
    const issueLabelSet = new Set<PalletIssueLabel>();

    for (const pkg of pkgsOnPallet) {
      if (packageStatusIsClosed(pkg.status)) boxesClosed += 1;
      const ps = packageById.get(pkg.id);
      if (ps) {
        if (ps.expected != null) {
          hasExpected = true;
          expectedSum += ps.expected;
        }
        scannedSum += ps.scanned;
        if (ps.missing != null) {
          hasMissing = true;
          missingSum += ps.missing;
        }
        if (packageHasIssue(pkg, ps)) {
          issues += 1;
          for (const label of packageIssueLabels(pkg, ps)) issueLabelSet.add(label);
        }
      }
    }

    if (issues > 0 && boxesClosed < pkgsOnPallet.length) {
      issueLabelSet.add("Open box");
    }

    const issueLabels = PALLET_ISSUE_LABEL_ORDER.filter((l) => issueLabelSet.has(l));

    let bestItem: ReturnRecord | null = null;
    for (const r of itemsOnPallet) {
      if (!bestItem || r.updated_at > bestItem.updated_at) bestItem = r;
    }
    const pltAt = plt.updated_at ?? null;
    const itemAt = bestItem?.updated_at ?? null;
    const useItem = itemAt && (!pltAt || itemAt >= pltAt);
    const lastOperatorId = useItem
      ? (bestItem?.updated_by ?? bestItem?.created_by ?? null)
      : (plt.updated_by ?? plt.created_by ?? null);
    const lastActivityAt = useItem ? itemAt : pltAt;
    pushOperatorId(lastOperatorId);

    palletById.set(plt.id, {
      boxesClosed,
      boxesTotal: pkgsOnPallet.length,
      expected: hasExpected ? expectedSum : null,
      scanned: scannedSum,
      missing: hasMissing ? missingSum : null,
      issues,
      issueLabels,
      lastOperatorId,
      lastActivityAt,
    });
  }

  return { itemByReturnId, packageById, palletById, extraOperatorIds };
}

export function formatReportCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return String(Math.max(0, Math.floor(value)));
}

/** Tailwind classes for compact scanner report pills (Menorix returns tables). */
export function scannerReportPillClass(kind: "neutral" | "info" | "warn" | "ok" | "muted"): string {
  switch (kind) {
    case "info":
      return "border-[rgba(138,104,31,0.22)] bg-[#EEE8DC] text-[#4C5661] dark:border-[rgba(214,183,110,0.24)] dark:bg-[#232C35] dark:text-[#B8C1CB]";
    case "warn":
      return "border-[rgba(138,104,31,0.26)] bg-[#F5E9D2] text-[#6A4C16] dark:border-[rgba(214,183,110,0.30)] dark:bg-[#312613] dark:text-[#EFD49A]";
    case "ok":
      return "border-emerald-200/80 bg-emerald-50 text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200";
    case "muted":
      return "border-[rgba(138,104,31,0.14)] bg-[#F2EEE5] text-[#737C86] dark:border-[rgba(214,183,110,0.16)] dark:bg-[#20272F] dark:text-[#7E8894]";
    default:
      return "border-[rgba(138,104,31,0.18)] bg-[#EFE6D2] text-[#6C5320] dark:border-[rgba(214,183,110,0.22)] dark:bg-[#2A2418] dark:text-[#E8CF98]";
  }
}

export function slipReviewPillKind(label: PackageSlipReviewLabel | null): "neutral" | "info" | "warn" | "ok" | "muted" {
  switch (label) {
    case "Confirmed":
      return "ok";
    case "Needs review":
    case "Unreadable":
      return "warn";
    case "Edited":
      return "info";
    case "Not uploaded":
      return "muted";
    default:
      return "neutral";
  }
}

export function exceptionBadgePillKind(label: ItemExceptionBadgeLabel | null): "neutral" | "info" | "warn" | "ok" | "muted" {
  switch (label) {
    case "Over":
    case "Missing":
    case "Voided":
      return "warn";
    case "Only Shipment":
    case "Only Slip":
      return "info";
    default:
      return "neutral";
  }
}
