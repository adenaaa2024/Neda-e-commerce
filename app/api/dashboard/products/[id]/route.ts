import { NextResponse } from "next/server";
import { assertUserCanAccessOrganization } from "../../../../dashboard/products/pim-actions";
import { supabaseServer } from "../../../../../lib/supabase-server";
import { upsertPrimaryIdentifierMapForPim } from "../../../../../lib/pim-product-map-upsert";
import { normalizePimProductCategoryRow } from "../../../../../lib/pim-product-category-normalize";
import { derivePimCategorySourceLabel, derivePimPriceOriginLabel } from "../../../../../lib/pim-product-display-sources";
import { derivePimPriceMissingReasonForProductDetail } from "../../../../../lib/pim-price-missing-reason";
import { mergePimProductAttributesMetadata, normalizePimProductStatus } from "../../../../../lib/pim-product-status";
import { isUuidString } from "../../../../../lib/uuid";

function emptyToNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function mergeMetadataPimNotes(prev: unknown, notes: string | null): Record<string, unknown> {
  const base =
    prev && typeof prev === "object" && !Array.isArray(prev) ? { ...(prev as unknown as Record<string, unknown>) } : {};
  const pimUi =
    base.pim_ui && typeof base.pim_ui === "object" && !Array.isArray(base.pim_ui)
      ? { ...(base.pim_ui as unknown as Record<string, unknown>) }
      : {};
  if (notes != null && notes.trim()) {
    pimUi.notes = notes.trim();
    pimUi.notes_updated_at = new Date().toISOString();
  } else {
    delete pimUi.notes;
    delete pimUi.notes_updated_at;
  }
  if (Object.keys(pimUi).length) base.pim_ui = pimUi;
  else delete base.pim_ui;
  return base;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: productId } = await ctx.params;
  if (!isUuidString(productId)) {
    return NextResponse.json({ ok: false, error: "Invalid product id." }, { status: 400 });
  }
  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  if (!isUuidString(organizationId) || !isUuidString(storeId)) {
    return NextResponse.json({ ok: false, error: "organization_id and store_id are required UUIDs." }, { status: 400 });
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
    .select("*")
    .eq("id", productId)
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .is("deleted_at", null)
    .maybeSingle();
  if (pErr || !product) {
    return NextResponse.json({ ok: false, error: "Product not found." }, { status: 404 });
  }

  const pr = product as { category_id?: string | null; vendor_id?: string | null; vendor_name?: string | null };
  let vendorDisplayName: string | null = null;
  const vid = pr.vendor_id != null ? String(pr.vendor_id).trim() : "";
  if (vid && isUuidString(vid)) {
    const { data: vrow } = await supabaseServer
      .from("vendors")
      .select("name")
      .eq("id", vid)
      .eq("organization_id", organizationId)
      .maybeSingle();
    const vn = vrow && typeof (vrow as { name?: string }).name === "string" ? (vrow as { name: string }).name.trim() : "";
    vendorDisplayName = vn || null;
  }
  if (!vendorDisplayName && typeof pr.vendor_name === "string" && pr.vendor_name.trim()) {
    vendorDisplayName = pr.vendor_name.trim();
  }

  let categoryName: string | null = null;
  const cid = pr.category_id != null ? String(pr.category_id).trim() : "";
  if (cid) {
    const { data: crow } = await supabaseServer
      .from("product_categories")
      .select("*")
      .eq("id", cid)
      .eq("organization_id", organizationId)
      .maybeSingle();
    const normalized = crow && typeof crow === "object" ? normalizePimProductCategoryRow(crow as unknown as Record<string, unknown>) : null;
    categoryName = normalized?.name?.trim() || null;
  }

  const { data: maps, error: mErr } = await supabaseServer
    .from("product_identifier_map")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("product_id", productId)
    .order("last_seen_at", { ascending: false, nullsFirst: false });
  if (mErr) {
    return NextResponse.json({ ok: false, error: mErr.message }, { status: 400 });
  }

  const { data: prices, error: prErr } = await supabaseServer
    .from("product_prices")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("product_id", productId)
    .order("observed_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (prErr) {
    return NextResponse.json({ ok: false, error: prErr.message }, { status: 400 });
  }

  const priceRows = (prices ?? []) as unknown as Record<string, unknown>[];
  const latestPrice = priceRows.length ? priceRows[0]! : null;
  const p = product as unknown as Record<string, unknown>;
  const pimPriceMissingReason = derivePimPriceMissingReasonForProductDetail({
    hasPriceRow: priceRows.length > 0,
    productMetadata: p.metadata,
  });
  const sku = typeof p.sku === "string" ? p.sku.trim() : "";
  const asin = typeof p.asin === "string" ? p.asin.trim() : "";

  const catalogIds = new Set<string>();
  for (const m of maps ?? []) {
    const cid = (m as { catalog_product_id?: string | null }).catalog_product_id;
    if (cid && isUuidString(cid)) catalogIds.add(cid);
  }

  const catalogRows: Record<string, unknown>[] = [];
  const seenCatalog = new Set<string>();
  const pushCatalog = (rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      const rid = String(row.id ?? "");
      if (!rid || seenCatalog.has(rid)) continue;
      seenCatalog.add(rid);
      catalogRows.push(row);
    }
  };
  if (sku && asin) {
    const { data: both } = await supabaseServer
      .from("catalog_products")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .match({ seller_sku: sku, asin })
      .order("last_seen_at", { ascending: false })
      .limit(50);
    pushCatalog((both ?? []) as unknown as Record<string, unknown>[]);
  }
  if (sku) {
    const { data: bySku } = await supabaseServer
      .from("catalog_products")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .eq("seller_sku", sku)
      .order("last_seen_at", { ascending: false })
      .limit(50);
    pushCatalog((bySku ?? []) as unknown as Record<string, unknown>[]);
  }
  if (asin) {
    const { data: byAsin } = await supabaseServer
      .from("catalog_products")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .eq("asin", asin)
      .order("last_seen_at", { ascending: false })
      .limit(50);
    pushCatalog((byAsin ?? []) as unknown as Record<string, unknown>[]);
  }
  if (catalogIds.size) {
    const { data: byId } = await supabaseServer.from("catalog_products").select("*").in("id", [...catalogIds]);
    pushCatalog((byId ?? []) as unknown as Record<string, unknown>[]);
  }

  const pRec = product as unknown as Record<string, unknown>;
  const productOut: Record<string, unknown> = { ...pRec };
  if (vendorDisplayName) {
    productOut.vendor_name = vendorDisplayName;
  }

  return NextResponse.json({
    ok: true,
    product: productOut,
    category_name: categoryName,
    pim_category_source_label: derivePimCategorySourceLabel(pRec),
    pim_price_storage_label: latestPrice ? "product_prices" : null,
    pim_price_table: "product_prices",
    pim_price_origin_label: derivePimPriceOriginLabel(latestPrice),
    pim_price_missing_reason: pimPriceMissingReason,
    product_identifier_map: maps ?? [],
    product_prices: priceRows,
    catalog_products: catalogRows,
  });
}

