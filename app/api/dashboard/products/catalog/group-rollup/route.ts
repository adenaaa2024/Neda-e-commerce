import { NextResponse } from "next/server";
import { assertUserCanAccessOrganization } from "../../../../../dashboard/products/pim-actions";
import { isPimInvalidVendorCategoryLabel } from "../../../../../../lib/pim-invalid-label";
import { resolvePimDisplayImageUrl } from "../../../../../../lib/pim-display-image";
import { supabaseServer } from "../../../../../../lib/supabase-server";
import { isUuidString } from "../../../../../../lib/uuid";

export type CatalogGroupDimension =
  | "vendor"
  | "category"
  | "brand"
  | "map_sku"
  | "map_asin"
  | "map_fnsku"
  | "map_upc";

type GroupRow = {
  key: string;
  label: string;
  product_count: number;
  missing_image: number;
  missing_sku: number;
  missing_asin: number;
  missing_fnsku: number;
  missing_upc: number;
  active_count: number;
  /** For applying grid filter */
  filter_vendor_id?: string | null;
  filter_vendor_name?: string | null;
  filter_category_id?: string | null;
  filter_brand?: string | null;
  filter_search?: string | null;
  allow_members?: boolean;
};

function activeStatus(s: string): boolean {
  const x = s.trim().toLowerCase();
  return x === "active" || x === "enabled" || x === "live";
}

function hasDisplayImage(row: { main_image_url?: string | null; amazon_raw?: unknown }): boolean {
  return Boolean(resolvePimDisplayImageUrl(row.main_image_url, row.amazon_raw));
}

