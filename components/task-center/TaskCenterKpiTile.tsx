"use client";

import Link from "next/link";

import { TASK_CENTER_CARD_CLASS, TASK_CENTER_KPI_CARD, TASK_CENTER_KPI_GRID } from "./task-center-ui";

export function TaskCenterKpiTile({
  label,
  count,
  href,
  tone = "default",
}: {
  label: string;
  count: number;
  href: string;
  tone?: "default" | "warn" | "danger";
}) {
  return (
    <Link
      href={href}
      className={`${TASK_CENTER_KPI_CARD} block min-h-[88px] transition hover:shadow-md ${
        tone === "danger" ? "ring-1 ring-red-500/20" : tone === "warn" ? "ring-1 ring-amber-500/20" : ""
      }`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide opacity-60">{label}</p>
      <p className="mt-2 text-2xl font-bold tabular-nums">{count}</p>
    </Link>
  );
}

export function TaskCenterSourceSummaryTiles({
  rows,
}: {
  rows: Array<{ label: string; open_count: number; href: string }>;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
      {rows.map((row) => (
        <Link
          key={row.href}
          href={row.href}
          className={`${TASK_CENTER_CARD_CLASS} p-3 text-sm hover:shadow-md`}
        >
          <p className="text-xs font-semibold uppercase opacity-60">{row.label}</p>
          <p className="mt-1 text-xl font-bold tabular-nums">{row.open_count}</p>
        </Link>
      ))}
    </div>
  );
}

export { TASK_CENTER_KPI_GRID };
