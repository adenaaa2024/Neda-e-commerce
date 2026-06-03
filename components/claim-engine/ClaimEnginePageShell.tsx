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
  /** @deprecated Workflow steps are now in the hub nav tooltips. Pass false (default) to keep pages clean. */
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
          <Link key={l.href} href={l.href} className="claim-engine-link">
            {l.label}
          </Link>
        ))}
      </div>
    ) : (
      aside
    );

  return (
    <div className={CLAIM_ENGINE_PAGE_CLASS}>
      {showHub ? <ClaimEngineHubNavShell className="claim-engine-hub-nav" /> : null}
      <header className="claim-engine-page-header flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <h1 className="text-xl font-bold tracking-tight">{title}</h1>
          <p className="max-w-3xl text-sm">{description}</p>
          {pathNote ? <p className="text-xs">{pathNote}</p> : null}
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
    <div className="claim-engine-banner claim-engine-banner--info">
      <p className="font-semibold">Claim intake inbox</p>
      <p className="mt-1 text-xs leading-relaxed">
        Raw signals from <strong>claim_candidates</strong> (imports, removals, Amazon returns reports, and generators).
        Physical warehouse scans are normalized in the{" "}
        <Link href="/returns/claims" className="claim-engine-link">
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
