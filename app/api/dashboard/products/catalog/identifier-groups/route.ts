import { NextResponse } from "next/server";
import { assertUserCanAccessOrganization } from "../../../../../dashboard/products/pim-actions";
import { supabaseServer } from "../../../../../../lib/supabase-server";
import { isUuidString } from "../../../../../../lib/uuid";

const MODES = new Set(["seller_sku", "asin", "fnsku", "upc_code"]);

/** Aggregated identifier groups from product_identifier_map (RPC). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  const mode = String(url.searchParams.get("mode") ?? "asin").trim();
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSizeRaw = Number.parseInt(url.searchParams.get("page_size") ?? "50", 10);
  const pageSize = [10, 25, 50, 100].includes(pageSizeRaw) ? pageSizeRaw : 50;

  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return NextResponse.json({ ok: false, error: "organization_id and store_id must be UUIDs." }, { status: 400 });
  }
  if (!MODES.has(mode)) {
    return NextResponse.json(
      { ok: false, error: "mode must be seller_sku, asin, fnsku, or upc_code." },
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

  const { data, error } = await supabaseServer.rpc("pim_catalog_identifier_groups", {
    p_organization_id: organizationId,
    p_store_id: storeId,
    p_mode: mode,
    p_page: page,
    p_page_size: pageSize,
  });

  if (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error.message,
        hint: "Apply migration 20260717120000_pim_catalog_identifier_groups_and_sort_upc if this RPC is missing.",
      },
      { status: 400 },
    );
  }

  const payload = (data ?? {}) as Record<string, unknown>;
  return NextResponse.json({
    ok: true,
    mode: payload.mode,
    total: Number(payload.total ?? 0),
    page: Number(payload.page ?? page),
    page_size: Number(payload.page_size ?? pageSize),
    rows: payload.rows ?? [],
  });
}
