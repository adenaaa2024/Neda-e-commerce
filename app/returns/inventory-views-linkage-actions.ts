"use server";

import { createClient } from "@supabase/supabase-js";

import type {
  NedaInventoryPackageStatusRow,
  NedaInventoryViewsReadResponse,
} from "@/lib/inventory-views-neda-read-contract";
import {
  assessInventoryViewsReadiness,
  buildNedaInventoryItemStatusRow,
  classifyViewLinkage,
  type InventoryViewDbRow,
} from "@/lib/inventory-views-product-linkage";
import {
  preferExactTrackingFilter,
  resolveShipmentIdentityForTrackingPanel,
} from "@/lib/search/shipment-identity-gate";

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key) throw new Error("Supabase service role not configured.");
  return createClient(url, key, { auth: { persistSession: false } });
}

function n(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function mapPackageStatusRow(row: Record<string, unknown>): NedaInventoryPackageStatusRow {
  return {
    organization_id: String(row.organization_id ?? ""),
    store_id: n(row.store_id),
    tracking_number: n(row.tracking_number),
    slip_code: n(row.slip_code) ?? n(row.id_slip_contents),
    package_code: n(row.package_code),
    order_id: n(row.order_id),
    total_expected: Number(row.total_expected) || 0,
    total_scanned: Number(row.total_scanned) || 0,
    status: String(row.status ?? "unknown"),
  };
}

async function fetchPackageStatusRow(
  supabase: ReturnType<typeof serviceClient>,
  opts: {
    organizationId: string;
    storeId?: string | null;
    trackingNumber?: string | null;
    slipCode?: string | null;
    packageCode?: string | null;
  },
): Promise<NedaInventoryPackageStatusRow | null> {
  const tn = opts.trackingNumber?.trim();
  const pc = opts.packageCode?.trim();
  if (!tn && !pc) return null;

  let q = supabase
    .from("v_inventory_status")
    .select("*")
    .eq("organization_id", opts.organizationId)
    .limit(5);
  if (opts.storeId?.trim()) q = q.eq("store_id", opts.storeId.trim());
  if (tn) {
    if (preferExactTrackingFilter(tn)) {
      q = q.eq("tracking_number", tn);
    } else {
      q = q.ilike("tracking_number", `%${tn}%`);
    }
  }
  const sc = opts.slipCode?.trim();
  if (sc) q = q.eq("slip_code", sc);
  if (pc) q = q.eq("package_code", pc);

  const { data, error } = await q;
  if (error || !data?.length) return null;
  return mapPackageStatusRow(data[0] as Record<string, unknown>);
}

/**
 * Read-only: v_inventory_item_status rows enriched with ProductLinkageDisplayContract.
 * Optional v_inventory_status package rollup (status chip only).
 */
export async function fetchInventoryItemStatusForNeda(opts: {
  organizationId: string;
  storeId?: string | null;
  trackingNumber?: string | null;
  slipCode?: string | null;
  /** Warehouse package/carton # (packages.package_code on view). */
  packageCode?: string | null;
  /** When true, skip item rows and only return package_status (chip path). */
  packageStatusOnly?: boolean;
  limit?: number;
}): Promise<{ ok: true; data: NedaInventoryViewsReadResponse } | { ok: false; error: string }> {
  try {
    const supabase = serviceClient();
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);

    const viewsPresent = {
      v_scanned_items_counted: false,
      v_inventory_status: false,
      v_inventory_item_status: false,
    };

    for (const v of Object.keys(viewsPresent) as (keyof typeof viewsPresent)[]) {
      const { error } = await supabase.from(v).select("*", { count: "exact", head: true });
      viewsPresent[v] = !error;
    }

    const packageStatus = viewsPresent.v_inventory_status
      ? await fetchPackageStatusRow(supabase, opts)
      : null;

    if (opts.packageStatusOnly) {
      return {
        ok: true,
        data: {
          item_status_rows: [],
          package_status: packageStatus,
          linkage_readiness: packageStatus ? "PASS" : "PARTIAL",
          views_present: viewsPresent,
          notes: [],
        },
      };
    }

    if (!viewsPresent.v_inventory_item_status) {
      return {
        ok: true,
        data: {
          item_status_rows: [],
          package_status: packageStatus,
          linkage_readiness: "FAIL",
          views_present: viewsPresent,
          notes: ["v_inventory_item_status not present in this environment."],
        },
      };
    }

    let q = supabase
      .from("v_inventory_item_status")
      .select("*")
      .eq("organization_id", opts.organizationId)
      .order("tracking_number", { ascending: true })
      .limit(limit);
    if (opts.storeId?.trim()) q = q.eq("store_id", opts.storeId.trim());
    const tn = opts.trackingNumber?.trim();
    if (tn) {
      let trackingEq = tn;
      if (opts.storeId?.trim() && preferExactTrackingFilter(tn)) {
        const identity = await resolveShipmentIdentityForTrackingPanel(
          supabase,
          opts.organizationId,
          opts.storeId.trim(),
          tn,
        );
        if (identity.tracking_numbers.length === 1) {
          trackingEq = identity.tracking_numbers[0]!;
        }
      }
      if (preferExactTrackingFilter(trackingEq)) {
        q = q.eq("tracking_number", trackingEq);
      } else {
        q = q.ilike("tracking_number", `%${tn}%`);
      }
    }
    const sc = opts.slipCode?.trim();
    if (sc) q = q.eq("slip_code", sc);
    const pc = opts.packageCode?.trim();
    if (pc) q = q.eq("package_code", pc);

    const { data: rows, error } = await q;
    if (error) return { ok: false, error: error.message };

    const sample = (rows?.[0] ?? {}) as Record<string, unknown>;
    const columns = Object.keys(sample);
    const linkageClass = classifyViewLinkage("v_inventory_item_status", columns);

    const itemRows = [];
    for (const row of (rows ?? []) as InventoryViewDbRow[]) {
      itemRows.push(await buildNedaInventoryItemStatusRow(supabase, row, linkageClass));
    }

    const notes: string[] = [];
    if (linkageClass === "identifier_only") {
      notes.push("Item rows enriched at read-time via product_identifier_map (no view DDL).");
    }
    if (packageStatus) {
      notes.push("Package chip from v_inventory_status (aggregate — no product linkage).");
    }

    return {
      ok: true,
      data: {
        item_status_rows: itemRows,
        package_status: packageStatus,
        linkage_readiness: assessInventoryViewsReadiness(viewsPresent, itemRows),
        views_present: viewsPresent,
        notes,
      },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "fetch failed" };
  }
}
