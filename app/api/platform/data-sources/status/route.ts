/**
 * GET /api/platform/data-sources/status
 *
 * PHASE-DATA-SOURCES-HUB-AND-CLAIM-CENTER-NAV-UNIFICATION-V1
 *
 * Canonical control-plane endpoint for the single Data Sources Hub. Returns the
 * unified per-source status payload from `composeDataSourcesHubStatusV1`. Every
 * status surface (Platform Settings, Claim Center / Sources, Data Coverage,
 * Ready-to-File blockers, Reimbursement Tracking, Product Story sources) reads
 * from this one composer.
 *
 * Read-only. No credentials returned, no Amazon calls, no claim mutation.
 *
 * Query:
 *   ?organization_id= (required, UUID)
 *   ?store_id=        (optional)
 *   ?view=            (optional: control_plane | claim | product, default control_plane)
 */
import { NextResponse } from "next/server";

import { composeDataSourcesHubStatusV1 } from "@/lib/data-sources/data-sources-hub-v1";
import type { DataSourcesHubView } from "@/lib/data-sources/data-sources-hub-contract";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";

const ALLOWED_VIEWS: DataSourcesHubView[] = ["control_plane", "claim", "product"];

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const organizationId = url.searchParams.get("organization_id")?.trim() ?? "";
  const storeId = url.searchParams.get("store_id")?.trim() || null;
  const viewParam = (url.searchParams.get("view")?.trim() ?? "control_plane") as DataSourcesHubView;
  const view = ALLOWED_VIEWS.includes(viewParam) ? viewParam : "control_plane";

  if (!isUuidString(organizationId)) {
    return NextResponse.json(
      { ok: false, error: "organization_id is required and must be a valid UUID." },
      { status: 400 },
    );
  }

  try {
    const payload = await composeDataSourcesHubStatusV1(supabaseServer, organizationId, { view, storeId });
    return NextResponse.json({ ok: true, ...payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to compose data sources hub status.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
