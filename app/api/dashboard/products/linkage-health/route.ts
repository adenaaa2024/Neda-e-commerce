import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { fetchLinkageHealthSnapshot } from "@/lib/product-linkage-health";
import {
  RESOLUTION_ORDER_OPERATIONAL,
  RESOLUTION_ORDER_SCANNER,
  formatResolutionOrderExport,
} from "@/lib/product-linkage-resolution-policy";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

/**
 * GET /api/dashboard/products/linkage-health?organization_id=<uuid>
 * Read-only linkage health metrics for operator dashboards.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();

  if (!isUuidString(organizationId)) {
    return NextResponse.json(
      { ok: false, error: "organization_id query parameter must be a valid UUID." },
      { status: 400 },
    );
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const snapshot = await fetchLinkageHealthSnapshot(supabaseServer, organizationId);

  return NextResponse.json({
    ok: true,
    resolution_order: {
      scanner: RESOLUTION_ORDER_SCANNER,
      operational_import: RESOLUTION_ORDER_OPERATIONAL,
      scanner_formatted: formatResolutionOrderExport("scanner"),
      operational_formatted: formatResolutionOrderExport("operational_import"),
    },
    unresolved_count: snapshot.unresolved_count,
    ambiguous_count: snapshot.ambiguous_count,
    duplicate_risks: snapshot.duplicate_risks,
    linkage_health: snapshot.linkage_health,
    operational_tables: snapshot.operational_tables,
    spine: snapshot.spine,
    generated_at: snapshot.generated_at,
    SAFE_FOR_PRODUCT_STORY: snapshot.linkage_health.safe_for_product_story,
  });
}
