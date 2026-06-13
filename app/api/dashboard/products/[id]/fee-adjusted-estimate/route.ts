import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { buildFeeAdjustedEstimate } from "@/lib/fees/fee-adjusted-estimate-readmodel";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: productId } = await ctx.params;
  if (!isUuidString(productId)) {
    return NextResponse.json({ ok: false, error: "Invalid product id." }, { status: 400 });
  }

  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return NextResponse.json(
      { ok: false, error: "organization_id and store_id are required UUIDs." },
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

  const { data: product, error: pErr } = await supabaseServer
    .from("products")
    .select("id")
    .eq("id", productId)
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .is("deleted_at", null)
    .maybeSingle();

  if (pErr || !product) {
    return NextResponse.json({ ok: false, error: "Product not found." }, { status: 404 });
  }

  const estimate = await buildFeeAdjustedEstimate(supabaseServer, organizationId, storeId, productId);

  return NextResponse.json({ ok: true, estimate });
}
