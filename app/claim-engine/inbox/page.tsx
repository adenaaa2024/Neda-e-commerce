import { resolveOrganizationId } from "../../../lib/organization";
import { isUuidString } from "../../../lib/uuid";
import { supabaseServer } from "../../../lib/supabase-server";
import { ClaimInboxClient } from "./ClaimInboxClient";

export const dynamic = "force-dynamic";

export default async function ClaimInboxPage() {
  const organizationId = resolveOrganizationId();

  const { data: osRow } = await supabaseServer
    .from("organization_settings")
    .select("default_store_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  const rawDefault = (osRow as { default_store_id?: string | null } | null)?.default_store_id;
  const defaultStoreId =
    typeof rawDefault === "string" && isUuidString(rawDefault) ? rawDefault : null;

  return <ClaimInboxClient organizationId={organizationId} defaultStoreId={defaultStoreId} />;
}
