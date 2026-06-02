import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import {
  API_INTAKE_SETTINGS_INVENTORY,
  missingSettingsFromInventory,
  sourceToClaimIntakeMap,
} from "@/lib/api-intake-settings-inventory";
import { buildClaimApiIntakeSettingsStatus } from "@/lib/claim-api-intake-settings-status";
import { assertStoreBelongsToOrganization } from "@/lib/claim-org-scope";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

/** Read-only status — no sync, no Amazon API calls. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();

  if (!isUuidString(organizationId)) {
    return NextResponse.json({ ok: false, error: "organization_id must be a UUID." }, { status: 400 });
  }
  if (!isUuidString(storeId)) {
    return NextResponse.json({ ok: false, error: "store_id must be a UUID." }, { status: 400 });
  }

  const access = await assertUserCanAccessOrganization(organizationId);
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, error: access.error },
      { status: access.error === "Not signed in." ? 401 : 403 },
    );
  }

  const storeOk = await assertStoreBelongsToOrganization(organizationId, storeId);
  if (!storeOk.ok) {
    return NextResponse.json({ ok: false, error: storeOk.error }, { status: storeOk.status });
  }

  const status = await buildClaimApiIntakeSettingsStatus({
    client: supabaseServer,
    organizationId,
    storeId,
  });

  return NextResponse.json({
    ok: true,
    api_settings_inventory: API_INTAKE_SETTINGS_INVENTORY,
    source_to_claim_intake_map: sourceToClaimIntakeMap(),
    missing_settings: status.missing_settings,
    sp_api_credentials_configured: status.sp_api_credentials_configured,
    api_flags: status.api_flags,
    sources: status.sources,
    claim_policy_effective: status.claim_policy_effective,
    ui_status_wiring: {
      panel: "ClaimIntakeSourcesPanel + ClaimApiIntakeSettingsPanel",
      endpoint: "/api/claims/intake/settings-status",
      auto_sync_on_load: false,
    },
  });
}
