"use client";

import { AlertTriangle } from "lucide-react";

import type { ClaimCenterQueryMeta } from "@/lib/claims/center/claim-center-v1-types";

export function ClaimCenterSampleWarningBanner({ meta }: { meta: ClaimCenterQueryMeta | null | undefined }) {
  if (!meta?.is_sample_capped && !meta?.is_limited_scan) return null;

  const parts: string[] = [];
  if (meta.is_sample_capped && meta.db_total_count != null) {
    parts.push(
      `Showing ${meta.items_returned} of ${meta.db_total_count.toLocaleString()} opportunities (newest ${meta.sample_limit} scanned for KPIs).`,
    );
  } else if (meta.is_limited_scan && meta.total_scanned > meta.items_returned) {
    parts.push(`Showing ${meta.items_returned} of ${meta.total_scanned} rows from this scan.`);
  } else if (meta.is_sample_capped) {
    parts.push(`Counts based on the newest ${meta.sample_limit} rows only — totals may be higher.`);
  }

  if (!parts.length) return null;

  return (
    <div
      className="claim-center-banner mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-snug"
      role="status"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <p>{parts.join(" ")}</p>
    </div>
  );
}
