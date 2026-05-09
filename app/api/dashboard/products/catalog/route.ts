import { NextResponse } from "next/server";
import { assertUserCanAccessOrganization } from "../../../../dashboard/products/pim-actions";
import { supabaseServer } from "../../../../../lib/supabase-server";
import { isUuidString } from "../../../../../lib/uuid";

const PAGE_SIZES = new Set([10, 25, 50, 100]);

function parseBool(v: string | null): boolean {
  if (!v) return false;
  const x = v.trim().toLowerCase();
  return x === "1" || x === "true" || x === "yes";
}

function triState(v: string | null): "any" | "has" | "missing" {
  const x = (v ?? "").trim().toLowerCase();
  if (x === "has" || x === "missing") return x;
  return "any";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();

  if (!isUuidString(organizationId)) {
    return NextResponse.json({ ok: false, error: "organization_id must be a UUID." }, { status: 400 });
  }
  if (!isUuidString(storeId)) {
    return NextResponse.json({ ok: false, error: "store_id is required and must be a UUID." }, { status: 422 });
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

  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const rawSize = Number.parseInt(url.searchParams.get("page_size") ?? "25", 10) || 25;
  const pageSize = PAGE_SIZES.has(rawSize) ? rawSize : 25;
  const q = url.searchParams.get("q");
  const vendorId = url.searchParams.get("vendor_id");
  const categoryId = url.searchParams.get("category_id");
  const brand = url.searchParams.get("brand");
  const status = url.searchParams.get("status");
  const matchSource = url.searchParams.get("match_source");
  const sourceReportType = url.searchParams.get("source_report_type");

  const imageFilter = triState(url.searchParams.get("filter_image"));
  const skuFilter = triState(url.searchParams.get("filter_sku"));
  const asinFilter = triState(url.searchParams.get("filter_asin"));
  const fnskuFilter = triState(url.searchParams.get("filter_fnsku"));
  const upcFilter = triState(url.searchParams.get("filter_upc"));
  const vendorPresence = triState(url.searchParams.get("filter_vendor"));
  const categoryPresence = triState(url.searchParams.get("filter_category"));
  const brandFieldFilter = triState(url.searchParams.get("filter_brand_field"));

  const legacyMissingImage = parseBool(url.searchParams.get("missing_image"));
  const legacyMissingAsin = parseBool(url.searchParams.get("missing_asin"));
  const legacyMissingFnsku = parseBool(url.searchParams.get("missing_fnsku"));

  const effectiveImage =
    imageFilter !== "any"
      ? imageFilter
      : legacyMissingImage
        ? "missing"
        : "any";
  const effectiveAsin =
    asinFilter !== "any" ? asinFilter : legacyMissingAsin ? "missing" : "any";
  const effectiveFnsku =
    fnskuFilter !== "any" ? fnskuFilter : legacyMissingFnsku ? "missing" : "any";

  const sortColumn = (url.searchParams.get("sort") ?? "updated_at").trim() || "updated_at";
  const sortDir = (url.searchParams.get("dir") ?? "desc").trim() || "desc";

  const rpcArgs = {
    p_organization_id: organizationId,
    p_store_id: storeId,
    p_page: page,
    p_page_size: pageSize,
    p_q: q?.trim() || null,
    p_vendor_id: vendorId && isUuidString(vendorId) ? vendorId : null,
    p_category_id: categoryId && isUuidString(categoryId) ? categoryId : null,
    p_brand: brand?.trim() || null,
    p_status: status?.trim() || null,
    p_match_source: matchSource?.trim() || null,
    p_source_report_type: sourceReportType?.trim() || null,
    p_image_filter: effectiveImage,
    p_sku_filter: skuFilter,
    p_asin_filter: effectiveAsin,
    p_fnsku_filter: effectiveFnsku,
    p_upc_filter: upcFilter,
    p_vendor_presence: vendorPresence,
    p_category_presence: categoryPresence,
    p_brand_field_filter: brandFieldFilter,
    p_sort_column: sortColumn,
    p_sort_dir: sortDir,
  };

  const { data, error } = await supabaseServer.rpc("pim_catalog_products_page", rpcArgs);

  if (error) {
    const msg = error.message ?? "Catalog query failed.";
    const code = (error as { code?: string }).code;
    const m = msg.toLowerCase();
    const provHint =
      m.includes("field_provenance") && m.includes("does not exist")
        ? " This project’s database may be missing the products.field_provenance column while a catalog SQL function still references it — re-apply the latest PIM catalog migrations from this repo, or align the RPC with your schema."
        : "";
    /** PostgREST / Postgres: only treat as "migration not applied" when the RPC truly is missing from schema cache. */
    const looksLikeMissingRpc =
      code === "42883" ||
      m.includes("could not find the function") ||
      m.includes("undefined_function") ||
      (m.includes("schema cache") && m.includes("pim_catalog_products_page")) ||
      /\bpim_catalog_products_page\b.*\bdoes not exist\b/i.test(msg) ||
      /\bfunction\s+.*pim_catalog_products_page\b.*\bdoes not exist\b/i.test(m);

    if (looksLikeMissingRpc) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Catalog RPC is not available on this database. Apply PIM catalog migrations (e.g. 20260505140000_pim_catalog_identifier_groups_cte_and_filters.sql) to the same project your app uses.",
          details: msg,
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: provHint ? `${msg}${provHint}` : msg,
        details: (error as { details?: string }).details ?? msg,
      },
      { status: 400 },
    );
  }

  const payload =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : { total: 0, rows: [], page, page_size: pageSize };

  return NextResponse.json({
    ok: true,
    total: Number(payload.total ?? 0),
    rows: Array.isArray(payload.rows) ? payload.rows : [],
    page: Number(payload.page ?? page),
    page_size: Number(payload.page_size ?? pageSize),
  });
}
