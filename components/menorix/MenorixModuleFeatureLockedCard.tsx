import { Crown, Lock } from "lucide-react";

import { MENORIX_MODULE_CARD_CLASS } from "./menorix-module-ui";

export function MenorixModuleFeatureLockedCard({
  title,
  description,
  featureLabel = "Pro feature",
  ctaHref,
  ctaLabel = "View plans",
}: {
  title: string;
  description: string;
  featureLabel?: string;
  ctaHref?: string;
  ctaLabel?: string;
}) {
  return (
    <div className={`${MENORIX_MODULE_CARD_CLASS} p-4 sm:p-5`}>
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-amber-500/10 p-2 text-amber-600 dark:text-amber-400">
          <Lock className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            <Crown className="h-3 w-3" /> {featureLabel}
          </p>
          <h3 className="mt-1 text-sm font-semibold">{title}</h3>
          <p className="mt-1 text-xs opacity-70">{description}</p>
          {ctaHref ? (
            <a href={ctaHref} className="mt-3 inline-block text-xs font-semibold underline opacity-80">
              {ctaLabel}
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
