"use client";

import { AlertCircle, AlertTriangle, Info } from "lucide-react";

import type { GroupWarning } from "@/lib/claims/contracts/claim-grouping-filters-manual-batch-contract-v1";

function severityIcon(severity: GroupWarning["severity"]) {
  if (severity === "block") return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600" />;
  if (severity === "warn") return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />;
  return <Info className="h-3.5 w-3.5 shrink-0 opacity-60" />;
}

function warningLabel(code: string): string {
  const labels: Record<string, string> = {
    mixed_products: "Mixed products",
    mixed_claim_families: "Mixed claim families",
    mixed_source_kinds: "Mixed source kinds",
    mixed_reference_types: "Mixed references",
    mixed_trids: "Mixed TRIDs",
    disputed_rows_included: "Disputed rows included",
    missing_product_link: "Missing product link",
    estimated_payout_unavailable: "Missing fee estimate",
    missing_cost: "Missing cost",
    low_confidence: "Low confidence",
    policy_hold: "Policy hold",
  };
  return labels[code] ?? code;
}

type Props = {
  warnings: GroupWarning[];
  compact?: boolean;
};

export function ClaimGroupWarningList({ warnings, compact }: Props) {
  if (!warnings.length) {
    return compact ? null : (
      <p className="text-xs text-emerald-700 dark:text-emerald-300">No grouping warnings for this preview.</p>
    );
  }

  return (
    <ul className={`space-y-1.5 ${compact ? "text-[11px]" : "text-xs"}`}>
      {warnings.map((w) => (
        <li
          key={`${w.code}-${w.message}`}
          className={`flex items-start gap-2 rounded-lg px-2 py-1.5 ${
            w.severity === "block"
              ? "bg-red-500/10 text-red-900 dark:text-red-100"
              : w.severity === "warn"
                ? "bg-amber-500/10 text-amber-900 dark:text-amber-100"
                : "bg-black/5 dark:bg-white/5"
          }`}
        >
          {severityIcon(w.severity)}
          <span>
            <span className="font-semibold">{warningLabel(w.code)}</span>
            <span className="opacity-85"> — {w.message}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
