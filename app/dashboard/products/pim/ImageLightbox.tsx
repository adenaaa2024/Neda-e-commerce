"use client";

import React, { useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { dedupeAmazonProductImageUrls } from "../../../../lib/amazon-catalog-image-extract";

export function dedupeImageUrls(urls: (string | null | undefined)[]): string[] {
  const trimmed = urls.map((u) => (typeof u === "string" ? u.trim() : "")).filter(Boolean) as string[];
  return dedupeAmazonProductImageUrls(trimmed);
}

export function ImageLightbox({
  urls,
  index,
  onClose,
  onIndexChange,
}: {
  urls: string[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
}) {
  const safeUrls = urls.length ? urls : [];
  const i = Math.min(Math.max(0, index), Math.max(0, safeUrls.length - 1));
  const current = safeUrls[i] ?? null;

  const go = useCallback(
    (delta: number) => {
      if (safeUrls.length <= 1) return;
      const n = (i + delta + safeUrls.length) % safeUrls.length;
      onIndexChange(n);
    },
    [i, onIndexChange, safeUrls.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (safeUrls.length <= 1) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "ArrowLeft") go(-1);
        else go(1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, onClose, safeUrls.length]);

  if (!current || typeof document === "undefined") return null;

  const el = (
    <div
      className="fixed inset-0 z-[600] flex items-center justify-center bg-black/85 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        className="absolute right-4 top-4 z-[610] rounded-full bg-white/15 p-2 text-white hover:bg-white/25"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Close image preview"
      >
        <X className="h-6 w-6" />
      </button>
      {safeUrls.length > 1 ? (
        <>
          <button
            type="button"
            className="absolute left-2 top-1/2 z-[610] -translate-y-1/2 rounded-full bg-white/15 p-2 text-white hover:bg-white/25 sm:left-4"
            onClick={(e) => {
              e.stopPropagation();
              go(-1);
            }}
            aria-label="Previous image"
          >
            <ChevronLeft className="h-7 w-7" />
          </button>
          <button
            type="button"
            className="absolute right-2 top-1/2 z-[610] -translate-y-1/2 rounded-full bg-white/15 p-2 text-white hover:bg-white/25 sm:right-16"
            onClick={(e) => {
              e.stopPropagation();
              go(1);
            }}
            aria-label="Next image"
          >
            <ChevronRight className="h-7 w-7" />
          </button>
          <p className="absolute bottom-4 left-0 right-0 text-center text-xs text-white/80">
            {i + 1} / {safeUrls.length}
          </p>
        </>
      ) : null}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={current}
        alt=""
        className="max-h-[90vh] max-w-full rounded-lg object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );

  return createPortal(el, document.body);
}
