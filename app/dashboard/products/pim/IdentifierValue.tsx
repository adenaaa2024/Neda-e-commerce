"use client";

import React, { useCallback, useState } from "react";
import { Check, Copy, Search } from "lucide-react";

export type IdentifierKind = "asin" | "sku" | "fnsku" | "upc";

function amazonDpUrl(asin: string): string {
  return `https://www.amazon.com/dp/${encodeURIComponent(asin)}`;
}

function amazonSearchUrl(value: string): string {
  return `https://www.amazon.com/s?k=${encodeURIComponent(value)}`;
}

const iconBtn =
  "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border/60 bg-background/80 text-muted-foreground hover:bg-muted hover:text-foreground";

export function IdentifierValue({
  value,
  kind,
  className = "",
}: {
  value: string | null | undefined;
  kind: IdentifierKind;
  className?: string;
}) {
  const v = typeof value === "string" ? value.trim() : "";
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    if (!v) return;
    try {
      await navigator.clipboard.writeText(v);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, [v]);

  if (!v) {
    return <span className={`text-muted-foreground ${className}`}>—</span>;
  }

  const searchAmazon = () => window.open(amazonSearchUrl(v), "_blank", "noopener,noreferrer");

  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-xs ${className}`}
      role="group"
      aria-label={`${kind} ${v}`}
    >
      <span className="min-w-0 flex-1 truncate text-foreground" title={v}>
        {v}
      </span>
      <span className="inline-flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={() => void copy()}
          className={iconBtn}
          title="Copy"
          aria-label={`Copy ${kind}`}
        >
          {copied ? <Check className="h-3 w-3 text-emerald-600" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
        </button>
        <button
          type="button"
          onClick={searchAmazon}
          className={iconBtn}
          title="Search on Amazon"
          aria-label="Search on Amazon"
        >
          <Search className="h-3 w-3" aria-hidden />
        </button>
      </span>
    </span>
  );
}
