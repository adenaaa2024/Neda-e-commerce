import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "../../../../../dashboard/products/pim-actions";
import { fetchDraftRow } from "../../../../../../lib/claim-evidence-preview";
import { fetchProductLinkageDisplayContract } from "../../../../../../lib/product-linkage-display-enrich";
import { supabaseServer } from "../../../../../../lib/supabase-server";
import { isUuidString } from "../../../../../../lib/uuid";

export const dynamic = "force-dynamic";

const REMOVAL_SELECT =
  "id, sku, fnsku, asin, resolved_product_id, resolved_catalog_product_id, identifier_resolution_status, identifier_resolution_confidence";
const RETURN_SELECT =
  "id, sku, asin, lpn, resolved_product_id, resolved_catalog_product_id, identifier_resolution_status, identifier_resolution_confidence";

export async function GET(req: Request, ctx: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await ctx.params;
  if (!isUuidString(draftId)) {
    return NextResponse.json({ error: "Invalid draft id." }, { status: 400 });
  }

  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  if (!isUuidString(organizationId)) {
    return NextResponse.json({ error: "organization_id must be a UUID." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const draft = await fetchDraftRow(supabaseServer, organizationId, draftId);
  if (!draft) {
    return NextResponse.json({ error: "Draft not found." }, { status: 404 });
  }

  let row: Record<string, unknown> | null = null;
  if (draft.source_table === "amazon_removals") {
    const { data } = await supabaseServer
      .from("amazon_removals")
      .select(REMOVAL_SELECT)
      .eq("organization_id", organizationId)
      .eq("id", draft.source_row_id)
      .maybeSingle();
    row = (data as Record<string, unknown>) ?? null;
  } else if (draft.source_table === "amazon_returns") {
    const { data } = await supabaseServer
      .from("amazon_returns")
      .select(RETURN_SELECT)
      .eq("organization_id", organizationId)
      .eq("id", draft.source_row_id)
      .maybeSingle();
    row = (data as Record<string, unknown>) ?? null;
  }

  if (!row) {
    return NextResponse.json({
      draft_id: draftId,
      organization_id: organizationId,
      source_table: draft.source_table,
      source_row_id: draft.source_row_id,
      product_linkage: null,
      does_not_submit: true,
    });
  }

  const product_linkage = await fetchProductLinkageDisplayContract({
    organizationId,
    source_table: draft.source_table,
    source_row_id: draft.source_row_id,
    row,
  });

  return NextResponse.json({
    draft_id: draftId,
    organization_id: organizationId,
    source_table: draft.source_table,
    source_row_id: draft.source_row_id,
    product_linkage,
    does_not_submit: true,
  });
}
