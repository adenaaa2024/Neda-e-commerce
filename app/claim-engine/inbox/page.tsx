import { resolveOrganizationId } from "../../../lib/organization";
import { isUuidString } from "../../../lib/uuid";
import { supabaseServer } from "../../../lib/supabase-server";
import { ClaimInboxClient } from "./ClaimInboxClient";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ candidate_id?: string; draft_id?: string }>;
};

export default async function ClaimInboxPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const initialCandidateId = String(sp.candidate_id ?? "").trim() || null;
  const initialDraftId = String(sp.draft_id ?? "").trim() || null;
  const organizationId = resolveOrganizationId();

  const { data: osRow } = await supabaseServer
    .from("organization_settings")
    .select("default_store_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  const rawDefault = (osRow as { default_store_id?: string | null } | null)?.default_store_id;
  const defaultStoreId =
    typeof rawDefault === "string" && isUuidString(rawDefault) ? rawDefault : null;

  return (
    <ClaimInboxClient
      organizationId={organizationId}
      defaultStoreId={defaultStoreId}
      initialCandidateId={initialCandidateId}
      initialDraftId={initialDraftId}
    />
  );
}
