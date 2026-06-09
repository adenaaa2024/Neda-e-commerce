import type { OperatorPackageItemRow } from "@/app/scanner/operator-mobile/_components/operator-store-actions";
import {
  filterPackageItemDiscrepancyTags,
  ITEM_UNIT_SELLABLE_OK_TAG,
  normalizeItemUnitDiscrepancySelection,
  type ItemUnitDiscrepancyTagKey,
} from "@/lib/scanner/item-unit-discrepancy-tags";

/** Max gap between consecutive units in the same inferred batch save (ms). */
export const ITEM_SCAN_UNIT_GROUP_TIME_WINDOW_MS = 60_000;

export type ItemScanUnitGroup = {
  /** Stable key for React list rendering. */
  id: string;
  units: OperatorPackageItemRow[];
};

function unitConditionTags(unit: OperatorPackageItemRow): ItemUnitDiscrepancyTagKey[] {
  const tags = filterPackageItemDiscrepancyTags(unit.discrepancy_tags);
  return normalizeItemUnitDiscrepancySelection(
    tags.length ? tags : [ITEM_UNIT_SELLABLE_OK_TAG],
  );
}

function returnItemWasEditedAfterCreate(
  createdAt: string | null | undefined,
  updatedAt: string | null | undefined,
): boolean {
  const c = String(createdAt ?? "").trim();
  const u = String(updatedAt ?? "").trim();
  if (!c || !u) return false;
  const ct = new Date(c).getTime();
  const ut = new Date(u).getTime();
  if (Number.isNaN(ct) || Number.isNaN(ut)) return false;
  return ut - ct > 2000;
}

function parseCreatedAtMs(iso: string | null | undefined): number {
  const s = String(iso ?? "").trim();
  if (!s) return 0;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function evidenceFingerprint(unit: OperatorPackageItemRow): string {
  const urls = (unit.evidence_urls ?? []).map((u) => String(u ?? "").trim()).filter(Boolean);
  const itemPhoto = unit.optional_item_photo_url?.trim() ?? "";
  return `${urls.length}:${urls.join("|")}|item:${itemPhoto}`;
}

/** Stable fingerprint for batch grouping — identical rows from one save share this key. */
export function itemScanUnitGroupFingerprint(unit: OperatorPackageItemRow): string {
  const tags = unitConditionTags(unit);
  const conditionKey = tags.slice().sort().join(",");
  const slipId = String(unit.slip_content_id ?? "").trim() || "unexpected";
  const identity = [
    slipId,
    unit.scanned_barcode?.trim() ?? "",
    unit.fnsku?.trim() ?? "",
    unit.sku?.trim() ?? "",
    unit.product_identifier?.trim() ?? "",
  ].join("|");
  const expiry = unit.expiry_date?.trim() ?? "";
  const lot = unit.lot_number?.trim() ?? "";
  const notes = unit.operator_notes?.trim() ?? "";
  const createdBy = String(unit.created_by ?? "").trim();
  const edited = returnItemWasEditedAfterCreate(unit.created_at, unit.updated_at)
    ? `${String(unit.updated_at ?? "").trim()}|${String(unit.updated_by ?? "").trim()}`
    : "";
  return [
    identity,
    conditionKey,
    expiry,
    lot,
    evidenceFingerprint(unit),
    notes,
    createdBy,
    edited,
  ].join("::");
}

function sortUnitsForGrouping(units: OperatorPackageItemRow[]): OperatorPackageItemRow[] {
  return [...units].sort((a, b) => {
    const ta = parseCreatedAtMs(a.created_at);
    const tb = parseCreatedAtMs(b.created_at);
    if (ta !== tb) return ta - tb;
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });
}

/**
 * Group hydrated return_item rows that likely came from the same batch save.
 * DB still stores one row per physical unit; this is UI-only clustering.
 */
export function groupItemScanUnitsForEditPicker(
  units: OperatorPackageItemRow[],
  timeWindowMs: number = ITEM_SCAN_UNIT_GROUP_TIME_WINDOW_MS,
): ItemScanUnitGroup[] {
  if (units.length === 0) return [];

  const sorted = sortUnitsForGrouping(units);
  const groups: ItemScanUnitGroup[] = [];

  for (const unit of sorted) {
    const fingerprint = itemScanUnitGroupFingerprint(unit);
    const createdMs = parseCreatedAtMs(unit.created_at);
    const last = groups[groups.length - 1];

    if (last) {
      const lastUnit = last.units[last.units.length - 1]!;
      const lastFingerprint = itemScanUnitGroupFingerprint(lastUnit);
      const lastCreatedMs = parseCreatedAtMs(lastUnit.created_at);
      const withinWindow =
        createdMs > 0 && lastCreatedMs > 0 && createdMs - lastCreatedMs <= timeWindowMs;

      if (fingerprint === lastFingerprint && withinWindow) {
        last.units.push(unit);
        continue;
      }
    }

    groups.push({
      id: String(unit.id ?? fingerprint),
      units: [unit],
    });
  }

  return groups;
}

export function itemScanUnitGroupCountLabel(count: number): string {
  const n = Math.max(0, Math.floor(count));
  return n === 1 ? "1 unit" : `${n} units`;
}
