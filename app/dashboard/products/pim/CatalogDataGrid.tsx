"use client";

import React, { useEffect, useState } from "react";
import { Image as ImageIcon, Loader2 } from "lucide-react";
import { collectPimAmazonRawGalleryUrls, resolvePimDisplayImageUrl } from "../../../../lib/pim-display-image";
import { dedupeImageUrls } from "./ImageLightbox";
import { IdentifierValue } from "./IdentifierValue";
import type { IdentifierKind } from "./IdentifierValue";

export type PimCatalogRow = Record<string, unknown>;

const SORTABLE = new Set([
  "product_name",
  "sku",
  "asin",
  "fnsku",
  "upc",
  "brand",
  "status",
  "last_seen_at",
  "updated_at",
  "vendor",
  "category",
  "latest_price",
]);

export function formatPrice(row: PimCatalogRow, displayCurrencyFallback = "USD"): string {
  const r = row as unknown as Record<string, unknown>;
  const amt = r.latest_price_amount ?? r.latestPriceAmount;
  const curRaw = r.latest_price_currency ?? r.latestPriceCurrency;
  const trimmed = typeof curRaw === "string" ? curRaw.trim() : "";
  const cur = trimmed.length === 3 ? trimmed.toUpperCase() : displayCurrencyFallback.trim().toUpperCase() || "USD";
  const n = typeof amt === "number" ? amt : typeof amt === "string" ? Number.parseFloat(amt) : Number.NaN;
  if (!Number.isFinite(n)) return "—";
  const code = /^[A-Z]{3}$/.test(cur) ? cur : "USD";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(n);
  } catch {
    return `${code} ${n.toFixed(2)}`;
  }
}

