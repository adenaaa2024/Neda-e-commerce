import Link from "next/link";

import { ClaimEnginePageShell } from "./ClaimEnginePageShell";

type ClaimEngineFeatureDisabledProps = {
  title: string;
  description: string;
  envVars: { name: string; description: string }[];
  alternateHref?: { href: string; label: string };
};

export function ClaimEngineFeatureDisabled({
  title,
  description,
  envVars,
  alternateHref,
}: ClaimEngineFeatureDisabledProps) {
  return (
    <ClaimEnginePageShell title={title} description={description}>
      <div className="rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-950 dark:border-amber-800/50 dark:bg-amber-950/25 dark:text-amber-100">
        <p className="font-semibold">Feature disabled on this environment</p>
        <p className="mt-1 text-xs">The physical-scan path (Draft pool → Cases → Submission queue) still works without these flags.</p>
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-950/80">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Required environment variables</p>
        <ul className="mt-3 space-y-2 text-sm text-slate-700 dark:text-slate-300">
          {envVars.map((v) => (
            <li key={v.name} className="flex flex-wrap items-baseline gap-2">
              <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">{v.name}=true</code>
              <span className="text-muted-foreground">{v.description}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-muted-foreground">
          After enabling, redeploy or restart. Meanwhile:{" "}
          <Link href="/returns/claims" className="font-medium text-sky-600 underline dark:text-sky-400">
            Draft pool
          </Link>
          ,{" "}
          <Link href="/claim-engine/cases" className="font-medium text-sky-600 underline dark:text-sky-400">
            Cases
          </Link>
          ,{" "}
          <Link href="/claim-engine" className="font-medium text-sky-600 underline dark:text-sky-400">
            Submission queue
          </Link>
          .
        </p>
        {alternateHref ? (
          <Link
            href={alternateHref.href}
            className="mt-4 inline-flex text-sm font-medium text-violet-700 hover:text-violet-600 dark:text-violet-300"
          >
            {alternateHref.label}
          </Link>
        ) : null}
      </div>
    </ClaimEnginePageShell>
  );
}
