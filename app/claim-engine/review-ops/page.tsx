import { Suspense } from "react";
import { isClaimDraftsReviewEnabled } from "../../../lib/claim-drafts-api";
import { isClaimReviewWorkflowEnabled } from "../../../lib/claim-review-workflow";
import { resolveOrganizationId } from "../../../lib/organization";
import { supabaseServer } from "../../../lib/supabase-server";
import { isUuidString } from "../../../lib/uuid";
import { ClaimReviewOperationsClient } from "./ClaimReviewOperationsClient";

export const dynamic = "force-dynamic";

export default async function ClaimReviewOperationsPage() {
  if (!isClaimDraftsReviewEnabled() || !isClaimReviewWorkflowEnabled()) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 p-6 text-slate-900 dark:text-slate-100">
        <h1 className="text-lg font-semibold">Claim review operations</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Enable{" "}
          <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">ENABLE_CLAIM_DRAFTS_REVIEW=true</code> and{" "}
          <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">ENABLE_CLAIM_REVIEW_WORKFLOW=true</code>{" "}
          to use this screen.
        </p>
      </div>
    );
  }

  const organizationId = resolveOrganizationId();
  const { data: osRow } = await supabaseServer
    .from("organization_settings")
    .select("default_store_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const rawDefault = (osRow as { default_store_id?: string | null } | null)?.default_store_id;
  const defaultStoreId = typeof rawDefault === "string" && isUuidString(rawDefault) ? rawDefault : null;

  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-[1400px] p-4 text-sm text-slate-600 dark:text-slate-400">Loading review operations…</div>
      }
    >
      <ClaimReviewOperationsClient organizationId={organizationId} defaultStoreId={defaultStoreId} />
    </Suspense>
  );
}
