"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, X } from "lucide-react";

export type ScannerPhotoLightboxItem = {
  src: string;
  label: string;
};

type ScannerPhotoLightboxProps = {
  photos: ScannerPhotoLightboxItem[];
  startIdx: number;
  onClose: () => void;
  /** Stacking above operator modals (default 220). */
  zIndexClass?: string;
};

/**
 * In-app fullscreen image preview for operator scanner flows.
 * Does not navigate, open tabs, or change route.
 */
export function ScannerPhotoLightbox({
  photos,
  startIdx,
  onClose,
  zIndexClass = "z-[220]",
}: ScannerPhotoLightboxProps) {
  const [idx, setIdx] = useState(startIdx);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setIdx(startIdx);
  }, [startIdx]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowLeft" && idx > 0) setIdx((i) => i - 1);
      if (e.key === "ArrowRight" && idx < photos.length - 1) setIdx((i) => i + 1);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [idx, onClose, photos.length]);

  if (!mounted || photos.length === 0) return null;

  const current = photos[idx] ?? photos[0]!;

  return createPortal(
    <div
      className={`fixed inset-0 ${zIndexClass} flex items-center justify-center bg-black/90 backdrop-blur-md`}
      role="dialog"
      aria-modal="true"
      aria-label={current.label}
      onClick={onClose}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={current.src}
        alt={current.label}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[88vh] max-w-[92vw] select-none rounded-2xl object-contain shadow-2xl"
      />
      <div className="pointer-events-none absolute bottom-6 left-1/2 max-w-[90vw] -translate-x-1/2 truncate rounded-full bg-black/70 px-4 py-2 text-sm text-white backdrop-blur-sm">
        {current.label}
        {photos.length > 1 ? ` · ${idx + 1}/${photos.length}` : null}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-black/80"
        aria-label="Close preview"
      >
        <X className="h-5 w-5" />
      </button>
      {idx > 0 ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIdx((i) => i - 1);
          }}
          className="absolute left-4 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white transition hover:bg-black/80"
          aria-label="Previous photo"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
      ) : null}
      {idx < photos.length - 1 ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIdx((i) => i + 1);
          }}
          className="absolute right-4 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white transition hover:bg-black/80"
          aria-label="Next photo"
        >
          <ArrowRight className="h-5 w-5" />
        </button>
      ) : null}
    </div>,
    document.body,
  );
}