function missingSku(p: { sku?: string | null }): boolean {
  return !String(p.sku ?? "").trim();
}
function missingAsin(p: { asin?: string | null }): boolean {
  return !String(p.asin ?? "").trim();
}
function missingFnsku(p: { fnsku?: string | null }): boolean {
  return !String(p.fnsku ?? "").trim();
}
function missingUpc(p: { upc_code?: string | null }): boolean {
  return !String(p.upc_code ?? "").trim();
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  const dimension = String(url.searchParams.get("dimension") ?? "").trim() as CatalogGroupDimension;

  if (!isUuidString(organizationId)) {
    return NextResponse.json({ ok: false, error: "organization_id must be a UUID." }, { status: 400 });
  }
  if (!isUuidString(storeId)) {
    return NextResponse.json({ ok: false, error: "store_id must be a UUID." }, { status: 400 });
  }

  const allowed: CatalogGroupDimension[] = [
    "vendor",
    "category",
    "brand",
    "map_sku",
    "map_asin",
    "map_fnsku",
    "map_upc",
  ];
  if (!allowed.includes(dimension)) {
    return NextResponse.json(
      { ok: false, error: `dimension must be one of: ${allowed.join(", ")}.` },
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

  const { data: products, error: pErr } = await supabaseServer
    .from("products")
    .select(
      "id, sku, asin, fnsku, upc_code, brand, vendor_id, vendor_name, category_id, main_image_url, amazon_raw, status",
    )
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .is("deleted_at", null)
    .limit(15_000);

  if (pErr) {
    return NextResponse.json({ ok: false, error: pErr.message }, { status: 400 });
  }

  const plist = (products ?? []) as {
    id: string;
    sku?: string | null;
    asin?: string | null;
    fnsku?: string | null;
    upc_code?: string | null;
    brand?: string | null;
    vendor_id?: string | null;
    vendor_name?: string | null;
    category_id?: string | null;
    main_image_url?: string | null;
    amazon_raw?: unknown;
    status?: string | null;
  }[];

  const catNameById = new Map<string, string>();
  const { data: cats } = await supabaseServer
    .from("product_categories")
    .select("id, name")
    .eq("organization_id", organizationId);
  for (const c of cats ?? []) {
    const id = String((c as { id?: string }).id ?? "");
    const n = String((c as { name?: string }).name ?? "").trim();
    if (id) catNameById.set(id, n || "—");
  }

  const vendorNameById = new Map<string, string>();
  const { data: vendorRows } = await supabaseServer
    .from("vendors")
    .select("id, name")
    .eq("organization_id", organizationId);
  for (const v of vendorRows ?? []) {
    const id = String((v as { id?: string }).id ?? "").trim();
    const n = String((v as { name?: string }).name ?? "").trim();
    if (id) vendorNameById.set(id, n);
  }

  const VENDOR_NONE = "__no_vendor__";
  const VENDOR_CLEANUP = "__pim_needs_cleanup_vendor__";

  const bump = (m: Map<string, GroupRow>, key: string, label: string, init: Partial<GroupRow>) => {
    let g = m.get(key);
    if (!g) {
      g = {
        key,
        label,
        product_count: 0,
        missing_image: 0,
        missing_sku: 0,
        missing_asin: 0,
        missing_fnsku: 0,
        missing_upc: 0,
        active_count: 0,
        allow_members: true,
        ...init,
      };
      m.set(key, g);
    }
    return g;
  };

  const rows: GroupRow[] = [];

  if (dimension === "vendor") {
    const m = new Map<string, GroupRow>();
    for (const p of plist) {
      const vid = String(p.vendor_id ?? "").trim();
      const vn = String(p.vendor_name ?? "").trim();
      const fromTable = vid ? (vendorNameById.get(vid) ?? "").trim() : "";
      const resolved = fromTable || vn;
      const invalid = Boolean(resolved && isPimInvalidVendorCategoryLabel(resolved));

      if (invalid) {
        const g = bump(m, VENDOR_CLEANUP, "Needs cleanup (invalid vendor label)", {
          filter_vendor_id: null,
          filter_vendor_name: null,
          allow_members: false,
        });
        g.product_count += 1;
        if (!hasDisplayImage(p)) g.missing_image += 1;
        if (missingSku(p)) g.missing_sku += 1;
        if (missingAsin(p)) g.missing_asin += 1;
        if (missingFnsku(p)) g.missing_fnsku += 1;
        if (missingUpc(p)) g.missing_upc += 1;
        if (activeStatus(String(p.status ?? ""))) g.active_count += 1;
        continue;
      }

      if (!vid && !resolved) {
        const g = bump(m, VENDOR_NONE, "Unassigned vendor", {
          filter_vendor_id: null,
          filter_vendor_name: null,
        });
        g.product_count += 1;
        if (!hasDisplayImage(p)) g.missing_image += 1;
        if (missingSku(p)) g.missing_sku += 1;
        if (missingAsin(p)) g.missing_asin += 1;
        if (missingFnsku(p)) g.missing_fnsku += 1;
        if (missingUpc(p)) g.missing_upc += 1;
        if (activeStatus(String(p.status ?? ""))) g.active_count += 1;
        continue;
      }

      if (vid) {
        const label =
          fromTable ||
          vn ||
          `Vendor (${vid.slice(0, 8)}…)`;
        const g = bump(m, vid, label, { filter_vendor_id: vid, filter_vendor_name: null });
        g.product_count += 1;
        if (!hasDisplayImage(p)) g.missing_image += 1;
        if (missingSku(p)) g.missing_sku += 1;
        if (missingAsin(p)) g.missing_asin += 1;
        if (missingFnsku(p)) g.missing_fnsku += 1;
        if (missingUpc(p)) g.missing_upc += 1;
        if (activeStatus(String(p.status ?? ""))) g.active_count += 1;
        continue;
      }

      const slug = resolved.toLowerCase();
      const key = `__vn:${slug}`;
      const g = bump(m, key, resolved, {
        filter_vendor_id: null,
        filter_vendor_name: resolved,
      });
      g.product_count += 1;
      if (!hasDisplayImage(p)) g.missing_image += 1;
      if (missingSku(p)) g.missing_sku += 1;
      if (missingAsin(p)) g.missing_asin += 1;
      if (missingFnsku(p)) g.missing_fnsku += 1;
      if (missingUpc(p)) g.missing_upc += 1;
      if (activeStatus(String(p.status ?? ""))) g.active_count += 1;
    }
    const sorted = [...m.values()].sort((a, b) => b.product_count - a.product_count || a.label.localeCompare(b.label));
    const tail = sorted.filter((r) => r.key === VENDOR_CLEANUP);
    const head = sorted.filter((r) => r.key !== VENDOR_CLEANUP);
    rows.push(...head, ...tail);
  } else if (dimension === "category") {
    const m = new Map<string, GroupRow>();
    for (const p of plist) {
      const cid = String(p.category_id ?? "").trim();
      const label = cid ? catNameById.get(cid) ?? "—" : "No category";
      const key = cid || "__no_category__";
      const g = bump(m, key, label, { filter_category_id: cid || null });
      g.product_count += 1;
      if (!hasDisplayImage(p)) g.missing_image += 1;
      if (missingSku(p)) g.missing_sku += 1;
      if (missingAsin(p)) g.missing_asin += 1;
      if (missingFnsku(p)) g.missing_fnsku += 1;
      if (missingUpc(p)) g.missing_upc += 1;
      if (activeStatus(String(p.status ?? ""))) g.active_count += 1;
    }
    rows.push(...[...m.values()].sort((a, b) => b.product_count - a.product_count || a.label.localeCompare(b.label)));
  } else if (dimension === "brand") {
    const m = new Map<string, GroupRow>();
    for (const p of plist) {
      const b = String(p.brand ?? "").trim();
      const label = b || "—";
      const key = b || "__no_brand__";
      const g = bump(m, key, label, { filter_brand: b || null });
      g.product_count += 1;
      if (!hasDisplayImage(p)) g.missing_image += 1;
      if (missingSku(p)) g.missing_sku += 1;
      if (missingAsin(p)) g.missing_asin += 1;
      if (missingFnsku(p)) g.missing_fnsku += 1;
      if (missingUpc(p)) g.missing_upc += 1;
      if (activeStatus(String(p.status ?? ""))) g.active_count += 1;
    }
    rows.push(...[...m.values()].sort((a, b) => b.product_count - a.product_count || a.label.localeCompare(b.label)));
  } else {
    const col =
      dimension === "map_sku"
        ? "seller_sku"
        : dimension === "map_asin"
          ? "asin"
          : dimension === "map_fnsku"
            ? "fnsku"
            : "upc_code";
    const { data: maps, error: mErr } = await supabaseServer
      .from("product_identifier_map")
      .select(`product_id, ${col}`)
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .limit(25_000);
    if (mErr) {
      return NextResponse.json({ ok: false, error: mErr.message }, { status: 400 });
    }
    const prodById = new Map(plist.map((x) => [x.id, x]));
    const prodSets = new Map<string, Set<string>>();
    for (const row of maps ?? []) {
      const r = row as Record<string, unknown>;
      const pid = String(r.product_id ?? "").trim();
      const val = String(r[col] ?? "").trim();
      if (!val || !pid) continue;
      let s = prodSets.get(val);
      if (!s) {
        s = new Set();
        prodSets.set(val, s);
      }
      s.add(pid);
    }
    for (const [val, ids] of prodSets) {
      let mi = 0,
        ms = 0,
        ma = 0,
        mf = 0,
        mu = 0,
        ac = 0,
        n = 0;
      for (const pid of ids) {
        const p = prodById.get(pid);
        if (!p) continue;
        n += 1;
        if (!hasDisplayImage(p)) mi += 1;
        if (missingSku(p)) ms += 1;
        if (missingAsin(p)) ma += 1;
        if (missingFnsku(p)) mf += 1;
        if (missingUpc(p)) mu += 1;
        if (activeStatus(String(p.status ?? ""))) ac += 1;
      }
      if (n === 0) continue;
      rows.push({
        key: val,
        label: val,
        product_count: n,
        missing_image: mi,
        missing_sku: ms,
        missing_asin: ma,
        missing_fnsku: mf,
        missing_upc: mu,
        active_count: ac,
        filter_search: val,
      });
    }
    rows.sort((a, b) => b.product_count - a.product_count || a.label.localeCompare(b.label));
  }

  return NextResponse.json({ ok: true, dimension, groups: rows });
}
