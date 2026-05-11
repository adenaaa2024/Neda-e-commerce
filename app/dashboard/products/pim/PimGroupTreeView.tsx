"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { collectPimAmazonRawGalleryUrls, resolvePimDisplayImageUrl } from "../../../../lib/pim-display-image";
import { IdentifierValue } from "./IdentifierValue";
import { dedupeImageUrls, ImageLightbox } from "./ImageLightbox";
import type { CatalogGroupDimension, CatalogGroupRow } from "./pim-catalog-group-types";
import {
  displayAsin,
  displayFnsku,
  displaySku,
  displayUpc,
  formatPrice,
  type PimCatalogRow,
} from "./CatalogDataGrid";

export type { CatalogGroupDimension, CatalogGroupRow } from "./pim-catalog-group-types";

const MEMBER_PAGE_SIZE = 100;

async function fetchCatalogMembers(params: {
  organizationId: string;
  storeId: string;
  dimension: CatalogGroupDimension;
  row: CatalogGroupRow;
}): Promise<PimCatalogRow[]> {
  const { organizationId, storeId, dimension, row } = params;
  const u = new URL("/api/dashboard/products/catalog", window.location.origin);
  u.searchParams.set("organization_id", organizationId);
  u.searchParams.set("store_id", storeId);
  u.searchParams.set("page", "1");
  u.searchParams.set("page_size", String(MEMBER_PAGE_SIZE));
  u.searchParams.set("sort", "updated_at");
  u.searchParams.set("dir", "desc");

  if (dimension === "vendor") {
    if (row.key === "__no_vendor__") u.searchParams.set("filter_vendor", "missing");
    else if (row.filter_vendor_id) u.searchParams.set("vendor_id", row.filter_vendor_id);
    else if (row.filter_vendor_name?.trim()) u.searchParams.set("q", row.filter_vendor_name.trim());
  } else if (dimension === "category") {
    if (row.key === "__no_category__") u.searchParams.set("filter_category", "missing");
    else if (row.filter_category_id) u.searchParams.set("category_id", row.filter_category_id);
  } else if (dimension === "brand") {
    if (row.key === "__no_brand__") u.searchParams.set("filter_brand_field", "missing");
    else if (row.filter_brand) u.searchParams.set("brand", row.filter_brand);
  } else {
    const q = (row.filter_search ?? row.label).trim();
    if (q) u.searchParams.set("q", q);
  }

  const res = await fetch(u.toString());
  const data = (await res.json()) as { ok?: boolean; rows?: PimCatalogRow[] };
  if (!res.ok || !data.ok) return [];
  return data.rows ?? [];
}

