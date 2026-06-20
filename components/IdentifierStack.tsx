"use client";

import { Copy, Search } from "lucide-react";
import { marketplaceSearchUrl } from "../lib/marketplace-search-url";

export type IdentifierToastFn = (msg: string, kind?: "success" | "error" | "warning") => void;

const iconBtn =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground/90 transition hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-35";

export type IdentifierStackProps = {
  itemName?: string | null;
  asin?: string | null;
  fnsku?: string | null;
  sku?: string | null;
  /** UPC / GTIN when known (V196). */
  upc?: string | null;
  /** Store platform / marketplace (e.g. amazon, walmart) — drives search URL. */
  storePlatform?: string | null;
  compact?: boolean;
  onToast?: IdentifierToastFn;
  /** Hide item title row (e.g. compact table cells). */
  hideItemName?: boolean;
  /** MENORIX palette for Returns desktop tables only. */
  menorixTable?: boolean;
};

/**
 * Golden Rule: ASIN / FNSKU / SKU in a vertical stack; each row always visible with Copy + Search.
 * Amazon → amazon search; Walmart → walmart; default Amazon.
 */
export function IdentifierStack({
  itemName,
  asin,
  fnsku,
  sku,
  upc,
  storePlatform,
  compact,
  onToast,
  hideItemName,
  menorixTable = false,
}: IdentifierStackProps) {
  const labelCls = compact ? "text-[11px]" : "text-xs";
  const iconBtnMenorix =
    "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[rgba(138,104,31,0.18)] bg-[#FFFFFF] text-[#4C5661] transition hover:bg-[#F8F6F1] hover:text-[#171A1E] disabled:pointer-events-none disabled:opacity-35 dark:border-[rgba(214,183,110,0.20)] dark:bg-[#1D242C] dark:text-[#B8C1CB] dark:hover:bg-[#232C35] dark:hover:text-[#F7F3EA]";
  const rowIconBtn = menorixTable ? iconBtnMenorix : iconBtn;

  async function copyVal(v: string, label: string) {
    try {
      await navigator.clipboard.writeText(v);
      onToast?.(`Copied ${label}`, "success");
    } catch {
      onToast?.("Copy failed", "error");
    }
  }

  function openSearch(code: string) {
    const url = marketplaceSearchUrl(storePlatform, code);
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function Row({ label, raw }: { label: string; raw: string | null | undefined }) {
    const display = (raw ?? "").trim() || "—";
    const hasValue = !!(raw ?? "").trim();

    return (
      <div className={`flex min-w-0 items-center gap-1 ${labelCls} ${menorixTable ? "text-[#737C86] dark:text-[#7E8894]" : "text-muted-foreground"}`}>
        <span className={`shrink-0 font-semibold ${menorixTable ? "text-[#4C5661] dark:text-[#B8C1CB]" : "text-slate-500 dark:text-slate-400"}`}>{label}:</span>
        <span className={`min-w-0 flex-1 truncate font-mono ${menorixTable ? "text-[#171A1E] dark:text-[#F7F3EA]" : "text-foreground/90"}`}>{display}</span>
        <button
          type="button"
          title={hasValue ? `Copy ${label}` : "Nothing to copy"}
          disabled={!hasValue}
          className={rowIconBtn}
          onClick={(e) => {
            e.stopPropagation();
            if (hasValue) void copyVal((raw ?? "").trim(), label);
          }}
        >
          <Copy className="h-3 w-3" />
        </button>
        <button
          type="button"
          title={hasValue ? "Search marketplace" : "Enter a code first"}
          disabled={!hasValue}
          className={rowIconBtn}
          onClick={(e) => {
            e.stopPropagation();
            if (hasValue) openSearch((raw ?? "").trim());
          }}
        >
          <Search className="h-3 w-3" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-w-[200px] max-w-[min(100%,320px)] flex-col gap-1">
      {!hideItemName ? (
        <p
          className={`font-bold leading-tight ${menorixTable ? "text-[#171A1E] dark:text-[#F7F3EA]" : "text-slate-900 dark:text-slate-100"} ${compact ? "text-xs" : "text-sm"}`}
        >
          {itemName?.trim() || "—"}
        </p>
      ) : null}
      <Row label="ASIN" raw={asin} />
      <Row label="FNSKU" raw={fnsku} />
      <Row label="SKU" raw={sku} />
      <Row label="UPC" raw={upc} />
    </div>
  );
}