type PutBody = {
  organization_id?: string;
  store_id?: string;
  product_name?: string;
  brand?: string | null;
  vendor_name?: string | null;
  vendor_id?: string | null;
  category_id?: string | null;
  sku?: string;
  asin?: string | null;
  fnsku?: string | null;
  upc_code?: string | null;
  mfg_part_number?: string | null;
  status?: string | null;
  condition?: string | null;
  main_image_url?: string | null;
  notes?: string | null;
  product_attributes?: Record<string, unknown> | null;
};

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: productId } = await ctx.params;
  if (!isUuidString(productId)) {
    return NextResponse.json({ ok: false, error: "Invalid product id." }, { status: 400 });
  }
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const organizationId = String(body.organization_id ?? "").trim();
  const storeId = String(body.store_id ?? "").trim();
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

  const { data: existing, error: exErr } = await supabaseServer
    .from("products")
    .select("id, metadata, sku")
    .eq("id", productId)
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .is("deleted_at", null)
    .maybeSingle();
  if (exErr || !existing) {
    return NextResponse.json({ ok: false, error: "Product not found." }, { status: 404 });
  }

  const productName = String(body.product_name ?? "").trim();
  const skuRaw = String(body.sku ?? "").trim();
  if (!productName) {
    return NextResponse.json({ ok: false, error: "product_name is required." }, { status: 400 });
  }
  if (!skuRaw) {
    return NextResponse.json({ ok: false, error: "sku is required." }, { status: 400 });
  }

  let vendorId: string | null = null;
  const vendorIdRaw = body.vendor_id != null ? String(body.vendor_id).trim() : "";
  if (vendorIdRaw) {
    if (!isUuidString(vendorIdRaw)) {
      return NextResponse.json({ ok: false, error: "vendor_id must be a UUID when set." }, { status: 400 });
    }
    const { data: vrow } = await supabaseServer
      .from("vendors")
      .select("id, name")
      .eq("id", vendorIdRaw)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!vrow) {
      return NextResponse.json({ ok: false, error: "vendor_id not found for this organization." }, { status: 400 });
    }
    vendorId = vendorIdRaw;
  }

  let categoryId: string | null = null;
  const categoryIdRaw = body.category_id != null ? String(body.category_id).trim() : "";
  if (categoryIdRaw) {
    if (!isUuidString(categoryIdRaw)) {
      return NextResponse.json({ ok: false, error: "category_id must be a UUID when set." }, { status: 400 });
    }
    const { data: crow } = await supabaseServer
      .from("product_categories")
      .select("id")
      .eq("id", categoryIdRaw)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!crow) {
      return NextResponse.json({ ok: false, error: "category_id not found for this organization." }, { status: 400 });
    }
    categoryId = categoryIdRaw;
  }

  let vendorNameResolved = emptyToNull(body.vendor_name);
  if (vendorId) {
    const { data: vn } = await supabaseServer.from("vendors").select("name").eq("id", vendorId).maybeSingle();
    const n = String((vn as { name?: string } | null)?.name ?? "").trim();
    if (n) vendorNameResolved = n;
  }

  let metadata = mergeMetadataPimNotes((existing as { metadata?: unknown }).metadata, body.notes ?? null);
  if (Object.prototype.hasOwnProperty.call(body, "product_attributes")) {
    metadata = mergePimProductAttributesMetadata(metadata, body.product_attributes ?? null);
  }
  const existingCat = String((existing as { category_id?: unknown }).category_id ?? "").trim();
  const nextCat = categoryId ?? "";
  if (Object.prototype.hasOwnProperty.call(body, "category_id") && nextCat !== existingCat) {
    metadata = { ...metadata, pim_category_source: "manual" };
  }

  const statusNormalized = Object.prototype.hasOwnProperty.call(body, "status")
    ? normalizePimProductStatus(body.status ?? undefined)
    : undefined;

  const updatePayload: Record<string, unknown> = {
    product_name: productName,
    sku: skuRaw,
    brand: emptyToNull(body.brand),
    vendor_name: vendorNameResolved,
    vendor_id: vendorId,
    category_id: categoryId,
    asin: emptyToNull(body.asin),
    fnsku: emptyToNull(body.fnsku),
    upc_code: emptyToNull(body.upc_code),
    mfg_part_number: emptyToNull(body.mfg_part_number),
    ...(statusNormalized !== undefined ? { status: statusNormalized } : {}),
    condition: emptyToNull(body.condition),
    main_image_url: emptyToNull(body.main_image_url),
    metadata,
    last_catalog_sync_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { error: upErr } = await supabaseServer.from("products").update(updatePayload).eq("id", productId);
  if (upErr) {
    return NextResponse.json({ ok: false, error: upErr.message }, { status: 400 });
  }

  const mapRes = await upsertPrimaryIdentifierMapForPim({
    supabase: supabaseServer,
    organizationId,
    storeId,
    productId,
    identifiers: {
      seller_sku: skuRaw,
      asin: emptyToNull(body.asin),
      fnsku: emptyToNull(body.fnsku),
      upc_code: emptyToNull(body.upc_code),
    },
  });
  if (!mapRes.ok) {
    return NextResponse.json({ ok: false, error: mapRes.error }, { status: 409 });
  }

  return NextResponse.json({ ok: true, id: productId });
}

