import { NextResponse } from "next/server";
import { assertUserCanAccessOrganization } from "../../../../../dashboard/products/pim-actions";
import { supabaseServer } from "../../../../../../lib/supabase-server";
import { isUuidString } from "../../../../../../lib/uuid";

const MAX_IDS = 500;

function parseUniqueUuids(raw: unknown): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "product_ids must be a non-empty array of UUID strings." };
  }
  if (raw.length > MAX_IDS) {
    return { ok: false, error: `At most ${MAX_IDS} product ids per request.` };
  }
  const seen = new Set<string>();
  for (const x of raw) {
    if (typeof x !== "string") continue;
    const t = x.trim();
    if (isUuidString(t)) seen.add(t);
  }
  const ids = [...seen];
  if (!ids.length) {
    return { ok: false, error: "Provide at least one valid UUID in product_ids." };
  }
  return { ok: true, ids };
}

/** POST soft-delete (default): sets products.deleted_at for org + store scoped ids. */
export async function POST(req: Request) {
  let body: {
    organization_id?: string;
    store_id?: string;
    product_ids?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const organizationId = String(body.organization_id ?? "").trim();
  const storeId = String(body.store_id ?? "").trim();
  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return NextResponse.json(
      { ok: false, error: "organization_id and store_id must be UUIDs." },
      { status: 400 },
    );
  }

  const parsed = parseUniqueUuids(body.product_ids);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const { data: storeRow, error: storeErr } = await supabaseServer
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (storeErr || !storeRow) {
    return NextResponse.json({ ok: false, error: "Store not found for this organization." }, { status: 400 });
  }

  const { data, error } = await supabaseServer.rpc("pim_catalog_products_soft_delete", {
    p_organization_id: organizationId,
    p_store_id: storeId,
    p_product_ids: parsed.ids,
  });

  if (error) {
    const msg = error.message ?? "Soft delete failed.";
    const m = msg.toLowerCase();
    const looksMissing =
      m.includes("pim_catalog_products_soft_delete") &&
      (m.includes("does not exist") || m.includes("schema cache") || (error as { code?: string }).code === "42883");
    if (looksMissing) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Soft delete RPC is not available. Apply migration 20260719140000_pim_products_soft_delete_and_delete_preview.sql.",
          details: msg,
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }

  const row = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (row && row.ok === false) {
    return NextResponse.json(row, { status: 400 });
  }
  return NextResponse.json(data ?? { ok: false, error: "No response from soft delete." });
}
