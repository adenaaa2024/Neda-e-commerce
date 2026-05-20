"use server";

import { createClient } from "@supabase/supabase-js";

import {
  assessLinkageReadiness,
  buildNedaExpectedPackageReadRow,
  probeExpectedPackagesSchema,
  type ExpectedPackageDbRow,
} from "@/lib/expected-packages-product-linkage";
import type { NedaExpectedPackagesReadResponse } from "@/lib/expected-packages-neda-read-contract";

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key) throw new Error("Supabase service role not configured.");
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Read-only Neda contract: expected_packages rows with ProductLinkageDisplayContract
 * and scanned quantity from return_items (tracking + sku/fnsku match).
 */
export async function fetchExpectedPackagesNedaRead(opts: {
  organizationId: string;
  storeId?: string | null;
  orderId?: string | null;
  trackingNumber?: string | null;
  limit?: number;
}): Promise<{ ok: true; data: NedaExpectedPackagesReadResponse } | { ok: false; error: string }> {
  try {
    const supabase = serviceClient();
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    let q = supabase
      .from("expected_packages")
      .select("*")
      .eq("organization_id", opts.organizationId)
      .order("order_id", { ascending: true })
      .limit(limit);
    if (opts.storeId?.trim()) q = q.eq("store_id", opts.storeId.trim());
    if (opts.orderId?.trim()) q = q.eq("order_id", opts.orderId.trim());
    if (opts.trackingNumber?.trim()) {
      q = q.ilike("tracking_number", opts.trackingNumber.trim());
    }
    const { data: epRows, error: epErr } = await q;
    if (epErr) return { ok: false, error: epErr.message };

    const schema = await probeExpectedPackagesSchema(supabase);
    const rows = (epRows ?? []) as ExpectedPackageDbRow[];

    const detailIds = [
      ...new Set(
        rows.map((r) => n(r.source_detail_row_id)).filter((x): x is string => !!x),
      ),
    ];
    const asinByDetail = new Map<string, string | null>();
    if (detailIds.length > 0) {
      const { data: removals } = await supabase
        .from("amazon_removals")
        .select("id, asin")
        .in("id", detailIds.slice(0, 200));
      for (const r of removals ?? []) {
        const rec = r as { id: string; asin?: string | null };
        asinByDetail.set(String(rec.id), n(rec.asin));
      }
    }

    const out: NedaExpectedPackagesReadResponse["rows"] = [];
    for (const row of rows) {
      const scanned = await countScannedForExpectedRow(supabase, row);
      const detailId = n(row.source_detail_row_id);
      const asinFromDetail = detailId ? asinByDetail.get(detailId) ?? null : null;
      out.push(await buildNedaExpectedPackageReadRow(supabase, row, scanned, { asinFromDetail }));
    }

    const notes: string[] = [];
    if (!schema.has_resolver_columns) {
      notes.push("No persisted resolved_product_id on expected_packages — linkage is read-time via identifier_map only.");
    }

    const data: NedaExpectedPackagesReadResponse = {
      rows: out,
      linkage_readiness: assessLinkageReadiness(schema, out),
      schema_has_resolver_columns: schema.has_resolver_columns,
      notes,
    };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "fetch failed" };
  }
}

function n(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

async function countScannedForExpectedRow(
  supabase: ReturnType<typeof serviceClient>,
  row: ExpectedPackageDbRow,
): Promise<number> {
  const orgId = String(row.organization_id);
  const sku = n(row.sku);
  const fnsku = n(row.fnsku);
  const tn = n(row.tracking_number);
  if (!tn && !n(row.order_id)) return 0;

  let pkgQ = supabase.from("packages").select("id").eq("organization_id", orgId);
  if (tn) pkgQ = pkgQ.ilike("tracking_number", tn);
  else if (n(row.order_id)) pkgQ = pkgQ.eq("order_id", n(row.order_id)!);
  const { data: pkgs } = await pkgQ;
  const pkgIds = (pkgs ?? []).map((p) => String((p as { id: string }).id));
  if (pkgIds.length === 0) return 0;

  let riQ = supabase
    .from("return_items")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .in("package_id", pkgIds);
  if (n(row.store_id)) riQ = riQ.eq("store_id", n(row.store_id)!);
  if (fnsku) riQ = riQ.eq("fnsku", fnsku);
  else if (sku) riQ = riQ.eq("sku", sku);
  const { count } = await riQ;
  return count ?? 0;
}
