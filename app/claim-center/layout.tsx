import type { ReactNode } from "react";

import { ClaimCenterRootClient } from "@/components/claim-center/ClaimCenterRootClient";
import { resolveOrganizationId } from "@/lib/organization";
import { isUuidString } from "@/lib/uuid";
import { supabaseServer } from "@/lib/supabase-server";

import "./claim-center-theme.css";

export const dynamic = "force-dynamic";

/**
 * Claim Center standalone app layout (Menorix Command Apps pattern).
 * Legacy /claim-engine pages remain unchanged — redirects handled separately after QA.
 */
export default async function ClaimCenterLayout({ children }: { children: ReactNode }) {
  const organizationId = resolveOrganizationId();

  const { data: osRow } = await supabaseServer
    .from("organization_settings")
    .select("default_store_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  const rawDefault = (osRow as { default_store_id?: string | null } | null)?.default_store_id;
  const defaultStoreId = typeof rawDefault === "string" && isUuidString(rawDefault) ? rawDefault : null;

  return (
    <ClaimCenterRootClient organizationId={organizationId} defaultStoreId={defaultStoreId}>
      {children}
    </ClaimCenterRootClient>
  );
}
