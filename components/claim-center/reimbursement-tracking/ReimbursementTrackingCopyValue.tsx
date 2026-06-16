"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function ReimbursementTrackingCopyValue({
  value,
  label,
}: {
  value: string | null | undefined;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const trimmed = (value ?? "").trim();
  if (!trimmed) return <span className="text-xs opacity-50">—</span>;

  async function copy() {
    try {
      await navigator.clipboard.writeText(trimmed);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="truncate font-mono text-[11px]">{trimmed}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void copy();
        }}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border opacity-70 hover:opacity-100"
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
      >
        {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}
