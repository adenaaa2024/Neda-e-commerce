import { Bot, CheckCircle2, Settings2, Sparkles } from "lucide-react";

import { MenorixModuleFeatureLockedCard } from "./MenorixModuleFeatureLockedCard";
import { MENORIX_MODULE_CARD_CLASS } from "./menorix-module-ui";

export type MenorixAiAssistState = "locked" | "setup_required" | "ready";

export function MenorixModuleAiAssistCard({
  state,
  title = "AI assistant",
  description = "Assistive suggestions only — never the source of truth for claims.",
  slots,
}: {
  state: MenorixAiAssistState;
  title?: string;
  description?: string;
  slots?: Array<{ id: string; label: string; hint: string }>;
}) {
  if (state === "locked") {
    return (
      <MenorixModuleFeatureLockedCard
        title={title}
        description="Upgrade to unlock AI insights, evidence gap hints, and draft assistance."
        featureLabel="AI Pro"
      />
    );
  }

  const Icon = state === "ready" ? CheckCircle2 : Settings2;
  const statusLabel = state === "ready" ? "Ready (assistive only)" : "Setup required";
  const statusTone = state === "ready" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400";

  return (
    <div className={`${MENORIX_MODULE_CARD_CLASS} p-4 sm:p-5`}>
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-violet-500/10 p-2 text-violet-600 dark:text-violet-400">
          <Bot className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{title}</h3>
            <span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${statusTone}`}>
              <Icon className="h-3 w-3" /> {statusLabel}
            </span>
          </div>
          <p className="mt-1 text-xs opacity-70">{description}</p>
          {slots?.length ? (
            <ul className="mt-3 space-y-2">
              {slots.map((s) => (
                <li key={s.id} className="rounded-lg border border-dashed px-3 py-2 text-xs opacity-80">
                  <span className="inline-flex items-center gap-1 font-semibold">
                    <Sparkles className="h-3 w-3 opacity-60" /> {s.label}
                  </span>
                  <p className="mt-0.5 opacity-70">{s.hint}</p>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-3 text-[10px] uppercase tracking-wide opacity-50">No AI calls in this phase</p>
        </div>
      </div>
    </div>
  );
}
