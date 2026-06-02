import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { listReturnsClaimsWorkQueue } from "@/app/returns/returns-claims-work-queue-actions";
import { assertStoreBelongsToOrganization } from "@/lib/claim-org-scope";
import { isUuidString } from "@/lib/uuid";

const PREVIEW_LIMIT = 50;

/** Read-only physical return_items / draft-pool preview for claim intake. No writes. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  const storeId = String(url.searchParams.get("store_id") ?? "").trim() || null;
  const limit = Math.min(
    PREVIEW_LIMIT,
    Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? String(PREVIEW_LIMIT), 10) || PREVIEW_LIMIT),
  );

  if (!isUuidString(organizationId)) {
    return NextResponse.json({ ok: false, error: "organization_id must be a UUID." }, { status: 400 });
  }

  const access = await assertUserCanAccessOrganization(organizationId);
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, error: access.error },
      { status: access.error === "Not signed in." ? 401 : 403 },
    );
  }

  if (storeId) {
    if (!isUuidString(storeId)) {
      return NextResponse.json({ ok: false, error: "store_id must be a UUID when provided." }, { status: 400 });
    }
    const storeOk = await assertStoreBelongsToOrganization(organizationId, storeId);
    if (!storeOk.ok) {
      return NextResponse.json({ ok: false, error: storeOk.error }, { status: storeOk.status });
    }
  }

  const result = await listReturnsClaimsWorkQueue({ filterOrganizationId: organizationId, actorProfileId: null });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error ?? "Failed to load physical returns." }, { status: 500 });
  }

  let rows = result.rows;
  if (storeId) {
    rows = rows.filter((r) => r.store_id === storeId);
  }

  const preview = rows.slice(0, limit).map((r) => ({
    return_item_id: r.return_item_id,
    store_id: r.store_id,
    created_at: r.created_at,
    queue_state: r.queue_state,
    state_label: r.state_label,
    sku: r.sku,
    fnsku: r.fnsku,
    asin: r.asin,
    item_name: r.item_name,
    scanner_issue_type: r.scanner_issue_type,
    scanner_issue_label: r.scanner_issue_label,
    claim_case_id: r.claim_case_id ?? null,
    claim_submission_id: r.claim_submission_id ?? null,
    flow_stage: r.flow_stage ?? null,
    flow_stage_label: r.flow_stage_label ?? null,
    resolved_product_id: r.resolved_product_id ?? r.resolved_catalog_product_id ?? null,
  }));

  return NextResponse.json({
    ok: true,
    source: "draft_pool",
    returns_domain_enabled: result.returns_domain_enabled,
    stats: {
      ...result.stats,
      preview_count: preview.length,
      total_after_store_filter: rows.length,
    },
    rows: preview,
    draft_pool_href: "/returns/claims",
    scanner_href: "/scanner/operator-mobile/scan",
  });
}
