"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

export type ScannerPhotoActionSheetProps = {
  open: boolean;
  onClose: () => void;
  onTakePhoto: () => void;
  onUploadPhoto: () => void;
  disabled?: boolean;
  title?: string;
};

/**
 * Viewport-fixed photo chooser for Zebra / operator-mobile.
 * Portaled to document.body so scroll containers and backdrop-filter ancestors cannot clip it.
 */
export function ScannerPhotoActionSheet({
  open,
  onClose,
  onTakePhoto,
  onUploadPhoto,
  disabled = false,
  title = "Add photo",
}: ScannerPhotoActionSheetProps) {
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
            onClick={onTakePhoto}
          >
            <span className="scanner-photo-action-sheet-option-icon" aria-hidden>
              📸
            </span>
            Take photo
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={disabled}
            className="scanner-photo-action-sheet-option scanner-photo-action-sheet-option--border"
            onClick={onUploadPhoto}
          >
            <span className="scanner-photo-action-sheet-option-icon" aria-hidden>
              📁
            </span>
            Upload photo
          </button>
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
