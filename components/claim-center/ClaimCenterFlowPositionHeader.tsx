"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, ChevronRight } from "lucide-react";

import type { ClaimCenterV2PageContract } from "@/lib/claims/center/claim-center-v2-page-contract";
import {
  flowStepNeighbors,
  resolveFlowStepFromLocation,
} from "@/lib/claims/center/claim-center-flow-nav";

import { ClaimCenterFlowStepPill } from "./ClaimCenterWorkflowBar";

export function ClaimCenterFlowPositionHeader({ contract }: { contract: ClaimCenterV2PageContract }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const step = resolveFlowStepFromLocation(pathname, searchParams);
  const neighbors = step ? flowStepNeighbors(step) : null;
  const isHome = contract.id === "home";

  return (
    <header className="claim-center-flow-position space-y-3 border-b border-black/5 pb-5 dark:border-white/10" data-claim-center="you-are-here">
      <nav className="flex flex-wrap items-center gap-1 text-xs opacity-60" aria-label="Breadcrumb">
        <span>Claim Center</span>
        <ChevronRight className="h-3 w-3" aria-hidden />
        {step ? (
          <>
            <span>Step {step.order} of 7</span>
            <ChevronRight className="h-3 w-3" aria-hidden />
            <span className="font-semibold opacity-90">{step.label}</span>
          </>
        ) : (
          <span className="font-semibold opacity-90">{isHome ? "Command board" : contract.navLabel}</span>
        )}
      </nav>

      {step ? (
        <div className="flex flex-wrap items-center gap-2">
          <ClaimCenterFlowStepPill stepId={step.id} />
          <span className="text-[11px] font-medium uppercase tracking-wide opacity-50">You are here</span>
        </div>
      ) : isHome ? (
        <p className="text-[11px] font-medium uppercase tracking-wide text-amber-800/80 dark:text-amber-200/70">
          Recovery overview
        </p>
      ) : null}

      <h1 className="text-xl font-bold tracking-tight sm:text-2xl lg:text-[1.65rem]">{contract.question}</h1>

      <p className="max-w-3xl text-sm opacity-75">
        <span className="font-medium opacity-90">Data source:</span> {contract.dataSource}
      </p>

      <p className="max-w-3xl text-sm opacity-70">{contract.whatToDoNext}</p>

      {neighbors ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {neighbors.previous ? (
            <Link
              href={neighbors.previous.href}
              className="inline-flex min-h-[40px] items-center gap-1 rounded-xl border px-3 text-xs font-medium opacity-85 transition-opacity hover:opacity-100"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              {neighbors.previous.label}
            </Link>
          ) : null}
          {neighbors.next ? (
            <Link
              href={neighbors.next.href}
              className="inline-flex min-h-[40px] items-center gap-1 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 text-xs font-semibold text-amber-950 transition-opacity hover:opacity-100 dark:text-amber-100"
            >
              Next: {neighbors.next.label}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          ) : null}
        </div>
      ) : isHome ? (
        <Link
          href="/claim-center/opportunities"
          className="inline-flex min-h-[40px] items-center gap-1 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 text-xs font-semibold text-amber-950 transition-opacity hover:opacity-100 dark:text-amber-100"
        >
          Start: Find money
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      ) : null}
    </header>
  );
}
