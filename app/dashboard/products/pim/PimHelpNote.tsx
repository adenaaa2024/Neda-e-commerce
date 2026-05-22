"use client";

import React, { useEffect, useRef, useState } from "react";
import { BadgeInfo } from "lucide-react";

/** Compact admin help: icon toggles a small anchored panel (no Radix). */
export function PimHelpNote({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div
      className="relative inline-flex shrink-0 select-none items-center align-middle"
      ref={rootRef}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="cursor-pointer rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <BadgeInfo className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
      </button>
      {open ? (
        <div
          className="absolute left-0 top-full z-[300] mt-1.5 w-[min(22rem,calc(100vw-2rem))] select-text rounded-lg border border-border bg-card p-3 text-xs leading-relaxed text-foreground shadow-lg"
          role="note"
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
