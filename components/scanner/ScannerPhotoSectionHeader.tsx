"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Info } from "lucide-react";
import { OPERATOR_SCANNER_PHOTO_SECTION_MAX } from "@/lib/scanner/scanner-photo-section-limit";

type ScannerPhotoSectionHeaderProps = {
  title: string;
  helperText: string;
  count: number;
  max?: number;
  /** BEM prefix for operator item modal theming (default). Pass empty for neutral styling. */
  themePrefix?: string;
  className?: string;
};

export function ScannerPhotoSectionHeader({
  title,
  helperText,
  count,
  max = OPERATOR_SCANNER_PHOTO_SECTION_MAX,
  themePrefix = "operator-item-unit-record-modal",
  className = "",
}: ScannerPhotoSectionHeaderProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const helpId = useId();
  const atMax = count >= max;

  useEffect(() => {
    if (!helpOpen) return;
    const onDoc = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setHelpOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
    };
  }, [helpOpen]);

  const headingCls = themePrefix ? `${themePrefix}__heading` : "";
  const infoBtnCls = themePrefix ? `${themePrefix}__photo-info-btn` : "scanner-photo-section-info-btn";
  const tooltipCls = themePrefix ? `${themePrefix}__photo-help-tooltip` : "scanner-photo-section-help-tooltip";
  const countCls = [
    themePrefix ? `${themePrefix}__photo-count` : "scanner-photo-section-count",
    atMax && themePrefix ? `${themePrefix}__photo-count--max` : "",
    atMax && !themePrefix ? "scanner-photo-section-count--max" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={`flex items-center justify-between gap-2 ${className}`}>
      <p className={`${headingCls} min-w-0 truncate text-[12px] font-bold`.trim()}>{title}</p>
      <div className="flex shrink-0 items-center gap-1.5">
        <div ref={wrapRef} className="relative">
          <button
            type="button"
            className={`${infoBtnCls} flex h-6 w-6 items-center justify-center rounded-full border transition active:scale-95`}
            aria-label={`About ${title}`}
            aria-expanded={helpOpen}
            aria-describedby={helpOpen ? helpId : undefined}
            onClick={() => setHelpOpen((o) => !o)}
          >
            <Info className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
          </button>
          {helpOpen ? (
            <div
              id={helpId}
              role="tooltip"
              className={`${tooltipCls} absolute right-0 top-full z-30 mt-1.5 w-[min(calc(100vw-3rem),240px)] rounded-lg border px-2.5 py-2 text-left text-[11px] font-medium leading-snug shadow-lg`}
            >
              {helperText}
            </div>
          ) : null}
        </div>
        <span className={`${countCls} text-[11px] font-bold tabular-nums`} aria-label={`${count} of ${max} photos`}>
          {count}/{max}
        </span>
      </div>
    </div>
  );
}
