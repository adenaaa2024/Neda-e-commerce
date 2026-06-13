import { Suspense } from "react";
import { Loader2 } from "lucide-react";

import ClaimCenterCandidatesPageClient from "./ClaimCenterCandidatesPageClient";

export default function ClaimCenterCandidatesPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading candidates…
        </div>
      }
    >
      <ClaimCenterCandidatesPageClient />
    </Suspense>
  );
}