type DeleteBody = {
  organization_id?: string;
  store_id?: string;
  /** `soft` (default) sets `deleted_at`. `hard` removes the row when dependencies are zero or `confirm_hard` is true. */
  mode?: string;
  confirm_hard?: boolean;
};

/**
 * Soft-delete (default) or hard-delete a single catalog product.
 * Hard delete calls `pim_catalog_product_hard_delete`; returns 409 until `confirm_hard: true` when dependencies exist.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: productId } = await ctx.params;
  if (!isUuidString(productId)) {
    return NextResponse.json({ ok: false, error: "Invalid product id." }, { status: 400 });
  }

  let body: DeleteBody;
  try {
    body = (await req.json()) as DeleteBody;
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

  const mode = String(body.mode ?? "soft").trim().toLowerCase();

  if (mode === "soft") {
    const { data, error } = await supabaseServer.rpc("pim_catalog_products_soft_delete", {
      p_organization_id: organizationId,
      p_store_id: storeId,
      p_product_ids: [productId],
    });
    if (error) {
      const msg = error.message ?? "Soft delete failed.";
      return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    }
    const row = data && typeof data === "object" && !Array.isArray(data) ? (data as unknown as Record<string, unknown>) : null;
    const n = Number(row?.soft_deleted_count ?? 0);
    if (!row || row.ok !== true || n < 1) {
      return NextResponse.json(
        { ok: false, error: "Product not found, wrong store, or already archived." },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, mode: "soft", soft_deleted_count: n });
  }

  if (mode === "hard") {
    const { data, error } = await supabaseServer.rpc("pim_catalog_product_hard_delete", {
      p_organization_id: organizationId,
      p_store_id: storeId,
      p_product_id: productId,
      p_confirm_hard: Boolean(body.confirm_hard),
    });
    if (error) {
      const msg = error.message ?? "Hard delete failed.";
      const m = msg.toLowerCase();
      const looksMissing =
        m.includes("pim_catalog_product_hard_delete") &&
        (m.includes("does not exist") || m.includes("schema cache") || (error as { code?: string }).code === "42883");
      if (looksMissing) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Hard delete RPC is not available. Apply migration 20260719140000_pim_products_soft_delete_and_delete_preview.sql.",
            details: msg,
          },
          { status: 503 },
        );
      }
      return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    }
    const row = data && typeof data === "object" && !Array.isArray(data) ? (data as unknown as Record<string, unknown>) : null;
    if (row?.error === "confirm_hard_required") {
      return NextResponse.json(row, { status: 409 });
    }
    if (row?.ok !== true) {
      const st = row?.error === "not_found" ? 404 : 400;
      return NextResponse.json(row ?? { ok: false, error: "Hard delete rejected." }, { status: st });
    }
    return NextResponse.json(data);
  }

  return NextResponse.json({ ok: false, error: "mode must be \"soft\" or \"hard\"." }, { status: 400 });
}
