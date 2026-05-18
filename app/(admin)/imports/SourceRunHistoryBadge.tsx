"use client";

import type { ImportHistorySourceRunView } from "@/lib/amazon/import-history-source-run";
import { sourceRunBadgeClassName } from "@/lib/amazon/import-history-source-run";

type Props = {
  view: ImportHistorySourceRunView;
  compact?: boolean;
};

/** Import History badge for Reports API `metadata.source_run` rows. */
export function SourceRunHistoryBadge({ view, compact = false }: Props) {
  if (view.origin === "ledger") {
    return (
      <span
        className={[
          "inline-flex max-w-full items-center rounded-md px-1.5 py-0.5 font-medium leading-snug",
          compact ? "text-[9px]" : "text-[10px]",
          sourceRunBadgeClassName("neutral"),
        ].join(" ")}
        title="Amazon ledger uploader session"
      >
        Ledger
      </span>
    );
  }

  if (view.origin === "manual" && !view.showSourceRunBadge) {
    return null;
  }

  const titleParts = [
    view.origin === "api" ? "Amazon Reports API" : null,
    view.sourceRun?.source_run_id ? `source_run: ${view.sourceRun.source_run_id}` : null,
    view.sourceRun?.report_id ? `report: ${view.sourceRun.report_id}` : null,
  ].filter(Boolean);

  return (
    <span
      className={[
        "inline-flex max-w-full items-center rounded-md px-1.5 py-0.5 font-medium leading-snug",
        compact ? "text-[9px]" : "text-[10px]",
        sourceRunBadgeClassName(view.badgeTone),
      ].join(" ")}
      title={titleParts.length ? titleParts.join(" · ") : view.badgeLabel}
    >
      <span className="min-w-0 truncate">{view.badgeLabel}</span>
    </span>
  );
}
