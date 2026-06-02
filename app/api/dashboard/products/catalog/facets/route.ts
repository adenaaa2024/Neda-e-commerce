import { NextResponse } from "next/server";
import { assertUserCanAccessOrganization } from "../../../../../dashboard/products/pim-actions";
import { collectPimCatalogFacets } from "../../../../../../lib/pim-catalog-facets-collect";
import { isUuidString } from "../../../../../../lib/uuid";
import { supabaseServer } from "../../../../../../lib/supabase-server";

/** Distinct facet values for PIM filter dropdowns (org + store scoped). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return NextResponse.json({ ok: false, error: "organization_id and store_id must be UUIDs." }, { status: 400 });
  }
  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const collected = await collectPimCatalogFacets(supabaseServer, organizationId, storeId);
  if (!collected.ok) {
    return NextResponse.json({ ok: false, error: collected.error }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    facets: collected.facets,
  });
}
