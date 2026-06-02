import Link from "next/link";
import type { ReactNode } from "react";

import { ClaimEngineHubNavShell } from "./ClaimEngineHubNavShell";
import { CLAIM_ENGINE_PAGE_CLASS } from "./claim-engine-ui";

type AsideLink = { href: string; label: string };

export function ClaimEnginePageShell({
  title,
  description,
  children,
  aside,
  showHub = true,
  pathNote,
}: {
  title: string;
  description: string;
  children: ReactNode;
  aside?: ReactNode | AsideLink[];
  showHub?: boolean;
  /** Short note under description (e.g. physical vs import path). */
  pathNote?: ReactNode;
}) {
  const asideNode =
    Array.isArray(aside) ? (
      <div className="flex flex-wrap gap-3 text-sm">
        {aside.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            {l.label}
          </Link>
        ))}
      </div>
    ) : (
      aside
    );

  return (
    <div className={CLAIM_ENGINE_PAGE_CLASS}>
      {showHub ? <ClaimEngineHubNavShell /> : null}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4 dark:border-slate-800">
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-50">{title}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
          {pathNote ? <p className="text-xs text-slate-500 dark:text-slate-400">{pathNote}</p> : null}
        </div>
        {asideNode ? <div className="shrink-0">{asideNode}</div> : null}
      </header>
      {children}
    </div>
  );
}

/** Banner for Import / Amazon candidate inbox (not physical-scan workflow). */
export function ClaimImportPathBanner() {
  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/80 px-4 py-3 text-sm text-violet-950 dark:border-violet-800/50 dark:bg-violet-950/30 dark:text-violet-100">
      <p className="font-semibold">Import / Amazon candidate inbox</p>
      <p className="mt-1 text-xs leading-relaxed text-violet-900/90 dark:text-violet-200/90">
        This screen reviews <strong>claim_candidates</strong> from imports, removals, and legacy generators — not
        warehouse physical scans. For scanner returns, use the workflow:{" "}
        <Link href="/returns/claims" className="font-medium underline">
          Draft pool
        </Link>{" "}
        →{" "}
        <Link href="/claim-engine/review-ops" className="font-medium underline">
          Review
        </Link>{" "}
        →{" "}
        <Link href="/claim-engine/cases" className="font-medium underline">
          Cases
        </Link>{" "}
        → Submission queue.
      </p>
    </div>
  );
}
