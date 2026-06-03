import { Suspense } from "react";

import { ClaimEngineHubNav } from "./ClaimEngineHubNav";

function HubNavFallback() {
  return (
    <div
      className="claim-engine-hub-nav h-9 animate-pulse"
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
