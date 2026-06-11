import type { ReactNode } from "react";

import { Loader2 } from "lucide-react";

import { MENORIX_MODULE_KPI_CARD, MENORIX_MODULE_KPI_GRID } from "./menorix-module-ui";

export type MenorixKpiItem = {
  id: string;
  label: string;
  value: string;
  hint?: string;
  href?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  icon?: ReactNode;
};

export function MenorixModuleKpiStrip({ items, loading }: { items: MenorixKpiItem[]; loading?: boolean }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm opacity-70">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading metrics…
      </div>
    );
  }

  return (
    <div className={MENORIX_MODULE_KPI_GRID}>
      {items.map((item) => {
        const inner = (
          <>
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide opacity-70">
              {item.icon}
              {item.label}
            </div>
            <p className="mt-2 text-xl font-bold sm:text-2xl">{item.value}</p>
            {item.hint ? <p className="mt-1 text-[11px] opacity-60">{item.hint}</p> : null}
          </>
        );
        if (item.href) {
          return (
            <a key={item.id} href={item.href} className={`${MENORIX_MODULE_KPI_CARD} block transition hover:opacity-90`}>
              {inner}
            </a>
          );
        }
        return (
          <div key={item.id} className={MENORIX_MODULE_KPI_CARD}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}
