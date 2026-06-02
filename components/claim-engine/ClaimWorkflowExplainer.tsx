import Link from "next/link";

import { CLAIM_ENGINE_SECTION_CLASS } from "./claim-engine-ui";

const STEPS = [
  {
    term: "Intake",
    body: "Raw claim signals before normalization — imports, scans, and generated claim_candidates.",
    href: "/claim-engine/inbox",
  },
  {
    term: "Draft pool",
    body: "Normalized claimable units (physical return_items with policy gates).",
    href: "/returns/claims",
  },
  {
    term: "Review",
    body: "Operator work items on import/TRID drafts when enabled.",
    href: "/claim-engine/review-ops",
  },
  {
    term: "Cases",
    body: "Grouped internal claim packets (claim_cases + claim_lines).",
    href: "/claim-engine/cases",
  },
  {
    term: "Submissions",
    body: "Outbound filing package and PDF on claim_submissions.",
    href: "/claim-engine",
  },
] as const;

export function ClaimWorkflowExplainer({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        Pipeline:{" "}
        {STEPS.map((s, i) => (
          <span key={s.term}>
            {i > 0 ? " → " : null}
            <Link href={s.href} className="font-medium text-slate-700 underline dark:text-slate-300">
              {s.term}
            </Link>
          </span>
        ))}
        . Active / Closed track marketplace outcomes after submission.
      </p>
    );
  }

  return (
    <div className={CLAIM_ENGINE_SECTION_CLASS}>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Unified claim workflow</p>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {STEPS.map((s) => (
          <div key={s.term}>
            <dt className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              <Link href={s.href} className="hover:underline">
                {s.term}
              </Link>
            </dt>
            <dd className="mt-0.5 text-xs text-muted-foreground">{s.body}</dd>
          </div>
        ))}
        <div>
          <dt className="text-sm font-semibold text-slate-900 dark:text-slate-50">Active / Closed</dt>
          <dd className="mt-0.5 text-xs text-muted-foreground">
            Post-submission marketplace status — filed, investigating, accepted, or rejected.
          </dd>
        </div>
      </dl>
    </div>
  );
}
