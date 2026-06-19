"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

export type BoxSlipCorrectionSheetMode = "correction" | "unreadable";

export type BoxSlipCorrectionActionSheetProps = {
  open: boolean;
  mode: BoxSlipCorrectionSheetMode;
  onClose: () => void;
  onEditLines: () => void;
  onMarkUnreadable: () => void;
  onClearUnreadable: () => void;
  disabled?: boolean;
};

export function BoxSlipCorrectionActionSheet({
  open,
  mode,
  onClose,
  onEditLines,
  onMarkUnreadable,
  onClearUnreadable,
  disabled = false,
}: BoxSlipCorrectionActionSheetProps) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  const title = "What needs correction?";

  return createPortal(
    <>
      <div
        className="scanner-photo-action-sheet-backdrop"
        role="presentation"
        aria-hidden
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="scanner-photo-action-sheet-panel scanner-ocr-action-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="scanner-photo-action-sheet-handle" aria-hidden />
        <p className="scanner-photo-action-sheet-title">{title}</p>
        <div className="scanner-photo-action-sheet-options">
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            className="scanner-photo-action-sheet-option"
            onClick={onEditLines}
          >
            Edit detected lines
          </button>
          {mode === "unreadable" ? (
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              className="scanner-photo-action-sheet-option scanner-photo-action-sheet-option--border"
              onClick={onClearUnreadable}
            >
              Clear unreadable / Confirm instead
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              className="scanner-photo-action-sheet-option scanner-photo-action-sheet-option--border"
              onClick={onMarkUnreadable}
            >
              Mark as unreadable
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="scanner-photo-action-sheet-option scanner-photo-action-sheet-option--cancel scanner-photo-action-sheet-option--border"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
