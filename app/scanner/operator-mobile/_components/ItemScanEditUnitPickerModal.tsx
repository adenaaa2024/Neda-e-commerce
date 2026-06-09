"use client";

import { useMemo } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { OperatorPackageItemRow } from "@/app/scanner/operator-mobile/_components/operator-store-actions";
import { auditUserDisplayLabel } from "@/lib/operator-audit-display";
import {
  groupItemScanUnitsForEditPicker,
  itemScanUnitGroupCountLabel,
  type ItemScanUnitGroup,
} from "@/lib/scanner/item-scan-unit-groups";
import {
  filterPackageItemDiscrepancyTags,
  ITEM_UNIT_SELLABLE_OK_TAG,
  normalizeItemUnitDiscrepancySelection,
  type ItemUnitDiscrepancyTagKey,
} from "@/lib/scanner/item-unit-discrepancy-tags";

/** Compact local timestamp for unit picker audit lines (MM/DD HH:mm). */
function formatItemScanAuditAt(iso: string | null | undefined): string | null {
  const s = String(iso ?? "").trim();
  if (!s) return null;
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${mm}/${dd} ${hh}:${min}`;
  } catch {
    return null;
  }
}

function formatExpiryDateLabel(raw: string): string {
  const s = raw.trim().slice(0, 32);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const yyyy = d.getFullYear();
      return `${mm}/${dd}/${yyyy}`;
    }
  }
  return s;
}

function titleCaseConditionTag(tag: ItemUnitDiscrepancyTagKey): string {
  return tag
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

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

export type ItemScanUnitSummaryLines = {
  line1: string;
  line2: string;
};

export function itemScanUnitSummaryLines(unit: OperatorPackageItemRow): ItemScanUnitSummaryLines {
  const selected = unitConditionTags(unit);
  const condition = selected.map(titleCaseConditionTag).join(", ");
  const hasExpired = selected.includes("expired");
  const exp = unit.expiry_date?.trim() ?? "";
  let expiryLabel: string;
  if (exp) {
    expiryLabel = `Expiry: ${formatExpiryDateLabel(exp)}`;
  } else if (hasExpired) {
    expiryLabel = "Expiry: no date on packaging";
  } else {
    expiryLabel = "Expiry: not recorded";
  }

  const evidenceCount = (unit.evidence_urls ?? []).length;
  const evidencePart =
    evidenceCount === 0
      ? "Evidence: none"
      : evidenceCount === 1
        ? "Evidence: 1 photo"
        : `Evidence: ${evidenceCount} photos`;
  const itemPhotoPart = unit.optional_item_photo_url?.trim() ? "Item photo: 1" : "Item photo: none";
  const notesPart = unit.operator_notes?.trim() ? "Notes: yes" : null;
  const line2 = [evidencePart, itemPhotoPart, notesPart].filter(Boolean).join(" · ");

  return {
    line1: `${condition} · ${expiryLabel}`,
    line2,
  };
}

export type ItemScanUnitAuditLines = {
  created: string;
  edited: string | null;
};

export function itemScanUnitAuditLines(unit: OperatorPackageItemRow): ItemScanUnitAuditLines {
  const createdAt = formatItemScanAuditAt(unit.created_at);
  const createdBy = auditUserDisplayLabel(unit.created_by, unit.created_by_display);
  const created = createdAt
    ? `Created ${createdAt} by ${createdBy}`
    : `Created by ${createdBy}`;

  if (!returnItemWasEditedAfterCreate(unit.created_at, unit.updated_at)) {
    return { created, edited: null };
  }

  const editedAt = formatItemScanAuditAt(unit.updated_at);
  const editedBy = auditUserDisplayLabel(unit.updated_by, unit.updated_by_display);
  const edited =
    editedAt && String(unit.updated_by ?? "").trim()
      ? `Edited ${editedAt} by ${editedBy}`
      : editedAt
        ? `Edited ${editedAt}`
        : `Edited by ${editedBy}`;

  return { created, edited };
}

function groupRepresentativeUnit(group: ItemScanUnitGroup): OperatorPackageItemRow {
  return group.units[0]!;
}

function groupConditionLabel(group: ItemScanUnitGroup): string {
  const rep = groupRepresentativeUnit(group);
  const selected = unitConditionTags(rep);
  return selected.map(titleCaseConditionTag).join(", ");
}

function groupExpiryLabel(group: ItemScanUnitGroup): string {
  const rep = groupRepresentativeUnit(group);
  const selected = unitConditionTags(rep);
  const hasExpired = selected.includes("expired");
  const exp = rep.expiry_date?.trim() ?? "";
  if (exp) return `Expiry: ${formatExpiryDateLabel(exp)}`;
  if (hasExpired) return "Expiry: no date on packaging";
  return "Expiry: not recorded";
}

function groupEvidenceLabel(group: ItemScanUnitGroup): string {
  const rep = groupRepresentativeUnit(group);
  const evidenceCount = (rep.evidence_urls ?? []).length;
  const evidencePart =
    evidenceCount === 0
      ? "Evidence: none"
      : evidenceCount === 1
        ? "Evidence: 1 photo"
        : `Evidence: ${evidenceCount} photos`;
  const notesPart = rep.operator_notes?.trim() ? "Notes: yes" : null;
  return [evidencePart, notesPart].filter(Boolean).join(" · ");
}

function groupAuditLines(group: ItemScanUnitGroup): ItemScanUnitAuditLines {
  return itemScanUnitAuditLines(groupRepresentativeUnit(group));
}

type ItemScanEditUnitPickerModalProps = {
  open: boolean;
  rowTitle: string;
  rowSubtitle: string | null;
  units: OperatorPackageItemRow[];
  busy: boolean;
  onEditGroup: (group: ItemScanUnitGroup) => void;
  onDeleteGroup: (group: ItemScanUnitGroup) => void;
  onClose: () => void;
};

export function ItemScanEditUnitPickerModal({
  open,
  rowTitle,
  rowSubtitle,
  units,
  busy,
  onEditGroup,
  onDeleteGroup,
  onClose,
}: ItemScanEditUnitPickerModalProps) {
  const groups = useMemo(() => groupItemScanUnitsForEditPicker(units), [units]);

  if (!open) return null;

  const empty = units.length === 0;
  const totalUnits = units.length;
  const groupCount = groups.length;

  return (
    <div
      className="operator-shipment-flow-modal operator-item-scan-unit-picker-modal fixed inset-0 z-[145] flex items-end justify-center p-4 pb-[max(calc(5.25rem+env(safe-area-inset-bottom)),1.25rem)] sm:items-center sm:pb-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="item-scan-unit-picker-title"
    >
      <div className="operator-shipment-flow-modal__panel operator-item-scan-unit-picker__panel flex max-h-[min(72vh,32rem)] w-full max-w-md flex-col overflow-hidden rounded-[24px] border p-0">
        <div className="operator-item-scan-unit-picker__header shrink-0 border-b px-4 pb-3.5 pt-4">
          <p
            id="item-scan-unit-picker-title"
            className="operator-shipment-flow-modal__title operator-item-scan-unit-picker__title text-center text-[16px] font-black leading-snug tracking-tight"
          >
            Choose batch to edit
          </p>
          <p className="operator-item-scan-unit-picker__product mt-2 text-center text-[13px] font-semibold leading-snug">
            {rowTitle}
          </p>
          {rowSubtitle ? (
            <p className="operator-item-scan-unit-picker__fnsku mt-1.5 text-center font-mono text-[10px] font-medium leading-snug tracking-wide">
              {rowSubtitle}
            </p>
          ) : null}
          {!empty && groupCount > 0 ? (
            <p className="operator-item-scan-unit-picker__summary mt-2 text-center text-[11px] font-semibold leading-snug">
              {totalUnits === 1
                ? "1 unit in 1 group"
                : `${totalUnits} units in ${groupCount} group${groupCount === 1 ? "" : "s"}`}
            </p>
          ) : null}
        </div>

        <div className="operator-item-scan-unit-picker__body min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 py-2.5">
          {empty ? (
            <p
              className="operator-item-scan-unit-picker__empty rounded-xl border px-3 py-3 text-center text-[12px] font-semibold leading-relaxed"
              role="status"
            >
              No saved scanned units found for this item.
            </p>
          ) : (
            <ul className="operator-item-scan-unit-picker__list space-y-2.5">
              {groups.map((group) => {
                const condition = groupConditionLabel(group);
                const countLabel = itemScanUnitGroupCountLabel(group.units.length);
                const expiryLabel = groupExpiryLabel(group);
                const evidenceLabel = groupEvidenceLabel(group);
                const audit = groupAuditLines(group);
                return (
                  <li key={group.id}>
                    <div className="operator-item-scan-unit-picker__unit-card flex w-full min-h-[52px] flex-col gap-1 rounded-lg border px-3 py-2.5 text-left">
                      <span className="operator-item-scan-unit-picker__unit-head flex min-w-0 flex-wrap items-start justify-between gap-x-2 gap-y-1.5">
                        <span className="operator-item-scan-unit-picker__unit-label shrink-0 text-[12px] font-black leading-snug">
                          {condition}
                          <span className="operator-item-scan-unit-picker__summary ml-1.5 font-bold">
                            · {countLabel}
                          </span>
                        </span>
                        <span className="operator-item-scan-unit-picker__unit-actions flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              onEditGroup(group);
                            }}
                            className="operator-item-scan-unit-picker__edit-btn inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1 text-[9px] font-bold uppercase tracking-wide transition active:scale-95 disabled:opacity-40"
                          >
                            <Pencil className="h-2.5 w-2.5 shrink-0" strokeWidth={2.25} aria-hidden />
                            Edit group
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              onDeleteGroup(group);
                            }}
                            className="operator-item-scan-unit-picker__delete-btn inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1 text-[9px] font-bold uppercase tracking-wide transition active:scale-95 disabled:opacity-40"
                            aria-label={`Delete ${countLabel}`}
                          >
                            <Trash2 className="h-2.5 w-2.5 shrink-0" strokeWidth={2.25} aria-hidden />
                            Delete group
                          </button>
                        </span>
                      </span>
                      <span className="operator-item-scan-unit-picker__summary text-[10px] font-medium leading-snug">
                        {expiryLabel}
                      </span>
                      <span className="operator-item-scan-unit-picker__summary operator-item-scan-unit-picker__summary--muted text-[9px] leading-snug">
                        {evidenceLabel}
                      </span>
                      <span className="operator-item-scan-unit-picker__audit mt-0.5 text-[9px] leading-snug">
                        {audit.created}
                      </span>
                      {audit.edited ? (
                        <span className="operator-item-scan-unit-picker__audit text-[9px] leading-snug">
                          {audit.edited}
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="operator-item-scan-unit-picker__footer shrink-0 border-t px-4 py-3.5">
          <button
            type="button"
            disabled={busy}
            className="operator-shipment-flow-modal__btn-secondary operator-item-scan-unit-picker__close-btn h-10 w-full rounded-xl border text-[13px] font-bold transition active:scale-[0.98] disabled:opacity-50"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
