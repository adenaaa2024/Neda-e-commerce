"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Loader2, Minus, Plus, Trash2, X } from "lucide-react";
import { OperatorScannerFooterActions } from "@/app/scanner/operator-mobile/_components/OperatorScannerFooterActions";
import {
  cloneBoxSlipEvidenceLines,
  type BoxSlipEvidenceLine,
} from "@/lib/scanner/package-box-slip-evidence";
import type { BoxSlipVisionLine } from "@/lib/scanner/box-slip-vision-parse";

export type BoxSlipLinesEditSavePayload = {
  lines: BoxSlipEvidenceLine[];
  note: string | null;
};

type BoxSlipLinesEditModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialLines: BoxSlipEvidenceLine[];
  ocrSnapshot: BoxSlipVisionLine[];
  initialNote?: string | null;
  busy?: boolean;
  onSave: (payload: BoxSlipLinesEditSavePayload) => Promise<void>;
};

function emptyLine(): BoxSlipEvidenceLine {
  return {
    upc: null,
    fnsku: null,
    sku: null,
    printed_asin: null,
    description: null,
    expected_qty: 1,
    condition: null,
    needs_review: false,
  };
}

function fieldValue(v: string | null | undefined): string {
  return v == null ? "" : String(v);
}

function truncateTitle(text: string | null | undefined, max = 56): string {
  const s = String(text ?? "").trim();
  if (!s) return "Untitled line";
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function bestSlipLineIdentifier(line: BoxSlipEvidenceLine): { label: string; value: string } {
  const fnsku = fieldValue(line.fnsku).trim();
  if (fnsku) return { label: "FNSKU", value: fnsku };
  const upc = fieldValue(line.upc).trim();
  if (upc) return { label: "UPC", value: upc };
  const sku = fieldValue(line.sku).trim();
  if (sku) return { label: "SKU", value: sku };
  const asin = fieldValue(line.printed_asin).trim();
  if (asin) return { label: "ASIN", value: asin };
  return { label: "ID", value: "—" };
}

function isBlankSlipLine(row: BoxSlipEvidenceLine): boolean {
  return (
    !fieldValue(row.upc).trim() &&
    !fieldValue(row.fnsku).trim() &&
    !fieldValue(row.sku).trim() &&
    !fieldValue(row.printed_asin).trim() &&
    !fieldValue(row.description).trim()
  );
}

function primaryIdentifierValue(row: BoxSlipEvidenceLine): string {
  const best = bestSlipLineIdentifier(row);
  return best.value === "—" ? "" : best.value;
}

function applyPrimaryIdentifier(row: BoxSlipEvidenceLine, raw: string): BoxSlipEvidenceLine {
  const id = raw.trim();
  if (!id) {
    return { ...row, upc: null, fnsku: null, sku: null, printed_asin: null };
  }
  if (/^B0[0-9A-Z]{8}$/i.test(id)) {
    return { ...row, printed_asin: id.toUpperCase(), fnsku: row.fnsku, upc: row.upc, sku: row.sku };
  }
  const digits = id.replace(/\D/g, "");
  if (digits.length >= 8 && digits.length <= 14 && /^\d+$/.test(digits)) {
    return { ...row, upc: digits.length === 12 ? digits : digits.slice(-12), fnsku: row.fnsku };
  }
  return { ...row, fnsku: id };
}

type SlipLineCardProps = {
  index: number;
  row: BoxSlipEvidenceLine;
  busy: boolean;
  expanded: boolean;
  onToggleAdvanced: () => void;
  onUpdate: (patch: Partial<BoxSlipEvidenceLine>) => void;
  onRemove: () => void;
};

function SlipLineCard({
  index,
  row,
  busy,
  expanded,
  onToggleAdvanced,
  onUpdate,
  onRemove,
}: SlipLineCardProps) {
  const blank = isBlankSlipLine(row);
  const ident = bestSlipLineIdentifier(row);
  const qty = Math.max(0, Math.floor(Number(row.expected_qty) || 0));

  const bumpQty = (delta: number) => {
    onUpdate({ expected_qty: Math.max(0, qty + delta) });
  };

  return (
    <div className="operator-slip-evidence-line-card">
      <div className="operator-slip-evidence-line-card__head">
        <p className="operator-slip-evidence-line-card__line-no">Line {index + 1}</p>
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          className="operator-slip-evidence-line-card__delete"
          aria-label={`Delete line ${index + 1}`}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {blank ? (
        <div className="operator-slip-evidence-line-card__blank-fields">
          <label className="operator-slip-evidence-field">
            <span className="operator-slip-evidence-field__label">Identifier</span>
            <input
              value={primaryIdentifierValue(row)}
              onChange={(e) => onUpdate(applyPrimaryIdentifier(row, e.target.value))}
              disabled={busy}
              placeholder="FNSKU, UPC, or SKU"
              className="operator-slip-evidence-field__input operator-slip-evidence-field__input--mono"
            />
          </label>
          <label className="operator-slip-evidence-field">
            <span className="operator-slip-evidence-field__label">Title (optional)</span>
            <input
              value={fieldValue(row.description)}
              onChange={(e) => onUpdate({ description: e.target.value || null })}
              disabled={busy}
              placeholder="Product title"
              className="operator-slip-evidence-field__input"
            />
          </label>
        </div>
      ) : (
        <div className="operator-slip-evidence-line-card__summary">
          <p className="operator-slip-evidence-line-card__title">{truncateTitle(row.description)}</p>
          <p className="operator-slip-evidence-line-card__ident">
            <span className="operator-slip-evidence-line-card__ident-label">{ident.label}</span>
            <span className="operator-slip-evidence-line-card__ident-value">{ident.value}</span>
          </p>
        </div>
      )}

      <div className="operator-slip-evidence-line-card__controls">
        <div className="operator-slip-evidence-qty-stepper" role="group" aria-label={`Line ${index + 1} quantity`}>
          <button
            type="button"
            onClick={() => bumpQty(-1)}
            disabled={busy || qty <= 0}
            className="operator-slip-evidence-qty-stepper__btn"
            aria-label="Decrease quantity"
          >
            <Minus className="h-4 w-4" />
          </button>
          <span className="operator-slip-evidence-qty-stepper__value tabular-nums">{qty}</span>
          <button
            type="button"
            onClick={() => bumpQty(1)}
            disabled={busy}
            className="operator-slip-evidence-qty-stepper__btn"
            aria-label="Increase quantity"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        <label className="operator-slip-evidence-needs-review">
          <input
            type="checkbox"
            checked={Boolean(row.needs_review)}
            onChange={(e) => onUpdate({ needs_review: e.target.checked })}
            disabled={busy}
            className="operator-slip-evidence-needs-review__check"
          />
          <span>Needs review</span>
        </label>
      </div>

      <button
        type="button"
        onClick={onToggleAdvanced}
        disabled={busy}
        className="operator-slip-evidence-advanced-toggle"
        aria-expanded={expanded}
      >
        <span>Advanced</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
      </button>

      {expanded ? (
        <div className="operator-slip-evidence-advanced-panel">
          <label className="operator-slip-evidence-field">
            <span className="operator-slip-evidence-field__label">UPC</span>
            <input
              value={fieldValue(row.upc)}
              onChange={(e) => onUpdate({ upc: e.target.value || null })}
              disabled={busy}
              className="operator-slip-evidence-field__input operator-slip-evidence-field__input--mono"
            />
          </label>
          <label className="operator-slip-evidence-field">
            <span className="operator-slip-evidence-field__label">FNSKU</span>
            <input
              value={fieldValue(row.fnsku)}
              onChange={(e) => onUpdate({ fnsku: e.target.value || null })}
              disabled={busy}
              className="operator-slip-evidence-field__input operator-slip-evidence-field__input--mono"
            />
          </label>
          <label className="operator-slip-evidence-field">
            <span className="operator-slip-evidence-field__label">SKU</span>
            <input
              value={fieldValue(row.sku)}
              onChange={(e) => onUpdate({ sku: e.target.value || null })}
              disabled={busy}
              className="operator-slip-evidence-field__input operator-slip-evidence-field__input--mono"
            />
          </label>
          <label className="operator-slip-evidence-field">
            <span className="operator-slip-evidence-field__label">ASIN</span>
            <input
              value={fieldValue(row.printed_asin)}
              onChange={(e) => onUpdate({ printed_asin: e.target.value || null })}
              disabled={busy}
              className="operator-slip-evidence-field__input operator-slip-evidence-field__input--mono"
            />
          </label>
          <label className="operator-slip-evidence-field">
            <span className="operator-slip-evidence-field__label">Title / description</span>
            <input
              value={fieldValue(row.description)}
              onChange={(e) => onUpdate({ description: e.target.value || null })}
              disabled={busy}
              className="operator-slip-evidence-field__input"
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}

export function BoxSlipLinesEditModal({
  open,
  onOpenChange,
  initialLines,
  ocrSnapshot,
  initialNote,
  busy = false,
  onSave,
}: BoxSlipLinesEditModalProps) {
  const [lines, setLines] = useState<BoxSlipEvidenceLine[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expandedLines, setExpandedLines] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!open) return;
    setLines(
      initialLines.length > 0
        ? cloneBoxSlipEvidenceLines(initialLines)
        : ocrSnapshot.map((row) => ({
            upc: row.upc,
            fnsku: row.fnsku,
            sku: null,
            printed_asin: row.printed_asin ?? null,
            description: row.description,
            expected_qty: row.expected_qty,
            condition: row.condition,
            missing: Boolean(row.missing),
            needs_review: false,
          })),
    );
    setNote(String(initialNote ?? "").trim());
    setError(null);
    setExpandedLines(new Set());
  }, [open, initialLines, ocrSnapshot, initialNote]);

  const canSave = useMemo(() => lines.length > 0 || ocrSnapshot.length === 0, [lines.length, ocrSnapshot.length]);

  const updateLine = useCallback((index: number, patch: Partial<BoxSlipEvidenceLine>) => {
    setLines((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }, []);

  const removeLine = useCallback((index: number) => {
    setLines((prev) => prev.filter((_, i) => i !== index));
    setExpandedLines((prev) => {
      const next = new Set<number>();
      for (const idx of prev) {
        if (idx < index) next.add(idx);
        else if (idx > index) next.add(idx - 1);
      }
      return next;
    });
  }, []);

  const addLine = useCallback(() => {
    setLines((prev) => [...prev, emptyLine()]);
  }, []);

  const toggleAdvanced = useCallback((index: number) => {
    setExpandedLines((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    setError(null);
    const normalized = cloneBoxSlipEvidenceLines(lines).map((row) => ({
      ...row,
      upc: fieldValue(row.upc).trim() || null,
      fnsku: fieldValue(row.fnsku).trim() || null,
      sku: fieldValue(row.sku).trim() || null,
      printed_asin: fieldValue(row.printed_asin).trim() || null,
      description: fieldValue(row.description).trim() || null,
      condition: fieldValue(row.condition).trim() || null,
      expected_qty: Math.max(0, Math.floor(Number(row.expected_qty) || 0)),
    }));
    const hasContent = normalized.some(
      (row) =>
        row.upc ||
        row.fnsku ||
        row.sku ||
        row.printed_asin ||
        row.description ||
        row.expected_qty > 0,
    );
    if (!hasContent) {
      setError("Add at least one slip line with a quantity or identifier.");
      return;
    }
    try {
      await onSave({
        lines: normalized,
        note: note.trim() || null,
      });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save slip evidence.");
    }
  }, [lines, note, onOpenChange, onSave]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="operator-slip-evidence-modal fixed inset-0 z-[120] flex items-end justify-center sm:items-center sm:p-3"
      role="dialog"
      aria-modal="true"
      aria-labelledby="operator-slip-evidence-modal-title"
    >
      <button
        type="button"
        className="operator-slip-evidence-modal__backdrop absolute inset-0"
        aria-label="Close"
        onClick={() => !busy && onOpenChange(false)}
      />
      <div
        className="operator-slip-evidence-modal__sheet relative flex w-full max-w-md flex-col"
        style={{ maxHeight: "calc(100dvh - 24px)" }}
      >
        <header className="operator-slip-evidence-modal__header shrink-0">
          <div className="min-w-0 pr-2 text-left">
            <h2 id="operator-slip-evidence-modal-title" className="operator-slip-evidence-modal__title">
              Review / Edit Lines
            </h2>
            <p className="operator-slip-evidence-modal__subtitle">
              Slip evidence only — does not change shipment expected.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="operator-slip-evidence-modal__close"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="operator-slip-evidence-modal__body min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {lines.map((row, index) => (
            <SlipLineCard
              key={`slip-edit-line-${index}`}
              index={index}
              row={row}
              busy={busy}
              expanded={expandedLines.has(index)}
              onToggleAdvanced={() => toggleAdvanced(index)}
              onUpdate={(patch) => updateLine(index, patch)}
              onRemove={() => removeLine(index)}
            />
          ))}

          <button type="button" onClick={addLine} disabled={busy} className="operator-slip-evidence-add-line">
            <Plus className="h-4 w-4" aria-hidden />
            Add line
          </button>

          <label className="operator-slip-evidence-note">
            <span className="operator-slip-evidence-note__label">Note (optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
              rows={2}
              className="operator-slip-evidence-note__input"
              placeholder="Why these lines were corrected…"
            />
          </label>

          {error ? <p className="operator-slip-evidence-modal__error">{error}</p> : null}
        </div>

        <OperatorScannerFooterActions
          className="operator-slip-evidence-modal__footer shrink-0"
          primary={
            <button
              type="button"
              disabled={busy || !canSave}
              onClick={() => void handleSave()}
              className="operator-slip-evidence-modal__save-btn"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {busy ? "Saving…" : "Save slip evidence"}
            </button>
          }
          secondary={
            <button
              type="button"
              disabled={busy}
              onClick={() => onOpenChange(false)}
              className="operator-slip-evidence-modal__cancel-btn"
            >
              Cancel
            </button>
          }
        />
      </div>
    </div>,
    document.body,
  );
}
