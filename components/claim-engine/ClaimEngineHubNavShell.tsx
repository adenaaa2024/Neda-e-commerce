import { Suspense } from "react";

import { ClaimEngineHubNav } from "./ClaimEngineHubNav";

function HubNavFallback() {
  return (
    <div
      className="h-9 animate-pulse rounded-xl border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-900/60"
      aria-hidden
    />
  );
}

/** Hub nav with Suspense boundary (required for useSearchParams). */
export function ClaimEngineHubNavShell({ className = "" }: { className?: string }) {
  return (
    <Suspense fallback={<HubNavFallback />}>
      <ClaimEngineHubNav className={className} />
    </Suspense>
  );
}
