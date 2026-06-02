import Link from "next/link";
import type { ReactNode } from "react";

import { ClaimEngineHubNavShell } from "./ClaimEngineHubNavShell";
import { ClaimWorkflowExplainer } from "./ClaimWorkflowExplainer";
import { CLAIM_ENGINE_PAGE_CLASS } from "./claim-engine-ui";

type AsideLink = { href: string; label: string };

export function ClaimEnginePageShell({
  title,
  description,
  children,
  aside,
  showHub = true,
  pathNote,
  showWorkflowExplainer = false,
  workflowExplainerCompact = true,
}: {
  title: string;
  description: string;
  children: ReactNode;
  aside?: ReactNode | AsideLink[];
  showHub?: boolean;
  /** Short note under description (e.g. physical vs import path). */
  pathNote?: ReactNode;
  /** Pipeline glossary (Intake → Draft → Cases → Submissions). */
  showWorkflowExplainer?: boolean;
  workflowExplainerCompact?: boolean;
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
      {showWorkflowExplainer ? (
        <ClaimWorkflowExplainer compact={workflowExplainerCompact} />
      ) : null}
      {children}
    </div>
  );
}

/** Intake scope note — all sources, not import-only. */
export function ClaimIntakeScopeBanner() {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/90 px-4 py-3 text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-100">
      <p className="font-semibold">Claim intake inbox</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Raw signals from <strong className="text-foreground">claim_candidates</strong> (imports, removals, Amazon
        returns reports, and generators). Physical warehouse scans are normalized in the{" "}
        <Link href="/returns/claims" className="font-medium text-slate-900 underline dark:text-slate-100">
          Draft pool
        </Link>
        . Settlement, reimbursement, and inventory connectors are listed below when not yet live.
      </p>
    </div>
  );
}

/** @deprecated Use ClaimIntakeScopeBanner */
export function ClaimImportPathBanner() {
  return <ClaimIntakeScopeBanner />;
}
