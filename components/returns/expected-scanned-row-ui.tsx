import { CheckCircle2, Link2 } from "lucide-react";

export type ExpectedScannedRowStatus = "Match" | "Missing" | "Over" | "Pending";

/** UI-only status for expected-vs-scanned rows (counts unchanged). */
export function deriveExpectedScannedRowStatus(
  need: number,
  scannedQty: number,
): ExpectedScannedRowStatus {
  if (need <= 0) return "Pending";
  if (scannedQty > need) return "Over";
  if (scannedQty >= need) return "Match";
  return "Missing";
}

export function expectedScannedStatusBadgeClass(status: ExpectedScannedRowStatus): string {
  switch (status) {
    case "Match":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300";
    case "Over":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
    case "Pending":
      return "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
    case "Missing":
    default:
      return "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300";
  }
}

export function expectedScannedRowBackgroundClass(status: ExpectedScannedRowStatus): string {
  switch (status) {
    case "Match":
      return "bg-emerald-50/70 dark:bg-emerald-950/20";
    case "Missing":
      return "bg-rose-50/50 dark:bg-rose-950/15";
    case "Over":
      return "bg-amber-50/60 dark:bg-amber-950/15";
    case "Pending":
    default:
      return "";
  }
}

type ExpectedScannedProductCellProps = {
  title: string;
  fnsku?: string | null;
  secondaryLabel?: string | null;
  showLinkedBadge?: boolean;
};

export function ExpectedScannedProductCell({
  title,
  fnsku,
  secondaryLabel,
  showLinkedBadge = false,
}: ExpectedScannedProductCellProps) {
  return (
    <td className="min-w-0 max-w-[min(100%,280px)] px-3 py-2.5 align-top">
      <p className="line-clamp-2 font-semibold leading-snug text-slate-800 dark:text-slate-200">
        {title}
      </p>
      {fnsku ? (
        <p className="mt-0.5 font-mono text-[11px] text-slate-500 dark:text-slate-400">
          FNSKU: {fnsku}
        </p>
      ) : null}
      {secondaryLabel ? (
        <p className="mt-0.5 font-mono text-[11px] text-slate-500 dark:text-slate-400">
          {secondaryLabel}
        </p>
      ) : null}
      {showLinkedBadge ? (
        <span className="mt-1 inline-flex items-center gap-0.5 rounded border border-emerald-500/25 bg-emerald-500/10 px-1 py-0.5 text-[9px] font-medium text-emerald-700 dark:text-emerald-300">
          <Link2 className="h-2.5 w-2.5 shrink-0 opacity-70" aria-hidden />
          Linked
        </span>
      ) : null}
    </td>
  );
}

type ExpectedScannedStatusBadgeProps = {
  status: ExpectedScannedRowStatus;
};

export function ExpectedScannedStatusBadge({ status }: ExpectedScannedStatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${expectedScannedStatusBadgeClass(status)}`}
    >
      {status === "Match" ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : null}
      {status}
    </span>
  );
}

/** Build operational product column fields from expected_packages row data. */
export function operationalFieldsFromExpectedPackageRow(row: {
  sku: string;
  fnsku: string | null;
  asin: string | null;
  product_linkage: {
    product_name?: string | null;
    fallback_display_name?: string | null;
    fnsku?: string | null;
    sku?: string | null;
    asin?: string | null;
    is_resolved?: boolean;
  };
}): {
  title: string;
  fnsku: string | null;
  secondaryLabel: string | null;
  showLinkedBadge: boolean;
} {
  const linkage = row.product_linkage;
  const fnsku = row.fnsku?.trim() || linkage.fnsku?.trim() || null;
  const sku = row.sku?.trim() || linkage.sku?.trim() || null;
  const asin = row.asin?.trim() || linkage.asin?.trim() || null;

  const title =
    linkage.product_name?.trim() ||
    linkage.fallback_display_name?.trim() ||
    fnsku ||
    sku ||
    asin ||
    "—";

  let secondaryLabel: string | null = null;
  if (sku && sku !== title && sku !== fnsku) {
    secondaryLabel = `SKU: ${sku}`;
  } else if (asin && asin !== title && asin !== fnsku && asin !== sku) {
    secondaryLabel = `ASIN: ${asin}`;
  }

  return {
    title,
    fnsku: fnsku && fnsku !== title ? fnsku : null,
    secondaryLabel,
    showLinkedBadge: !!linkage.is_resolved,
  };
}
