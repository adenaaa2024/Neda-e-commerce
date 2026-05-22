import { isClaimDraftsReviewEnabled } from "../../../lib/claim-drafts-api";
import { resolveOrganizationId } from "../../../lib/organization";
import { ClaimDraftsReviewClient } from "./ClaimDraftsReviewClient";

export const dynamic = "force-dynamic";

export default function ClaimDraftsReviewPage() {
  if (!isClaimDraftsReviewEnabled()) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 p-6 text-slate-900 dark:text-slate-100">
        <h1 className="text-lg font-semibold">Claim drafts review</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          This staging view is disabled. Set the environment variable{" "}
          <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">ENABLE_CLAIM_DRAFTS_REVIEW=true</code>{" "}
          and redeploy to enable read-only access to <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">claim_candidate_drafts</code>.
        </p>
      </div>
    );
  }

  const organizationId = resolveOrganizationId();
  return <ClaimDraftsReviewClient organizationId={organizationId} />;
}
