"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Loader2, Search, X } from "lucide-react";
import { derivePimPriceOriginLabel } from "../../../../lib/pim-product-display-sources";
import { getPimFieldProvenanceObject } from "../../../../lib/pim-field-provenance";
import { IdentifierValue } from "./IdentifierValue";
import { collectPimAmazonRawGalleryUrls, resolvePimDisplayImageUrl } from "../../../../lib/pim-display-image";
import { dedupeImageUrls, ImageLightbox } from "./ImageLightbox";
import { PimHelpNote } from "./PimHelpNote";

const PIM_DRAWER_ATTR_KEY_SKIP = /^(source|import_job|row_hash|pim_import|raw_|_internal|content_sha|classifier|scan_cursor|apply_cursor|module|upload)/i;

function shouldShowPimAttributeKey(k: string): boolean {
  if (!k || k.length > 80) return false;
  if (PIM_DRAWER_ATTR_KEY_SKIP.test(k)) return false;
  if (k.includes("import_job") || k.includes("row_hash")) return false;
  return true;
}

function JsonBlock({ title, description, value }: { title: string; description?: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  let text = "";
  try {
    text = JSON.stringify(value ?? null, null, 2);
  } catch {
    text = String(value);
  }
  const empty = text === "null" || text === "{}" || !text.trim();
  return (
    <div className="rounded-lg border border-border/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-col items-stretch gap-0.5 px-3 py-2 text-left hover:bg-muted/40"
      >
        <span className="text-sm font-medium text-foreground">{title}</span>
        {description ? <span className="text-[11px] leading-snug text-muted-foreground">{description}</span> : null}
        <span className="text-xs text-muted-foreground">{open ? "Hide" : "Show"} JSON</span>
      </button>
      {open ? (
        <pre className="max-h-48 overflow-auto border-t border-border/40 bg-muted/20 p-3 text-[11px] leading-relaxed">
          {empty ? <span className="text-muted-foreground">(empty)</span> : text}
        </pre>
      ) : null}
    </div>
  );
}

/** User-facing row source — never implies live Seller Central (no live status fetch in this UI). */
function listingRowSourceLabel(cp: Record<string, unknown>): string {
  const rt = String(cp.source_report_type ?? "").trim().toLowerCase();
  const meta = cp.metadata;
  const mo = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null;
  const fromEnrichment =
    rt.includes("enrich") ||
    rt.includes("amazon_catalog") ||
    String(mo?.from ?? "").toLowerCase().includes("catalog_items");
  if (fromEnrichment) return "Amazon enrichment";

  if (String(cp.source_report_type ?? "").trim() || String(cp.seller_sku ?? "").trim() || String(cp.asin ?? "").trim()) {
    return "Imported listing status";
  }
  return "Unknown source";
}

function listingStatusCell(cp: Record<string, unknown>): string {
  return String(cp.listing_status ?? "").trim() || "—";
}

export function ProductDetailDrawer({
  organizationId,
  storeId,
  productId,
  onClose,
  onEdit,
}: {
  organizationId: string;
  storeId: string;
  productId: string | null;
  onClose: () => void;
  onEdit?: (productId: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ urls: string[]; index: number } | null>(null);
  const [openAmazon, setOpenAmazon] = useState(false);
  const [openAdvanced, setOpenAdvanced] = useState(false);
  const scrollLockRef = useRef<{ y: number; htmlOverflow: string; bodyOverflow: string } | null>(null);
  const [payload, setPayload] = useState<{
    product: Record<string, unknown>;
    category_name: string | null;
    pim_category_source_label?: string | null;
    pim_price_storage_label?: string | null;
    pim_price_table?: string | null;
    pim_price_origin_label?: string | null;
    pim_price_missing_reason?: string | null;
    product_identifier_map: Record<string, unknown>[];
    product_prices: Record<string, unknown>[];
    catalog_products: Record<string, unknown>[];
  } | null>(null);

  const openLightbox = useCallback((urls: string[], startUrl: string) => {
    const list = dedupeImageUrls(urls);
    if (!list.length) return;
    const idx = Math.max(0, list.indexOf(startUrl));
    setLightbox({ urls: list, index: idx >= 0 ? idx : 0 });
  }, []);

  useLayoutEffect(() => {
    if (!productId) return;
    const y = window.scrollY;
    const htmlOverflow = document.documentElement.style.overflow;
    const bodyOverflow = document.body.style.overflow;
    scrollLockRef.current = { y, htmlOverflow, bodyOverflow };
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => {
      const prev = scrollLockRef.current;
      scrollLockRef.current = null;
      document.documentElement.style.overflow = prev?.htmlOverflow ?? "";
      document.body.style.overflow = prev?.bodyOverflow ?? "";
      if (prev) window.scrollTo(0, prev.y);
    };
  }, [productId]);

  useEffect(() => {
    setLightbox(null);
  }, [productId]);

  const load = useCallback(async () => {
    if (!productId) return;
    setLoading(true);
    setErr(null);
    try {
      const u = new URL(`/api/dashboard/products/${encodeURIComponent(productId)}`, window.location.origin);
      u.searchParams.set("organization_id", organizationId);
      u.searchParams.set("store_id", storeId);
      const res = await fetch(u.toString());
      const data = (await res.json()) as { ok?: boolean; error?: string; product?: Record<string, unknown> };
      if (!res.ok || !data.ok || !data.product) {
        setErr(data.error ?? "Failed to load product.");
        setPayload(null);
        return;
      }
      const full = data as typeof data & {
        category_name?: string | null;
        pim_category_source_label?: string | null;
        pim_price_storage_label?: string | null;
        pim_price_table?: string | null;
        pim_price_origin_label?: string | null;
        pim_price_missing_reason?: string | null;
        product_identifier_map?: Record<string, unknown>[];
        product_prices?: Record<string, unknown>[];
        catalog_products?: Record<string, unknown>[];
      };
      const cn = full.category_name != null && String(full.category_name).trim() ? String(full.category_name).trim() : null;
      setPayload({
        product: full.product!,
        category_name: cn,
        pim_category_source_label: full.pim_category_source_label ?? null,
        pim_price_storage_label: full.pim_price_storage_label ?? null,
        pim_price_table: full.pim_price_table ?? null,
        pim_price_origin_label: full.pim_price_origin_label ?? null,
        pim_price_missing_reason: full.pim_price_missing_reason ?? null,
        product_identifier_map: full.product_identifier_map ?? [],
        product_prices: full.product_prices ?? [],
        catalog_products: full.catalog_products ?? [],
      });
    } catch {
      setErr("Network error.");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [organizationId, storeId, productId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!productId) return null;

  const p = payload?.product;
  const img = p ? resolvePimDisplayImageUrl(p.main_image_url, p.amazon_raw) : null;
  const directMain =
    p && typeof p.main_image_url === "string" && p.main_image_url.trim() ? p.main_image_url.trim() : null;
  const galleryRaw = p ? collectPimAmazonRawGalleryUrls(p.amazon_raw, 16) : [];
  const allPreviewUrls = dedupeImageUrls([directMain, img, ...galleryRaw].filter(Boolean) as string[]);
  const extraGallery = allPreviewUrls.filter((u) => u !== img);

  const statusBadge =
    p && typeof p.status === "string" && p.status.trim() ? (
      <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/50 px-2.5 py-0.5 text-xs font-medium text-foreground">
        {String(p.status).trim()}
      </span>
    ) : null;

  const lastUpdated =
    p && typeof p.last_catalog_sync_at === "string" && p.last_catalog_sync_at
      ? new Date(p.last_catalog_sync_at).toLocaleString()
      : p && typeof p.updated_at === "string" && p.updated_at
        ? new Date(p.updated_at).toLocaleString()
        : null;

  const drawer = (
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center overflow-y-auto overflow-x-hidden bg-black/40 p-3 sm:p-6"
      role="presentation"
      onClick={(e) => {
        if (lightbox) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="my-auto flex min-h-0 w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl max-h-[min(100dvh-2rem,920px)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pim-drawer-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 id="pim-drawer-title" className="text-lg font-semibold text-foreground">
            Product
          </h2>
          <div className="flex shrink-0 items-center gap-1">
            {onEdit && productId ? (
              <button
                type="button"
                onClick={() => onEdit(productId)}
                className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
              >
                Edit
              </button>
            ) : null}
            <button type="button" onClick={onClose} className="rounded-lg p-2 text-muted-foreground hover:bg-muted" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : err ? (
            <p className="text-sm text-destructive">{err}</p>
          ) : p ? (
            <div className="space-y-6">
              <div className="rounded-xl border border-border/70 bg-gradient-to-br from-muted/30 to-transparent p-4">
                <div className="flex gap-4">
                  <button
                    type="button"
                    className="h-28 w-28 shrink-0 overflow-hidden rounded-xl border border-border bg-muted text-left ring-offset-background transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      const start = (img ?? allPreviewUrls[0]) ?? null;
                      if (start) openLightbox(allPreviewUrls, start);
                    }}
                    disabled={allPreviewUrls.length === 0}
                    title={allPreviewUrls.length ? "View larger" : undefined}
                  >
                    {(img || allPreviewUrls[0]) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={(img ?? allPreviewUrls[0])!} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-[10px] text-muted-foreground">No image</span>
                    )}
                  </button>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">{statusBadge}</div>
                    <p className="text-lg font-semibold leading-snug text-foreground">{String(p.product_name ?? "—")}</p>
                    <dl className="grid gap-1 text-sm">
                      <div className="flex flex-wrap gap-x-2">
                        <dt className="text-muted-foreground">Vendor</dt>
                        <dd className="font-medium text-foreground">{String(p.vendor_name ?? "—")}</dd>
                      </div>
                      <div className="flex flex-wrap gap-x-2">
                        <dt className="text-muted-foreground">Brand</dt>
                        <dd className="font-medium text-foreground">{String(p.brand ?? "—")}</dd>
                      </div>
                      <div className="flex flex-wrap gap-x-2">
                        <dt className="text-muted-foreground">Category</dt>
                        <dd className="font-medium text-foreground">{payload?.category_name ?? "—"}</dd>
                      </div>
                      {lastUpdated ? (
                        <div className="pt-1 text-xs text-muted-foreground">Last updated {lastUpdated}</div>
                      ) : null}
                    </dl>
                  </div>
                </div>
              </div>

              {extraGallery.length > 0 ? (
                <section>
                  <h3 className="text-sm font-semibold text-foreground">More images</h3>
                  <p className="mt-1 text-[11px] text-muted-foreground">From saved Amazon catalog data for this product.</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {extraGallery.map((u) => (
                      <button
                        key={u}
                        type="button"
                        className="h-14 w-14 overflow-hidden rounded-lg border border-border bg-muted hover:opacity-90"
                        onClick={() => openLightbox(allPreviewUrls, u)}
                        title="View larger"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={u} alt="" className="h-full w-full object-cover" />
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              <section className="rounded-xl border border-border/60 bg-card/50 p-4">
                <h3 className="text-sm font-semibold text-foreground">Identifiers</h3>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Values on the product record and from imports.</p>
                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                  {(
                    [
                      ["SKU", String(p.sku ?? ""), "sku"],
                      ["ASIN", String(p.asin ?? "").trim(), "asin"],
                      ["FNSKU", String(p.fnsku ?? "").trim(), "fnsku"],
                      ["UPC", String(p.upc_code ?? "").trim(), "upc"],
                      ["MPN", String(p.mfg_part_number ?? "").trim(), "mpn"],
                    ] as const
                  ).map(([label, val, kind]) => (
                    <div key={label} className="min-w-0">
                      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
                      <dd className="mt-1 flex flex-wrap items-center gap-2">
                        {kind === "mpn" ? (
                          <span className="font-mono text-xs text-foreground">{val || "—"}</span>
                        ) : (
                          <IdentifierValue value={val || null} kind={kind as "sku" | "asin" | "fnsku" | "upc"} />
                        )}
                        {val && (kind === "sku" || kind === "asin" || kind === "upc") ? (
                          <a
                            href={`https://www.google.com/search?q=${encodeURIComponent(val)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 text-muted-foreground hover:bg-muted"
                            title="Search web"
                            aria-label={`Search ${label}`}
                          >
                            <Search className="h-3.5 w-3.5" />
                          </a>
                        ) : null}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>

              {(() => {
                const meta = p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata) ? p.metadata : {};
                const pa = (meta as Record<string, unknown>).product_attributes;
                if (!pa || typeof pa !== "object" || Array.isArray(pa)) return null;
                const entries = Object.entries(pa as Record<string, unknown>).filter(
                  ([k, v]) => k && shouldShowPimAttributeKey(k) && v != null && String(v).trim() !== "",
                );
                if (!entries.length) return null;
                const prefer = new Set([
                  "pack_size",
                  "case_pack",
                  "case_cost",
                  "unit_size",
                  "unit_of_measure",
                  "weight",
                  "dimensions",
                  "color",
                  "flavor",
                  "material",
                  "notes",
                ]);
                const sorted = [...entries].sort(([a], [b]) => {
                  const ap = prefer.has(a.toLowerCase()) ? 0 : 1;
                  const bp = prefer.has(b.toLowerCase()) ? 0 : 1;
                  if (ap !== bp) return ap - bp;
                  return a.localeCompare(b);
                });
                return (
                  <section className="rounded-xl border border-border/60 bg-card/50 p-4">
                    <h3 className="text-sm font-semibold text-foreground">Attributes</h3>
                    <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                      {sorted.map(([k, v]) => (
                        <div key={k} className="min-w-0">
                          <dt className="text-xs text-muted-foreground capitalize">{k.replace(/_/g, " ")}</dt>
                          <dd className="break-words text-sm text-foreground">{String(v)}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                );
              })()}

              <section>
                <h3 className="text-sm font-semibold text-foreground">Pricing</h3>
                {(() => {
                  const prices = payload?.product_prices ?? [];
                  if (prices.length === 0) {
                    const why = payload?.pim_price_missing_reason?.trim();
                    return (
                      <div className="mt-1 space-y-2">
                        <p className="text-sm text-muted-foreground">No price data yet.</p>
                        {why ? (
                          <div className="rounded-md border border-border/60 bg-muted/25 px-3 py-2 text-[11px] leading-snug text-foreground">
                            <span className="font-medium text-foreground">Price unavailable: </span>
                            {why}
                          </div>
                        ) : null}
                        <p className="text-[11px] text-muted-foreground">
                          When prices exist, they are stored in <span className="font-medium text-foreground">product_prices</span> with an
                          origin label (Amazon enrichment vs manual/imported). Run catalog enrichment or import listing data — prices are never
                          invented.
                        </p>
                      </div>
                    );
                  }
                  const latest = prices[0];
                  const amtRaw = latest?.amount ?? latest?.price;
                  const amt = amtRaw;
                  const cur = typeof latest?.currency === "string" ? latest.currency : "USD";
                  const n = typeof amt === "number" ? amt : typeof amt === "string" ? Number.parseFloat(amt) : Number.NaN;
                  const label = Number.isFinite(n)
                    ? new Intl.NumberFormat(undefined, { style: "currency", currency: cur.length === 3 ? cur : "USD" }).format(n)
                    : "—";
                  const storageLabel = payload?.pim_price_storage_label ?? payload?.pim_price_table ?? "product_prices";
                  const originLabel = payload?.pim_price_origin_label ?? "—";
                  const latestMeta =
                    latest?.metadata && typeof latest.metadata === "object" && !Array.isArray(latest.metadata)
                      ? (latest.metadata as Record<string, unknown>)
                      : {};
                  const priceSourceKind = typeof latestMeta.price_source === "string" ? latestMeta.price_source.trim() : "";
                  const priceTier =
                    typeof latestMeta.pricing_api_tier === "string" ? latestMeta.pricing_api_tier.trim() : "";
                  const lastProductPriceAt =
                    typeof p.last_price_updated_at === "string" && p.last_price_updated_at.trim()
                      ? p.last_price_updated_at.trim()
                      : null;
                  return (
                    <>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Stored in: <span className="font-medium text-foreground">{storageLabel}</span>
                        {" · "}
                        <span>Origin: {originLabel}</span>
                      </p>
                      {priceSourceKind ? (
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          Price source: <span className="font-mono text-foreground">{priceSourceKind}</span>
                          {priceTier ? (
                            <>
                              {" "}
                              · API tier: <span className="font-mono text-foreground">{priceTier}</span>
                            </>
                          ) : null}
                        </p>
                      ) : null}
                      {lastProductPriceAt ? (
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          Last price update: <span className="text-foreground">{lastProductPriceAt}</span>
                        </p>
                      ) : null}
                      <p className="text-[11px] text-muted-foreground">Price history below (newest first) comes from product_prices.</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Latest: <span className="font-medium text-foreground">{label}</span>
                        {latest?.observed_at ? (
                          <span className="text-xs"> ({String(latest.observed_at)})</span>
                        ) : null}
                      </p>
                      <div className="mt-2 max-h-40 overflow-auto rounded-lg border border-border/50">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-border bg-muted/40 text-left">
                              <th className="px-2 py-1">Amount</th>
                              <th className="px-2 py-1">Observed</th>
                              <th className="px-2 py-1">Source</th>
                            </tr>
                          </thead>
                          <tbody>
                            {prices.map((row) => (
                              <tr key={String(row.id)} className="border-b border-border/30">
                                <td className="px-2 py-1 font-mono">{String(row.amount ?? row.price ?? "—")}</td>
                                <td className="px-2 py-1">{String(row.observed_at ?? "")}</td>
                                <td className="max-w-[10rem] truncate px-2 py-1" title={derivePimPriceOriginLabel(row) ?? ""}>
                                  {derivePimPriceOriginLabel(row) ?? String(row.source ?? "—")}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  );
                })()}
              </section>

              <section className="rounded-xl border border-border/60 bg-card/50">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-semibold text-foreground hover:bg-muted/40"
                  onClick={() => setOpenAmazon((o) => !o)}
                >
                  <span>Amazon &amp; listing data</span>
                  {openAmazon ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                </button>
                {openAmazon ? (
                  <div className="border-t border-border/50 px-4 pb-4 pt-1">
                <div className="flex flex-wrap items-center gap-2">
                  <PimHelpNote label="Listing rows and status">
                    <div>
                      Rows come from imported listing/catalog snapshots or from Amazon catalog enrichment saved on this product. Status values
                      reflect that stored data, not live Seller Central.
                    </div>
                  </PimHelpNote>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">Source column shows how each row was produced.</p>
                <div className="mt-2 max-h-56 overflow-auto text-xs">
                  {(payload?.catalog_products ?? []).length === 0 ? (
                    <p className="text-muted-foreground">No matching listing rows.</p>
                  ) : (
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className="border-b border-border bg-muted/40 text-left">
                          <th className="min-w-[9rem] px-2 py-1">Source</th>
                          <th className="px-2 py-1">SKU</th>
                          <th className="px-2 py-1">ASIN</th>
                          <th className="px-2 py-1">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(payload?.catalog_products ?? []).map((cp) => (
                          <tr key={String(cp.id)} className="border-b border-border/30">
                            <td className="px-2 py-1">
                              <span className="inline-flex rounded-md border border-border/60 bg-muted/30 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                {listingRowSourceLabel(cp)}
                              </span>
                            </td>
                            <td className="px-2 py-1 font-mono">{String(cp.seller_sku ?? "")}</td>
                            <td className="px-2 py-1 font-mono">{String(cp.asin ?? "")}</td>
                            <td className="px-2 py-1">{listingStatusCell(cp)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                  </div>
                ) : null}
              </section>

              <section className="rounded-xl border border-border/60 bg-card/50 p-4">
                <h3 className="text-sm font-semibold text-foreground">Linked identifiers</h3>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Identity map rows for this product (import pipelines may add multiple matches over time).
                </p>
                {(payload?.product_identifier_map ?? []).length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {String(p.sku ?? "").trim() ||
                    String(p.asin ?? "").trim() ||
                    String(p.fnsku ?? "").trim() ||
                    String(p.upc_code ?? "").trim()
                      ? "No extra catalog map rows yet — the identifiers in the section above are stored on this product. Imports can add additional linked rows here over time."
                      : "No identifier map rows yet — confirm SKU, ASIN, or other IDs are saved on the product or imported from your catalog feeds."}
                  </p>
                ) : (
                  <ul className="mt-3 max-h-52 space-y-2 overflow-y-auto text-xs">
                    {(payload?.product_identifier_map ?? []).map((m) => (
                      <li key={String(m.id)} className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2">
                        <div className="mb-1 text-[10px] text-muted-foreground">
                          {String(m.match_source ?? "import")}
                          {m.source_report_type ? ` · ${String(m.source_report_type)}` : ""}
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-foreground">
                          {String(m.seller_sku ?? "").trim() ? <span>SKU {String(m.seller_sku)}</span> : null}
                          {String(m.asin ?? "").trim() ? <span>ASIN {String(m.asin)}</span> : null}
                          {String(m.fnsku ?? "").trim() ? <span>FNSKU {String(m.fnsku)}</span> : null}
                          {String(m.upc_code ?? "").trim() ? <span>UPC {String(m.upc_code)}</span> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="space-y-2 rounded-xl border border-dashed border-border/60 bg-muted/10 p-2">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-2 py-2 text-left text-sm font-semibold text-foreground hover:bg-muted/30 rounded-lg"
                  onClick={() => setOpenAdvanced((o) => !o)}
                >
                  <span>Advanced technical details</span>
                  {openAdvanced ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                </button>
                {openAdvanced ? (
                  <div className="space-y-2 px-2 pb-3">
                <p className="text-xs text-muted-foreground">
                  For troubleshooting. Normal catalog work does not require this section.
                </p>
                <JsonBlock
                  title="Internal context (metadata)"
                  description="Internal import and product context used by the system (sessions, uploads, enrichment notes)."
                  value={p.metadata}
                />
                <JsonBlock
                  title="Amazon catalog response (saved payload)"
                  description="Raw Amazon catalog response saved during enrichment. May include images, titles, brand, dimensions, and other catalog fields."
                  value={p.amazon_raw}
                />
                {(() => {
                  const prov = getPimFieldProvenanceObject(p);
                  if (!prov || !Object.keys(prov).length) {
                    return (
                      <div className="rounded-lg border border-border/60 px-3 py-2">
                        <p className="text-sm font-medium text-foreground">Field provenance</p>
                        <p className="mt-1 text-xs text-muted-foreground">No provenance data yet.</p>
                      </div>
                    );
                  }
                  return (
                    <JsonBlock
                      title="Field provenance"
                      description="Per-field source metadata (column or metadata.pim_field_provenance when the dedicated column is not used)."
                      value={prov}
                    />
                  );
                })()}
                  </div>
                ) : null}
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      {drawer}
      {lightbox ? (
        <ImageLightbox
          urls={lightbox.urls}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndexChange={(i) => setLightbox((s) => (s ? { ...s, index: i } : s))}
        />
      ) : null}
    </>,
    document.body,
  );
}
