import { isClaimDraftsReviewEnabled } from "../../../lib/claim-drafts-api";
import { isClaimReviewWorkflowEnabled } from "../../../lib/claim-review-workflow";
import { resolveOrganizationId } from "../../../lib/organization";
import { supabaseServer } from "../../../lib/supabase-server";
import { isUuidString } from "../../../lib/uuid";
import { ClaimReviewOperationsClient } from "./ClaimReviewOperationsClient";
import { ClaimReviewReadOnlyPage } from "./ClaimReviewReadOnlyPage";

export const dynamic = "force-dynamic";

export default async function ClaimReviewOperationsPage() {
  if (!isClaimDraftsReviewEnabled() || !isClaimReviewWorkflowEnabled()) {
    return <ClaimReviewReadOnlyPage />;
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
    <ClaimReviewOperationsClient organizationId={organizationId} defaultStoreId={defaultStoreId} />
  );
}
