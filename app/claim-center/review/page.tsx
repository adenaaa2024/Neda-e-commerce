import { Suspense } from "react";
import { Loader2 } from "lucide-react";

import ClaimCenterReviewAliasClient from "./ClaimCenterReviewAliasClient";

/** Backward-compatible alias — primary nav uses /candidates?filter=needs_review (no redirect). */
export default function ClaimCenterReviewAliasPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-2 py-12 text-sm opacity-70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading review queue…
        </div>
      }
    >
      <ClaimCenterReviewAliasClient />
    </Suspense>
  );
}
