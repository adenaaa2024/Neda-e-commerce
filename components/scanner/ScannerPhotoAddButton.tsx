"use client";

import { Camera, Loader2 } from "lucide-react";

type ScannerPhotoAddButtonProps = {
  label: string;
  disabled?: boolean;
  uploading?: boolean;
  onClick: () => void;
  /** BEM prefix for operator item modal theming (default). Pass empty for neutral styling. */
  themePrefix?: string;
  className?: string;
};

export function ScannerPhotoAddButton({
  label,
  disabled = false,
  uploading = false,
  onClick,
  themePrefix = "operator-item-unit-record-modal",
  className = "",
}: ScannerPhotoAddButtonProps) {
  const btnCls = themePrefix ? `${themePrefix}__evidence-btn` : "scanner-photo-add-btn";

  return (
    <button
      type="button"
      disabled={disabled || uploading}
      onClick={onClick}
      className={`${btnCls} mt-1.5 flex h-10 w-full items-center justify-center gap-2 rounded-xl border text-[13px] font-bold transition disabled:opacity-40 ${className}`.trim()}
    >
      {uploading ? (
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
      ) : (
        <Camera className="h-5 w-5" strokeWidth={2} aria-hidden />
      )}
      {label}
    </button>
  );
}