export function PimGroupTreeView({
  organizationId,
  storeId,
  dimension,
  onApplyToGrid,
  onOpenProduct,
  onEditProduct,
  displayCurrency = "USD",
}: {
  organizationId: string;
  storeId: string;
  dimension: CatalogGroupDimension;
  onApplyToGrid: (dim: CatalogGroupDimension, row: CatalogGroupRow) => void;
  onOpenProduct: (id: string) => void;
  onEditProduct: (id: string) => void;
  displayCurrency?: string;
}) {
  const [groups, setGroups] = useState<CatalogGroupRow[]>([]);
  const [rollupLoading, setRollupLoading] = useState(false);
  const [rollupErr, setRollupErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [members, setMembers] = useState<Map<string, PimCatalogRow[]>>(new Map());
  const membersLoaded = useRef(new Set<string>());
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [treeSearch, setTreeSearch] = useState("");
  const [lightbox, setLightbox] = useState<{ urls: string[]; index: number } | null>(null);

  const loadRollup = useCallback(async () => {
    if (!organizationId || !storeId) return;
    setRollupLoading(true);
    setRollupErr(null);
    try {
      const u = new URL("/api/dashboard/products/catalog/group-rollup", window.location.origin);
      u.searchParams.set("organization_id", organizationId);
      u.searchParams.set("store_id", storeId);
      u.searchParams.set("dimension", dimension);
      const res = await fetch(u.toString());
      const data = (await res.json()) as { ok?: boolean; groups?: CatalogGroupRow[]; error?: string };
      if (!res.ok || !data.ok) {
        setGroups([]);
        setRollupErr(data.error ?? "Failed to load groups.");
        return;
      }
      setGroups(data.groups ?? []);
    } catch {
      setGroups([]);
      setRollupErr("Network error.");
    } finally {
      setRollupLoading(false);
    }
  }, [organizationId, storeId, dimension]);

  useEffect(() => {
    void loadRollup();
  }, [loadRollup]);

  useEffect(() => {
    const onRefresh = () => void loadRollup();
    window.addEventListener("pim-catalog-refresh", onRefresh);
    return () => window.removeEventListener("pim-catalog-refresh", onRefresh);
  }, [loadRollup]);

  useEffect(() => {
    setOpen(new Set());
    setMembers(new Map());
    membersLoaded.current = new Set();
    setLoadingKey(null);
  }, [dimension, organizationId, storeId]);

  const q = treeSearch.trim().toLowerCase();
  const filteredGroups = useMemo(() => {
    if (!q) return groups;
    return groups.filter((g) => g.label.toLowerCase().includes(q) || g.key.toLowerCase().includes(q));
  }, [groups, q]);

  const ensureMembers = useCallback(
    async (row: CatalogGroupRow) => {
      const key = row.key;
      if (membersLoaded.current.has(key)) return;
      setLoadingKey(key);
      try {
        const rows = await fetchCatalogMembers({ organizationId, storeId, dimension, row });
        membersLoaded.current.add(key);
        setMembers((m) => new Map(m).set(key, rows));
      } finally {
        setLoadingKey(null);
      }
    },
    [dimension, organizationId, storeId],
  );

  const toggle = useCallback(
    (row: CatalogGroupRow) => {
      if (row.allow_members === false) return;
      setOpen((prev) => {
        const n = new Set(prev);
        const willOpen = !n.has(row.key);
        if (willOpen) {
          n.add(row.key);
          void ensureMembers(row);
        } else n.delete(row.key);
        return n;
      });
    },
    [ensureMembers],
  );

  const openPreview = useCallback((row: PimCatalogRow, startUrl: string) => {
    const primary = resolvePimDisplayImageUrl(row.main_image_url, row.amazon_raw);
    const gallery = collectPimAmazonRawGalleryUrls(row.amazon_raw, 16);
    const urls = dedupeImageUrls([primary, ...gallery].filter(Boolean) as string[]);
    if (!urls.length) return;
    const idx = Math.max(0, urls.indexOf(startUrl));
    setLightbox({ urls, index: idx >= 0 ? idx : 0 });
  }, []);

  if (rollupLoading && groups.length === 0) {
    return (
      <div className="flex justify-center py-16 text-muted-foreground">
        <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
      </div>
    );
  }

  if (rollupErr) {
    return <p className="text-sm text-destructive">{rollupErr}</p>;
  }

  return (
    <div className="w-full max-w-none space-y-3">
      {lightbox ? (
        <ImageLightbox
          urls={lightbox.urls}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndexChange={(i) => setLightbox((s) => (s ? { ...s, index: i } : s))}
        />
      ) : null}

      <label className="block max-w-md text-sm">
        <span className="text-muted-foreground">Search groups</span>
        <input
          value={treeSearch}
          onChange={(e) => setTreeSearch(e.target.value)}
          placeholder="Group label…"
          className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm"
        />
      </label>

      <div className="overflow-x-auto rounded-xl border border-border/60">
        <table className="w-full min-w-[960px] border-collapse text-left text-sm">
          <thead className="sticky top-0 z-10 border-b border-border bg-muted/95 backdrop-blur">
            <tr className="text-xs font-medium text-muted-foreground">
              <th className="w-8 px-2 py-2.5" />
              <th className="px-3 py-2.5">Group</th>
              <th className="px-3 py-2.5 tabular-nums">Products</th>
              <th className="px-3 py-2.5 tabular-nums">Missing image</th>
              <th className="px-3 py-2.5 tabular-nums">Missing SKU</th>
              <th className="px-3 py-2.5 tabular-nums">Missing ASIN</th>
              <th className="px-3 py-2.5 tabular-nums">Missing FNSKU</th>
              <th className="px-3 py-2.5 tabular-nums">Missing UPC</th>
              <th className="px-3 py-2.5 tabular-nums">Active</th>
              <th className="px-3 py-2.5"> </th>
            </tr>
          </thead>
          <tbody>
            {filteredGroups.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-10 text-center text-muted-foreground">
                  No grouped rows for this store.
                </td>
              </tr>
            ) : (
              filteredGroups.map((r) => {
                const expanded = open.has(r.key);
                const prows = members.get(r.key) ?? [];
                const busy = loadingKey === r.key;
                return (
                  <React.Fragment key={r.key}>
                    <tr className="border-b border-border/40 bg-muted/10 hover:bg-muted/25">
                      <td className="px-2 py-2 align-middle">
                        {r.allow_members === false ? (
                          <span className="inline-flex px-1 text-muted-foreground" title="Aggregate only — use Filter grid or the audit panel">
                            —
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                            onClick={() => toggle(r)}
                            aria-expanded={expanded}
                            aria-label={expanded ? "Collapse group" : "Expand group"}
                          >
                            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </button>
                        )}
                      </td>
                      <td className="max-w-[16rem] px-3 py-2 font-medium text-foreground">
                        {r.allow_members === false ? (
                          <span className="break-words">{r.label}</span>
                        ) : (
                          <button type="button" className="text-left hover:underline" onClick={() => toggle(r)}>
                            <span className="break-words">{r.label}</span>
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.product_count}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.missing_image}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.missing_sku}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.missing_asin}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.missing_fnsku}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.missing_upc}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.active_count}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => onApplyToGrid(dimension, r)}
                          className="rounded-lg border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted"
                        >
                          Filter grid
                        </button>
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="border-b border-border/40 bg-background/80">
                        <td colSpan={10} className="p-0">
                          {busy && prows.length === 0 ? (
                            <div className="flex justify-center py-8 text-muted-foreground">
                              <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
                            </div>
                          ) : prows.length === 0 ? (
                            <p className="px-4 py-6 text-sm text-muted-foreground">No products loaded for this group.</p>
                          ) : (
                            <div className="max-h-[min(28rem,55vh)] overflow-auto">
                              <table className="w-full min-w-[880px] border-collapse text-xs">
                                <thead className="sticky top-0 z-[5] border-b border-border bg-muted/90 text-muted-foreground">
                                  <tr>
                                    <th className="px-2 py-2 text-left font-medium">Image</th>
                                    <th className="px-2 py-2 text-left font-medium">Product</th>
                                    <th className="px-2 py-2 text-left font-medium">Vendor</th>
                                    <th className="px-2 py-2 text-left font-medium">Category</th>
                                    <th className="px-2 py-2 text-left font-medium">Brand</th>
                                    <th className="px-2 py-2 text-left font-medium">SKU</th>
                                    <th className="px-2 py-2 text-left font-medium">ASIN</th>
                                    <th className="px-2 py-2 text-left font-medium">FNSKU</th>
                                    <th className="px-2 py-2 text-left font-medium">UPC</th>
                                    <th className="px-2 py-2 text-left font-medium">Status</th>
                                    <th className="px-2 py-2 text-left font-medium">Price</th>
                                    <th className="px-2 py-2 text-left font-medium">Actions</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {prows.map((p) => {
                                    const pid = String(p.id ?? "");
                                    const img = resolvePimDisplayImageUrl(p.main_image_url, p.amazon_raw);
                                    const gallery = collectPimAmazonRawGalleryUrls(p.amazon_raw, 16);
                                    const thumbs = dedupeImageUrls([img, ...gallery].filter(Boolean) as string[]);
                                    const thumb = thumbs[0] ?? null;
                                    const name = String(p.product_name ?? "—");
                                    const vendor = String(p.vendor_name ?? "—");
                                    const cat = String(p.category_name ?? "—");
                                    const brand = String(p.brand ?? "—");
                                    const status = String(p.status ?? "—");
                                    return (
                                      <tr key={pid} className="border-b border-border/30 hover:bg-muted/15">
                                        <td className="px-2 py-1.5 align-top">
                                          {thumb ? (
                                            <button
                                              type="button"
                                              className="block h-9 w-9 overflow-hidden rounded border border-border"
                                              onClick={() => openPreview(p, thumb)}
                                              title="View image"
                                            >
                                              {/* eslint-disable-next-line @next/next/no-img-element */}
                                              <img src={thumb} alt="" className="h-full w-full object-cover" />
                                            </button>
                                          ) : (
                                            <div className="h-9 w-9 rounded border border-border bg-muted/60" />
                                          )}
                                        </td>
                                        <td className="max-w-[12rem] whitespace-normal break-words px-2 py-1.5 align-top font-medium text-foreground">
                                          {name}
                                        </td>
                                        <td className="max-w-[8rem] whitespace-normal break-words px-2 py-1.5 align-top text-muted-foreground">
                                          {vendor}
                                        </td>
                                        <td className="max-w-[8rem] whitespace-normal break-words px-2 py-1.5 align-top text-muted-foreground">
                                          {cat}
                                        </td>
                                        <td className="max-w-[6rem] whitespace-normal break-words px-2 py-1.5 align-top text-muted-foreground">
                                          {brand}
                                        </td>
                                        <td className="min-w-[7rem] max-w-[9rem] whitespace-nowrap px-2 py-1.5 align-top">
                                          <IdentifierValue value={displaySku(p) || null} kind="sku" />
                                        </td>
                                        <td className="min-w-[7rem] max-w-[9rem] whitespace-nowrap px-2 py-1.5 align-top">
                                          <IdentifierValue value={displayAsin(p) || null} kind="asin" />
                                        </td>
                                        <td className="min-w-[7rem] max-w-[9rem] whitespace-nowrap px-2 py-1.5 align-top">
                                          <IdentifierValue value={displayFnsku(p) || null} kind="fnsku" />
                                        </td>
                                        <td className="min-w-[6rem] max-w-[8rem] whitespace-nowrap px-2 py-1.5 align-top">
                                          <IdentifierValue value={displayUpc(p) || null} kind="upc" />
                                        </td>
                                        <td className="whitespace-nowrap px-2 py-1.5 align-top text-muted-foreground">{status}</td>
                                        <td className="whitespace-nowrap px-2 py-1.5 align-top text-muted-foreground">{formatPrice(p, displayCurrency)}</td>
                                        <td className="whitespace-nowrap px-2 py-1.5 align-top">
                                          <div className="flex flex-wrap gap-1">
                                            <button
                                              type="button"
                                              className="rounded border border-border bg-background px-2 py-0.5 text-[11px] font-medium hover:bg-muted"
                                              onClick={() => onOpenProduct(pid)}
                                            >
                                              Details
                                            </button>
                                            <button
                                              type="button"
                                              className="rounded border border-border bg-background px-2 py-0.5 text-[11px] font-medium hover:bg-muted"
                                              onClick={() => onEditProduct(pid)}
                                            >
                                              Edit
                                            </button>
                                          </div>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                              {r.product_count > MEMBER_PAGE_SIZE ? (
                                <p className="border-t border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
                                  Showing first {MEMBER_PAGE_SIZE} products. Use Filter grid to narrow in the main grid.
                                </p>
                              ) : null}
                            </div>
                          )}
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
