import Link from "next/link";
import { notFound } from "next/navigation";

import { supabaseServer } from "@/lib/supabase-server";
import { resolvePimDisplayImageUrl } from "@/lib/pim-display-image";
import { isUuidString } from "@/lib/uuid";

type Row = Record<string, unknown>;

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function display(v: unknown): string {
  return text(v) ?? "—";
}

function productTitle(product: Row): string {
  return text(product.product_name) ?? text(product.name) ?? text(product.sku) ?? "Product";
}

function idShort(v: unknown): string {
  const s = text(v);
  return s ? `${s.slice(0, 8)}…` : "—";
}

function FieldGrid({ rows }: { rows: { label: string; value: unknown }[] }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((row) => (
        <div key={row.label} className="rounded-xl border border-border bg-card p-3">
          <dt className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{row.label}</dt>
          <dd className="mt-1 break-words font-mono text-sm text-foreground">{display(row.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function SimpleTable({
  title,
  description,
  rows,
  columns,
}: {
  title: string;
  description?: string;
  rows: Row[];
  columns: { key: string; label: string; render?: (row: Row) => string }[];
}) {
  return (
    <section className="rounded-2xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-bold text-foreground">{title}</h2>
        {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                {columns.map((col) => (
                  <th key={col.key} className="px-3 py-2 font-bold">
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row, idx) => (
                <tr key={`${title}:${idx}`}>
                  {columns.map((col) => (
                    <td key={col.key} className="max-w-[260px] break-words px-3 py-2 align-top">
                      {col.render ? col.render(row) : display(row[col.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-4 py-4 text-xs text-muted-foreground">No rows found.</p>
      )}
    </section>
  );
}

async function loadProduct(productId: string) {
  const { data } = await supabaseServer
    .from("products")
    .select("*")
    .eq("id", productId)
    .maybeSingle();
  return (data as Row | null) ?? null;
}

async function loadRows(product: Row, productId: string) {
  const organizationId = text(product.organization_id);
  const storeId = text(product.store_id);

  const mapsQuery = supabaseServer
    .from("product_identifier_map")
    .select("*")
    .eq("product_id", productId)
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .limit(100);
  const returnItemsQuery = supabaseServer
    .from("return_items")
    .select("id, item_name, asin, fnsku, sku, product_identifier, resolved_product_id, product_id, identifier_resolution_status, package_id, pallet_id, store_id, created_at")
    .or(`resolved_product_id.eq.${productId},product_id.eq.${productId}`)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  const expectedQuery = supabaseServer
    .from("expected_packages")
    .select("id, order_id, tracking_number, sku, fnsku, resolved_product_id, identifier_resolution_status, expected_scan_quantity, store_id, created_at")
    .eq("resolved_product_id", productId)
    .order("created_at", { ascending: false })
    .limit(50);
  const afiQuery = supabaseServer
    .from("amazon_amazon_fulfilled_inventory")
    .select("id, seller_sku, fulfillment_channel_sku, asin, quantity_available, resolved_product_id, product_id, identifier_resolution_status, store_id, updated_at")
    .or(`resolved_product_id.eq.${productId},product_id.eq.${productId}`)
    .limit(50);
  const fbaQuery = supabaseServer
    .from("amazon_fba_inventory")
    .select("id, sku, fnsku, asin, product_name, quantity, available, resolved_product_id, product_id, identifier_resolution_status, store_id, updated_at")
    .or(`resolved_product_id.eq.${productId},product_id.eq.${productId}`)
    .limit(50);
  const manageFbaQuery = supabaseServer
    .from("amazon_manage_fba_inventory")
    .select("id, sku, fnsku, asin, product_name, afn_fulfillable_quantity, resolved_product_id, product_id, identifier_resolution_status, store_id, updated_at")
    .or(`resolved_product_id.eq.${productId},product_id.eq.${productId}`)
    .limit(50);

  if (organizationId) {
    mapsQuery.eq("organization_id", organizationId);
    returnItemsQuery.eq("organization_id", organizationId);
    expectedQuery.eq("organization_id", organizationId);
    afiQuery.eq("organization_id", organizationId);
    fbaQuery.eq("organization_id", organizationId);
    manageFbaQuery.eq("organization_id", organizationId);
  }
  if (storeId) {
    mapsQuery.eq("store_id", storeId);
  }

  const [maps, returnItems, expected, afi, fba, manageFba] = await Promise.all([
    mapsQuery,
    returnItemsQuery,
    expectedQuery,
    afiQuery,
    fbaQuery,
    manageFbaQuery,
  ]);

  const sourceEvidence = [
    ...(((afi.data ?? []) as Row[]).map((row) => ({ ...row, source_table: "amazon_amazon_fulfilled_inventory" }))),
    ...(((fba.data ?? []) as Row[]).map((row) => ({ ...row, source_table: "amazon_fba_inventory" }))),
    ...(((manageFba.data ?? []) as Row[]).map((row) => ({ ...row, source_table: "amazon_manage_fba_inventory" }))),
  ];

  return {
    maps: (maps.data ?? []) as Row[],
    returnItems: (returnItems.data ?? []) as Row[],
    expected: (expected.data ?? []) as Row[],
    sourceEvidence,
  };
}

export default async function ProductProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>;
  searchParams: Promise<{ back?: string }>;
}) {
  const { productId } = await params;
  const { back } = await searchParams;
  if (!isUuidString(productId)) notFound();

  const product = await loadProduct(productId);
  if (!product) notFound();

  const rows = await loadRows(product, productId);
  const title = productTitle(product);
  const displayImageUrl = resolvePimDisplayImageUrl(product.main_image_url, product.amazon_raw);
  const backHref = back && back.startsWith("/") && !back.startsWith("//") ? back : "/dashboard/products";
  const backLabel = backHref.includes("/returns") ? "Back to returns" : "Back to products";

  return (
    <main className="w-full min-w-0 space-y-6 py-6 lg:py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={backHref} className="text-xs font-medium text-sky-600 hover:underline">
            {backLabel}
          </Link>
          <h1 className="mt-2 text-2xl font-bold text-foreground">{title}</h1>
          <p className="mt-1 font-mono text-xs text-muted-foreground">{productId}</p>
        </div>
        {displayImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={displayImageUrl}
            alt={title}
            className="h-24 w-24 rounded-xl border border-border object-contain"
          />
        ) : null}
      </div>

      <FieldGrid
        rows={[
          { label: "Product ID", value: product.id },
          { label: "Name / title", value: title },
          { label: "Store ID", value: product.store_id },
          { label: "ASIN", value: product.asin },
          { label: "FNSKU", value: product.fnsku },
          { label: "SKU / MSKU", value: product.sku },
          { label: "UPC", value: product.upc_code },
          { label: "Barcode", value: product.barcode },
          { label: "Status", value: product.status },
        ]}
      />

      <SimpleTable
        title="Identifier map rows"
        description="Rows linking identifiers to this canonical product."
        rows={rows.maps}
        columns={[
          { key: "id", label: "Map ID", render: (row) => idShort(row.id) },
          { key: "seller_sku", label: "Seller SKU" },
          { key: "msku", label: "MSKU" },
          { key: "asin", label: "ASIN" },
          { key: "fnsku", label: "FNSKU" },
          { key: "upc_code", label: "UPC" },
          { key: "match_source", label: "Source" },
          { key: "last_seen_at", label: "Last seen" },
        ]}
      />

      <SimpleTable
        title="Source evidence"
        description="Imported Amazon/FBA rows that currently point at this product."
        rows={rows.sourceEvidence}
        columns={[
          { key: "source_table", label: "Source" },
          { key: "id", label: "Row ID", render: (row) => idShort(row.id) },
          { key: "sku", label: "SKU", render: (row) => display(row.sku ?? row.seller_sku) },
          { key: "fnsku", label: "FNSKU", render: (row) => display(row.fnsku ?? row.fulfillment_channel_sku) },
          { key: "asin", label: "ASIN" },
          { key: "identifier_resolution_status", label: "Status" },
          { key: "updated_at", label: "Updated" },
        ]}
      />

      <SimpleTable
        title="Linked return items"
        rows={rows.returnItems}
        columns={[
          { key: "id", label: "Return item", render: (row) => idShort(row.id) },
          { key: "item_name", label: "Item" },
          { key: "sku", label: "SKU" },
          { key: "fnsku", label: "FNSKU" },
          { key: "asin", label: "ASIN" },
          { key: "identifier_resolution_status", label: "Status" },
          { key: "created_at", label: "Created" },
        ]}
      />

      <SimpleTable
        title="Linked expected packages"
        description="Persisted expected_package links, when available."
        rows={rows.expected}
        columns={[
          { key: "id", label: "Expected row", render: (row) => idShort(row.id) },
          { key: "order_id", label: "Order" },
          { key: "tracking_number", label: "Tracking" },
          { key: "sku", label: "SKU" },
          { key: "fnsku", label: "FNSKU" },
          { key: "expected_scan_quantity", label: "Expected qty" },
          { key: "identifier_resolution_status", label: "Status" },
        ]}
      />
    </main>
  );
}
