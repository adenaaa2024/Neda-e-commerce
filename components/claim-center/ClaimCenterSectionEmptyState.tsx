"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2, Inbox, Sparkles } from "lucide-react";

import { MENORIX_MODULE_CARD_CLASS } from "@/components/menorix/menorix-module-ui";
import type { ClaimCenterSectionEmptyConfig } from "@/lib/claims/center/claim-center-ui-copy";

import { ClaimCenterBridgePhaseNotice } from "./ClaimCenterBridgePhaseNotice";

function safeActionHref(config: ClaimCenterSectionEmptyConfig): { href: string; label: string } {
  if (config.variant === "pool_empty") {
    return { href: "/claim-center/sources", label: "Check Sources" };
  }
  if (config.id.includes("review")) {
    return { href: "/claim-center/opportunities", label: "Find money" };
  }
  return { href: "/claim-center", label: "Back to Home" };
}

export function ClaimCenterSectionEmptyState({ config }: { config: ClaimCenterSectionEmptyConfig }) {
  const isPoolEmpty = config.variant === "pool_empty";
  const Icon = isPoolEmpty ? Sparkles : CheckCircle2;
  const toneClass = isPoolEmpty
    ? "border-amber-500/25 bg-amber-500/5"
    : "border-emerald-500/25 bg-emerald-500/5";
  const safeAction = safeActionHref(config);

  return (
    <div className="claim-center-empty-state space-y-4 py-4 sm:py-6" data-empty-variant={config.variant}>
      <div
        className={`${MENORIX_MODULE_CARD_CLASS} claim-center-empty-state__card mx-auto max-w-lg border p-5 text-center sm:p-8 ${toneClass}`}
      >
        <Icon className="mx-auto mb-3 h-7 w-7 opacity-70 sm:h-8 sm:w-8" aria-hidden />
        <h3 className="text-base font-semibold">{config.title}</h3>
        <p className="mt-2 text-xs font-medium uppercase tracking-wide opacity-55">
          {isPoolEmpty ? "Pool empty" : "Queue clear"}
        </p>

        <p className="mt-4 text-left text-sm opacity-80">{config.whyEmpty}</p>

        <p className="mt-3 text-left text-xs opacity-60">{config.nextSteps[0]}</p>

        <Link
          href={safeAction.href}
          className="mt-5 inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-xl border border-amber-600/30 px-4 text-sm font-semibold transition-opacity hover:opacity-90"
        >
          {isPoolEmpty ? <Inbox className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />}
          {safeAction.label}
        </Link>
      </div>
      <ClaimCenterBridgePhaseNotice compact />
    </div>
  );
}
