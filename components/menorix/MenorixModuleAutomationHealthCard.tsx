import { Activity, AlertTriangle, CheckCircle2 } from "lucide-react";

import { MENORIX_MODULE_CARD_CLASS, menorixModuleBadgeTone } from "./menorix-module-ui";

export type MenorixAutomationHealth = {
  status: "healthy" | "degraded" | "unknown";
  label: string;
  detail: string;
  last_run_at?: string | null;
  enabled_sources?: string[];
  warnings?: string[];
};

export function MenorixModuleAutomationHealthCard({ health }: { health: MenorixAutomationHealth }) {
  const Icon = health.status === "healthy" ? CheckCircle2 : health.status === "degraded" ? AlertTriangle : Activity;
  const tone = health.status === "healthy" ? "success" : health.status === "degraded" ? "warning" : "neutral";

  return (
    <div className={`${MENORIX_MODULE_CARD_CLASS} p-4 sm:p-5`}>
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-sky-500/10 p-2 text-sky-600 dark:text-sky-400">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">Automation health</h3>
            <span className={menorixModuleBadgeTone(tone)}>{health.label}</span>
          </div>
          <p className="mt-1 text-xs opacity-70">{health.detail}</p>
          {health.last_run_at ? (
            <p className="mt-2 text-[11px] opacity-60">Last indexed: {health.last_run_at}</p>
          ) : null}
          {health.enabled_sources?.length ? (
            <p className="mt-2 text-[11px] opacity-60">
              Active sources: {health.enabled_sources.slice(0, 4).join(", ")}
              {health.enabled_sources.length > 4 ? "…" : ""}
            </p>
          ) : null}
          {health.warnings?.map((w) => (
            <p key={w} className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              {w}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}