function formatTs(iso: unknown): string {
  if (typeof iso !== "string" || !iso.trim()) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function displaySku(row: PimCatalogRow): string {
  const s = typeof row.sku === "string" ? row.sku.trim() : "";
  if (s) return s;
  const m = typeof row.map_seller_sku === "string" ? row.map_seller_sku.trim() : "";
  return m || "";
}

export function displayAsin(row: PimCatalogRow): string {
  const a = typeof row.asin === "string" ? row.asin.trim() : "";
  if (a) return a;
  const m = typeof row.map_asin === "string" ? row.map_asin.trim() : "";
  return m || "";
}

export function displayFnsku(row: PimCatalogRow): string {
  const f = typeof row.fnsku === "string" ? row.fnsku.trim() : "";
  if (f) return f;
  const m = typeof row.map_fnsku === "string" ? row.map_fnsku.trim() : "";
  return m || "";
}

export function displayUpc(row: PimCatalogRow): string {
  const u = typeof row.upc_code === "string" ? row.upc_code.trim() : "";
  if (u) return u;
  const m = typeof row.map_upc === "string" ? row.map_upc.trim() : "";
  return m || "";
}

const LAYOUT_KEY = "pim-catalog-identifier-layout";

function readIdentifierLayout(): "separate" | "combined" {
  if (typeof window === "undefined") return "separate";
  return window.localStorage.getItem(LAYOUT_KEY) === "combined" ? "combined" : "separate";
}

function ProductCodesStack({ row }: { row: PimCatalogRow }) {
  const lines: { label: string; value: string | null; kind: IdentifierKind }[] = [
    { label: "SKU", value: displaySku(row) || null, kind: "sku" },
    { label: "ASIN", value: displayAsin(row) || null, kind: "asin" },
    { label: "FNSKU", value: displayFnsku(row) || null, kind: "fnsku" },
    { label: "UPC", value: displayUpc(row) || null, kind: "upc" },
  ];
  return (
    <div className="space-y-1 py-0.5">
      {lines.map(({ label, value, kind }) => (
        <div key={label} className="flex min-w-0 items-start gap-2">
          <span className="w-10 shrink-0 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
          <div className="min-w-0 flex-1">
            <IdentifierValue value={value} kind={kind} className="max-w-full gap-0.5 text-[11px]" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function CatalogDataGrid({
  rows,
  total,
  loading,
  page,
  pageSize,
  sort,
  dir,
  onSort,
  onPageChange,
  onPageSizeChange,
  onOpenProduct,
  onEditProduct,
  filtersActive = false,
  onClearFilters,
  onImagePreview,
  displayCurrency = "USD",
}: {
  rows: PimCatalogRow[];
  total: number;
  loading: boolean;
  page: number;
  pageSize: number;
  sort: string;
  dir: string;
  onSort: (col: string) => void;
  onPageChange: (p: number) => void;
  onPageSizeChange: (n: number) => void;
  onOpenProduct: (id: string) => void;
  onEditProduct?: (id: string) => void;
  filtersActive?: boolean;
  onClearFilters?: () => void;
  /** Deduped gallery URLs, primary first */
  onImagePreview?: (urls: string[], startIndex: number) => void;
  /** ISO 4217 when row has no currency (Settings → General). */
  displayCurrency?: string;
}) {
  const [identifierLayout, setIdentifierLayout] = useState<"separate" | "combined">("separate");
  useEffect(() => {
    setIdentifierLayout(readIdentifierLayout());
  }, []);

  const [pageField, setPageField] = useState(String(page));
  useEffect(() => {
    setPageField(String(page));
  }, [page]);

  const combined = identifierLayout === "combined";
  const colCount = combined ? 10 : 13;

  const th = (id: string, label: string) => {
    const active = sort === id;
    return (
      <th className="whitespace-nowrap px-3 py-2.5 text-left text-xs font-medium text-muted-foreground">
        {SORTABLE.has(id) ? (
          <button
            type="button"
            className={[
              "inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted",
              active ? "text-foreground" : "",
            ].join(" ")}
            onClick={() => onSort(id)}
          >
            {label}
            {active ? (dir === "asc" ? " ↑" : " ↓") : ""}
          </button>
        ) : (
          label
        )}
      </th>
    );
  };

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const skeletonRows = loading ? Math.min(pageSize, 12) : 0;
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(total, page * pageSize);

  const goToPage = (p: number) => {
    const next = Math.min(Math.max(1, p), pages);
    onPageChange(next);
  };

  return (
    <div className="w-full max-w-none space-y-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>View mode</span>
          <select
            value={identifierLayout}
            disabled={loading}
            onChange={(e) => {
              const v = e.target.value === "combined" ? "combined" : "separate";
              setIdentifierLayout(v);
              try {
                window.localStorage.setItem(LAYOUT_KEY, v);
              } catch {
                /* ignore */
              }
            }}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs disabled:opacity-50"
          >
            <option value="separate">Separate columns</option>
            <option value="combined">Combined column</option>
          </select>
        </label>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border/60 shadow-sm">
        <table
          className={[
            "w-full max-w-full border-collapse text-left text-sm transition-opacity duration-200",
            combined ? "min-w-[960px]" : "min-w-[1100px]",
            loading && rows.length > 0 ? "opacity-65" : "",
          ].join(" ")}
        >
          <thead className="sticky top-0 z-30 border-b border-border bg-muted/95 backdrop-blur supports-[backdrop-filter]:bg-muted/80">
            <tr>
              {th("image", "Image")}
              {th("product_name", "Product name")}
              {th("vendor", "Vendor")}
              {th("category", "Category")}
              {th("brand", "Brand")}
              {combined ? (
                <th className="min-w-[13rem] max-w-[18rem] px-3 py-2.5 text-left text-xs font-medium text-muted-foreground">
                  Product codes
                </th>
              ) : (
                <>
                  {th("sku", "SKU")}
                  {th("asin", "ASIN")}
                  {th("fnsku", "FNSKU")}
                  {th("upc", "UPC")}
                </>
              )}
              {th("status", "Status")}
              {th("latest_price", "Latest price")}
              {th("last_seen_at", "Last activity")}
              <th className="whitespace-nowrap px-3 py-2.5 text-xs font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="min-h-[24rem]">
            {loading && rows.length === 0 ? (
              Array.from({ length: skeletonRows }, (_, i) => (
                <tr key={`sk-${i}`} className="animate-pulse border-b border-border/30">
                  <td colSpan={colCount} className="h-11 px-3 py-2">
                    <div className="h-8 rounded-md bg-muted/80" />
                  </td>
                </tr>
              ))
            ) : null}
            {!loading && rows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="px-4 py-12 text-center text-muted-foreground">
                  <div className="mx-auto max-w-md space-y-3">
                    <p className="text-sm text-foreground">
                      {filtersActive
                        ? "No products match the current filters."
                        : "No products in this store yet."}
                    </p>
                    {filtersActive && onClearFilters ? (
                      <button
                        type="button"
                        onClick={() => onClearFilters()}
                        className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-muted"
                      >
                        Clear all filters
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ) : null}
            {rows.length > 0
              ? rows.map((row) => {
                const id = String(row.id ?? "");
                const img = resolvePimDisplayImageUrl(row.main_image_url, row.amazon_raw);
                const gallery = collectPimAmazonRawGalleryUrls(row.amazon_raw, 16);
                const previewUrls = dedupeImageUrls([img, ...gallery].filter(Boolean));
                const name = String(row.product_name ?? "—");
                const vendor = String(row.vendor_name ?? "—");
                const cat = String(row.category_name ?? "—");
                const brand = String(row.brand ?? "—");
                const status = String(row.status ?? "—");
                const last = row.last_seen_at ?? row.updated_at;
                return (
                  <tr key={id || `row-${displaySku(row)}`} className="border-b border-border/50 align-middle hover:bg-muted/20">
                    <td className="px-3 py-2 align-middle">
                      {img ? (
                        <button
                          type="button"
                          className="block h-10 w-10 overflow-hidden rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => onImagePreview?.(previewUrls, 0)}
                          title="View image"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={img} alt="" className="h-full w-full object-cover" />
                        </button>
                      ) : previewUrls.length > 0 ? (
                        <button
                          type="button"
                          className="relative block h-10 w-10 overflow-hidden rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => onImagePreview?.(previewUrls, 0)}
                          title="View catalog image"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={previewUrls[0]} alt="" className="h-full w-full object-cover" />
                        </button>
                      ) : (
                        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
                          <ImageIcon className="h-4 w-4" />
                        </div>
                      )}
                    </td>
                    <td
                      className="max-w-[min(22rem,28vw)] min-w-[8rem] whitespace-normal break-words px-3 py-2 align-middle font-medium leading-snug text-foreground"
                      title={name}
                    >
                      {name}
                    </td>
                    <td className="max-w-[14rem] min-w-[6rem] whitespace-normal break-words px-3 py-2 align-middle text-muted-foreground">
                      {vendor}
                    </td>
                    <td className="max-w-[14rem] min-w-[6rem] whitespace-normal break-words px-3 py-2 align-middle text-muted-foreground">
                      {cat}
                    </td>
                    <td className="max-w-[12rem] min-w-[5rem] whitespace-normal break-words px-3 py-2 align-middle text-muted-foreground">
                      {brand}
                    </td>
                    {combined ? (
                      <td className="min-w-[13rem] max-w-[18rem] px-3 py-2 align-middle">
                        <ProductCodesStack row={row} />
                      </td>
                    ) : (
                      <>
                        <td className="w-[1%] min-w-0 max-w-[14rem] whitespace-nowrap px-3 py-2 align-middle">
                          <IdentifierValue value={displaySku(row)} kind="sku" />
                        </td>
                        <td className="w-[1%] min-w-0 max-w-[14rem] whitespace-nowrap px-3 py-2 align-middle">
                          <IdentifierValue value={displayAsin(row) || null} kind="asin" />
                        </td>
                        <td className="w-[1%] min-w-0 max-w-[14rem] whitespace-nowrap px-3 py-2 align-middle">
                          <IdentifierValue value={displayFnsku(row) || null} kind="fnsku" />
                        </td>
                        <td className="w-[1%] min-w-0 max-w-[13rem] whitespace-nowrap px-3 py-2 align-middle">
                          <IdentifierValue value={displayUpc(row) || null} kind="upc" />
                        </td>
                      </>
                    )}
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-muted-foreground">{status}</td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-muted-foreground">{formatPrice(row, displayCurrency)}</td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle text-xs text-muted-foreground">{formatTs(last)}</td>
                    <td className="whitespace-nowrap px-3 py-2 align-middle">
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          onClick={() => onOpenProduct(id)}
                          className="rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium hover:bg-muted"
                        >
                          Details
                        </button>
                        {onEditProduct ? (
                          <button
                            type="button"
                            onClick={() => onEditProduct(id)}
                            className="rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium hover:bg-muted"
                          >
                            Edit
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })
              : null}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <span>
            Showing{" "}
            <span className="tabular-nums text-foreground">
              {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()}
            </span>{" "}
            of <span className="tabular-nums text-foreground">{total.toLocaleString()}</span> product
            {total === 1 ? "" : "s"} · Page {page} of {pages}
          </span>
          {loading ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
              Loading
            </span>
          ) : null}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Per page
            <select
              value={pageSize}
              disabled={loading}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="h-9 rounded-lg border border-border bg-background px-2 text-sm disabled:opacity-50"
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={page <= 1 || loading}
            onClick={() => goToPage(1)}
            className="h-9 rounded-lg border border-border px-2 text-xs hover:bg-muted disabled:opacity-40"
          >
            First
          </button>
          <button
            type="button"
            disabled={page <= 1 || loading}
            onClick={() => goToPage(page - 1)}
            className="h-9 rounded-lg border border-border px-3 text-sm hover:bg-muted disabled:opacity-40"
          >
            Previous
          </button>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Page
            <input
              type="text"
              inputMode="numeric"
              value={pageField}
              disabled={loading}
              onChange={(e) => setPageField(e.target.value.replace(/[^\d]/g, ""))}
              onBlur={() => {
                const n = Number.parseInt(pageField, 10);
                if (!Number.isFinite(n)) setPageField(String(page));
                else goToPage(n);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className="h-9 w-14 rounded-lg border border-border bg-background px-2 text-center text-sm tabular-nums disabled:opacity-50"
              aria-label="Page number"
            />
          </label>
          <button
            type="button"
            disabled={page >= pages || loading}
            onClick={() => goToPage(page + 1)}
            className="h-9 rounded-lg border border-border px-3 text-sm hover:bg-muted disabled:opacity-40"
          >
            Next
          </button>
          <button
            type="button"
            disabled={page >= pages || loading}
            onClick={() => goToPage(pages)}
            className="h-9 rounded-lg border border-border px-2 text-xs hover:bg-muted disabled:opacity-40"
          >
            Last
          </button>
        </div>
      </div>
    </div>
  );
}
