"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  BadgeInfo,
  Banknote,
  ChevronDown,
  Fingerprint,
  FolderTree,
  LayoutGrid,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Store,
  Tag,
} from "lucide-react";
import { isPimInvalidVendorCategoryLabel } from "../../../../lib/pim-invalid-label";
import { PIM_PRODUCT_STATUSES } from "../../../../lib/pim-product-status";
import {
  getPimIntegrationsSummary,
  getPimManualProductFormDefaults,
  type PimStoreOption,
} from "../pim-actions";
import { CatalogDataGrid, type PimCatalogRow } from "./CatalogDataGrid";
import { ImageLightbox } from "./ImageLightbox";
import { PimGroupTreeView } from "./PimGroupTreeView";
import { PimIdentifierGroupsView } from "./PimIdentifierGroupsView";
import type { CatalogGroupDimension, CatalogGroupRow } from "./pim-catalog-group-types";
import type { VendorAggRow } from "./VendorTreeView";
import { ProductDetailDrawer } from "./ProductDetailDrawer";
import { ManualProductForm } from "./ManualProductForm";
import { PimHelpNote } from "./PimHelpNote";
import { isAdminRole, useUserRole } from "../../../../components/UserRoleContext";

type ViewMode = "grid" | "vendor" | "category" | "brand" | "identifiers";

type Facets = {
  brands: string[];
  statuses: string[];
  match_sources: string[];
  source_report_types: string[];
};

type TriFilter = "any" | "has" | "missing";

/** ISO 4217 codes for catalog price display (org default in Settings → General). */
const PIM_DISPLAY_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "JPY",
  "CHF",
  "SEK",
  "NOK",
  "MXN",
  "INR",
  "CNY",
  "BRL",
  "ZAR",
  "AED",
  "SGD",
  "HKD",
  "NZD",
] as const;

type EnrichCatalogMetrics = {
  scanned: number;
  rows_saved?: number;
  with_asin: number;
  with_fnsku?: number;
  with_sku?: number;
  with_name?: number;
  enriched?: number;
  enriched_images?: number;
  enriched_brand?: number;
  enriched_title?: number;
  enriched_category?: number;
  enriched_prices?: number;
  /** Rows where merged Amazon catalog JSON / gallery changed on disk */
  catalog_snapshots_saved?: number;
  /** Rows updated but no new scalar fields (title/brand/category/image/price) */
  catalog_only_refresh?: number;
  no_match?: number;
  skipped_no_asin: number;
  skipped_no_image_found: number;
  failed: number;
  categories_updated?: number;
  category_candidates_found?: number;
  category_skipped_low_confidence?: number;
  price_candidates_found?: number;
  prices_inserted?: number;
  pricing_api_not_available?: number;
  pricing_permission_missing?: number;
  price_skipped_no_match?: number;
  products_with_existing_price?: number;
  category_retry_attempted?: number;
  category_retry_success?: number;
  image_retry_attempted?: number;
  image_retry_success?: number;
  still_missing_category?: number;
  still_missing_image?: number;
  throttled_count?: number;
  retry_count?: number;
  deferred_count?: number;
  pricing_invalid_marketplace_count?: number;
  pricing_asin_not_found_count?: number;
  pricing_no_offer_data_count?: number;
  pricing_endpoint_not_configured_count?: number;
  pricing_throttled_count?: number;
  price_insert_skipped_duplicate?: number;
  price_insert_db_errors?: number;
  catalog_not_found_count?: number;
  price_from_alternate_asin?: number;
  price_from_saved_amazon_raw?: number;
  price_from_catalog_products_listing?: number;
  price_from_catalog_products_fallback_offer?: number;
  api_price_ai_disambiguations?: number;
  retry_missing_prices_only?: boolean;
  start_index?: number;
  batch_size?: number;
  prioritize_incomplete?: boolean;
  force_fresh_price_rows?: boolean;
};

type EnrichFailure = { product_id: string; reason: string };

type EnrichmentDebugRow = {
  product_id: string;
  asin: string;
  marketplace_id: string | null;
  pricing_endpoint: string;
  pricing_http: number | null;
  pricing_outcome: string;
  catalog_http: number | null;
  catalog_detail: string;
  list_price_candidate: string;
  offers_price_candidate: string;
  price_insert: string;
  category_status: string;
  image_status: string;
};

function TriSelect({
  label,
  value,
  onChange,
  help,
}: {
  label: string;
  value: TriFilter;
  onChange: (v: TriFilter) => void;
  help?: string;
}) {
  return (
    <div className="text-xs font-medium text-muted-foreground">
      <div className="mb-1 inline-flex items-center gap-1">
        <span>{label}</span>
        {help ? (
          <button
            type="button"
            className="inline-flex cursor-pointer select-none rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title={help}
            aria-label={help}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <BadgeInfo className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
          </button>
        ) : null}
      </div>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as TriFilter)}
        className="h-9 w-full rounded-lg border border-border bg-background text-sm"
      >
        <option value="any">Any</option>
        <option value="has">Has value</option>
        <option value="missing">Missing</option>
      </select>
    </div>
  );
}

export function PimCatalogHub({ organizationId }: { organizationId: string | null }) {
  const { role } = useUserRole();
  const enrichAdminDebug = isAdminRole(role);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [stores, setStores] = useState<PimStoreOption[]>([]);
  const [storeLoading, setStoreLoading] = useState(false);
  const [storeId, setStoreId] = useState("");
  const [view, setView] = useState<ViewMode>("grid");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState("updated_at");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [matchSourceFilter, setMatchSourceFilter] = useState("");
  const [reportTypeFilter, setReportTypeFilter] = useState("");
  const [filterImage, setFilterImage] = useState<TriFilter>("any");
  const [filterSku, setFilterSku] = useState<TriFilter>("any");
  const [filterAsin, setFilterAsin] = useState<TriFilter>("any");
  const [filterFnsku, setFilterFnsku] = useState<TriFilter>("any");
  const [filterUpc, setFilterUpc] = useState<TriFilter>("any");
  const [filterVendor, setFilterVendor] = useState<TriFilter>("any");
  const [filterCategory, setFilterCategory] = useState<TriFilter>("any");
  const [filterBrandField, setFilterBrandField] = useState<TriFilter>("any");
  const [rows, setRows] = useState<PimCatalogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [gridLoading, setGridLoading] = useState(false);
  const [gridErr, setGridErr] = useState<string | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [vendorsAgg, setVendorsAgg] = useState<VendorAggRow[]>([]);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [amazonSpConfigured, setAmazonSpConfigured] = useState(false);
  const [displayCurrency, setDisplayCurrency] = useState("USD");
  const [enrichBusy, setEnrichBusy] = useState(false);
  const [enrichMetrics, setEnrichMetrics] = useState<EnrichCatalogMetrics | null>(null);
  const [imagePreview, setImagePreview] = useState<{ urls: string[]; index: number } | null>(null);
  const [enrichErr, setEnrichErr] = useState<string | null>(null);
  const [enrichFailures, setEnrichFailures] = useState<EnrichFailure[]>([]);
  const [enrichDetailOpen, setEnrichDetailOpen] = useState(false);
  const [enrichDebugOpen, setEnrichDebugOpen] = useState(false);
  const [enrichDebugRows, setEnrichDebugRows] = useState<EnrichmentDebugRow[]>([]);
  const [enrichRetryIds, setEnrichRetryIds] = useState<string[]>([]);
  const [enrichLastRunAt, setEnrichLastRunAt] = useState<string | null>(null);

  const oid = organizationId?.trim() ?? "";

  const filtersActive = useMemo(() => {
    return (
      qDebounced.trim().length > 0 ||
      (vendorFilter.trim().length > 0 && /^[0-9a-f-]{36}$/i.test(vendorFilter)) ||
      (categoryFilter.trim().length > 0 && /^[0-9a-f-]{36}$/i.test(categoryFilter)) ||
      brandFilter.trim().length > 0 ||
      statusFilter.trim().length > 0 ||
      matchSourceFilter.trim().length > 0 ||
      reportTypeFilter.trim().length > 0 ||
      filterImage !== "any" ||
      filterSku !== "any" ||
      filterAsin !== "any" ||
      filterFnsku !== "any" ||
      filterUpc !== "any" ||
      filterVendor !== "any" ||
      filterCategory !== "any" ||
      filterBrandField !== "any"
    );
  }, [
    qDebounced,
    vendorFilter,
    categoryFilter,
    brandFilter,
    statusFilter,
    matchSourceFilter,
    reportTypeFilter,
    filterImage,
    filterSku,
    filterAsin,
    filterFnsku,
    filterUpc,
    filterVendor,
    filterCategory,
    filterBrandField,
  ]);

  const clearAllFilters = useCallback(() => {
    setQ("");
    setQDebounced("");
    setVendorFilter("");
    setCategoryFilter("");
    setBrandFilter("");
    setStatusFilter("");
    setMatchSourceFilter("");
    setReportTypeFilter("");
    setFilterImage("any");
    setFilterSku("any");
    setFilterAsin("any");
    setFilterFnsku("any");
    setFilterUpc("any");
    setFilterVendor("any");
    setFilterCategory("any");
    setFilterBrandField("any");
    setPage(1);
  }, []);

  const applyGroupToGrid = useCallback(
    (dim: CatalogGroupDimension, row: CatalogGroupRow) => {
      setView("grid");
      setPage(1);
      clearAllFilters();

      if (dim === "vendor") {
        if (row.key === "__no_vendor__") {
          setFilterVendor("missing");
        } else if (row.key === "__pim_needs_cleanup_vendor__") {
          setAuditOpen(true);
        } else if (row.filter_vendor_id) {
          setVendorFilter(row.filter_vendor_id);
        } else if (row.filter_vendor_name?.trim()) {
          setVendorFilter("");
          const nm = row.filter_vendor_name.trim();
          setQ(nm);
          setQDebounced(nm);
        }
        return;
      }
      if (dim === "category") {
        if (row.key === "__no_category__") {
          setFilterCategory("missing");
        } else if (row.filter_category_id) {
          setCategoryFilter(row.filter_category_id);
        }
        return;
      }
      if (dim === "brand") {
        if (row.key === "__no_brand__") {
          setFilterBrandField("missing");
        } else if (row.filter_brand) {
          setBrandFilter(row.filter_brand);
        }
        return;
      }
      const s = row.filter_search?.trim() ?? "";
      if (s) {
        setQ(s);
        setQDebounced(s);
      }
    },
    [clearAllFilters, setAuditOpen],
  );

  const bucketDimension = useMemo((): CatalogGroupDimension | null => {
    if (view === "vendor") return "vendor";
    if (view === "category") return "category";
    if (view === "brand") return "brand";
    return null;
  }, [view]);

  useEffect(() => {
    if (!oid) {
      setAmazonSpConfigured(false);
      setDisplayCurrency("USD");
      return;
    }
    let cancelled = false;
    void getPimIntegrationsSummary(oid).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setAmazonSpConfigured(r.data.connectionStatus.amazonSpApi);
        setDisplayCurrency(r.data.displayCurrencyCode ?? "USD");
      } else {
        setAmazonSpConfigured(false);
        setDisplayCurrency("USD");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [oid]);

  useEffect(() => {
    const t = window.setTimeout(() => setQDebounced(q.trim()), 350);
    return () => window.clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!oid) {
      setStores([]);
      setStoreId("");
      return;
    }
    setStoreLoading(true);
    void getPimManualProductFormDefaults(oid)
      .then((r) => {
        if (!r.ok) {
          setStores([]);
          return;
        }
        setStores(r.stores);
        const fromUrl = searchParams.get("store");
        const preferred =
          fromUrl && r.stores.some((s) => s.id === fromUrl)
            ? fromUrl
            : r.defaultStoreId && r.stores.some((s) => s.id === r.defaultStoreId)
              ? r.defaultStoreId
              : r.stores[0]?.id ?? "";
        setStoreId((prev) => (prev && r.stores.some((s) => s.id === prev) ? prev : preferred));
      })
      .finally(() => setStoreLoading(false));
  }, [oid, searchParams]);

  const syncStoreUrl = useCallback(
    (sid: string) => {
      if (!pathname) return;
      const p = new URLSearchParams(searchParams.toString());
      if (sid) p.set("store", sid);
      else p.delete("store");
      router.replace(`${pathname}?${p.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const loadFacets = useCallback(async () => {
    if (!oid || !storeId) return;
    const u = new URL("/api/dashboard/products/catalog/facets", window.location.origin);
    u.searchParams.set("organization_id", oid);
    u.searchParams.set("store_id", storeId);
    const res = await fetch(u.toString());
    const data = (await res.json()) as { ok?: boolean; facets?: Facets };
    if (data.ok && data.facets) setFacets(data.facets);
  }, [oid, storeId]);

  const refreshVendorsAgg = useCallback(async () => {
    if (!oid || !storeId) return;
    const u = new URL("/api/dashboard/vendors", window.location.origin);
    u.searchParams.set("organization_id", oid);
    u.searchParams.set("store_id", storeId);
    u.searchParams.set("include_counts", "1");
    const res = await fetch(u.toString());
    const data = (await res.json()) as { ok?: boolean; vendors?: VendorAggRow[] };
    if (data.ok && data.vendors) setVendorsAgg(data.vendors);
  }, [oid, storeId]);

  const loadGrid = useCallback(async () => {
    if (!oid || !storeId) return;
    setGridLoading(true);
    setGridErr(null);
    try {
      const u = new URL("/api/dashboard/products/catalog", window.location.origin);
      u.searchParams.set("organization_id", oid);
      u.searchParams.set("store_id", storeId);
      u.searchParams.set("page", String(page));
      u.searchParams.set("page_size", String(pageSize));
      u.searchParams.set("sort", sort);
      u.searchParams.set("dir", dir);
      if (qDebounced) u.searchParams.set("q", qDebounced);
      if (vendorFilter && /^[0-9a-f-]{36}$/i.test(vendorFilter)) u.searchParams.set("vendor_id", vendorFilter);
      if (categoryFilter && /^[0-9a-f-]{36}$/i.test(categoryFilter)) u.searchParams.set("category_id", categoryFilter);
      if (brandFilter.trim()) u.searchParams.set("brand", brandFilter.trim());
      if (statusFilter.trim()) u.searchParams.set("status", statusFilter.trim());
      if (matchSourceFilter.trim()) u.searchParams.set("match_source", matchSourceFilter.trim());
      if (reportTypeFilter.trim()) u.searchParams.set("source_report_type", reportTypeFilter.trim());
      if (filterImage !== "any") u.searchParams.set("filter_image", filterImage);
      if (filterSku !== "any") u.searchParams.set("filter_sku", filterSku);
      if (filterAsin !== "any") u.searchParams.set("filter_asin", filterAsin);
      if (filterFnsku !== "any") u.searchParams.set("filter_fnsku", filterFnsku);
      if (filterUpc !== "any") u.searchParams.set("filter_upc", filterUpc);
      if (filterVendor !== "any") u.searchParams.set("filter_vendor", filterVendor);
      if (filterCategory !== "any") u.searchParams.set("filter_category", filterCategory);
      if (filterBrandField !== "any") u.searchParams.set("filter_brand_field", filterBrandField);
      const res = await fetch(u.toString());
      const data = (await res.json()) as {
        ok?: boolean;
        rows?: PimCatalogRow[];
        total?: number;
        error?: string;
        details?: string;
      };
      if (!res.ok || !data.ok) {
        setRows([]);
        setTotal(0);
        const base = data.error ?? "Catalog failed.";
        const detail = data.details && data.details !== base ? data.details : "";
        setGridErr(detail ? `${base}\n\n${detail}` : base);
        return;
      }
      setRows((data.rows ?? []) as PimCatalogRow[]);
      setTotal(Number(data.total ?? 0));
    } catch {
      setGridErr("Network error.");
      setRows([]);
      setTotal(0);
    } finally {
      setGridLoading(false);
    }
  }, [
    oid,
    storeId,
    page,
    pageSize,
    sort,
    dir,
    qDebounced,
    vendorFilter,
    categoryFilter,
    brandFilter,
    statusFilter,
    matchSourceFilter,
    reportTypeFilter,
    filterImage,
    filterSku,
    filterAsin,
    filterFnsku,
    filterUpc,
    filterVendor,
    filterCategory,
    filterBrandField,
  ]);

  useEffect(() => {
    void loadFacets();
  }, [loadFacets]);

  useEffect(() => {
    void refreshVendorsAgg();
  }, [refreshVendorsAgg]);

  useEffect(() => {
    if (view === "grid") void loadGrid();
  }, [loadGrid, view]);

  const onSort = useCallback(
    (col: string) => {
      setPage(1);
      if (sort === col) setDir((d) => (d === "asc" ? "desc" : "asc"));
      else {
        setSort(col);
        setDir("asc");
      }
    },
    [sort],
  );

  const applyIdentifierSearch = useCallback((key: string) => {
    setView("grid");
    setQ(key);
    setPage(1);
  }, []);

  const runEnrichmentBatches = useCallback(
    async (base: Record<string, unknown>, loopUntilDone: boolean) => {
      if (!oid || !storeId) return false;
      let start = 0;
      let batch = 0;
      const allFailures: EnrichFailure[] = [];
      const allRetry = new Set<string>();
      let lastMetrics: EnrichCatalogMetrics | null = null;
      let allDebug: EnrichmentDebugRow[] = [];
      try {
        for (;;) {
          batch += 1;
          const res = await fetch("/api/dashboard/products/catalog/enrich-images", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...base, start_index: start }),
          });
          const data = (await res.json()) as {
            ok?: boolean;
            error?: string;
            metrics?: EnrichCatalogMetrics;
            failures?: EnrichFailure[];
            failed_product_ids?: string[];
            enrichment_debug?: EnrichmentDebugRow[];
            continuation?: { next_start_index: number; total_eligible: number };
          };
          if (!res.ok || !data.ok) {
            setEnrichMetrics(null);
            setEnrichRetryIds([]);
            setEnrichDebugRows([]);
            setEnrichErr(data.error ?? `Request failed (${res.status}).`);
            return false;
          }
          lastMetrics = data.metrics ?? null;
          setEnrichMetrics(lastMetrics);
          for (const f of data.failures ?? []) allFailures.push(f);
          for (const id of data.failed_product_ids ?? []) if (id) allRetry.add(id);
          if (enrichAdminDebug && Array.isArray(data.enrichment_debug)) {
            allDebug = allDebug.concat(data.enrichment_debug);
            if (allDebug.length > 500) allDebug = allDebug.slice(-500);
          }
          const cont = data.continuation;
          if (!cont || !loopUntilDone) break;
          setToast(
            `Catalog enrichment: batch ${batch} · next ${cont.next_start_index.toLocaleString()} / ${cont.total_eligible.toLocaleString()} (products with ASIN)…`,
          );
          start = cont.next_start_index;
          await new Promise((r) => window.setTimeout(r, 200));
        }
        setEnrichFailures(allFailures);
        setEnrichRetryIds([...allRetry]);
        setEnrichDebugRows(allDebug);
        setEnrichErr(null);
        setEnrichLastRunAt(new Date().toISOString());
        const scanned = lastMetrics?.scanned;
        setToast(
          loopUntilDone && batch > 1
            ? `Catalog enrichment finished · ${batch} batches · ${typeof scanned === "number" ? `${scanned.toLocaleString()} ASIN products in pool` : "done"}.`
            : `Catalog enrichment finished.`,
        );
        void loadGrid();
        void loadFacets();
        void refreshVendorsAgg();
        window.dispatchEvent(new Event("pim-catalog-refresh"));
        return true;
      } catch (e) {
        setEnrichMetrics(null);
        setEnrichFailures([]);
        setEnrichRetryIds([]);
        setEnrichErr(e instanceof Error ? e.message : "Enrichment failed.");
        return false;
      }
    },
    [oid, storeId, enrichAdminDebug, loadGrid, loadFacets, refreshVendorsAgg],
  );

  const vendorOptions = useMemo(
    () => vendorsAgg.filter((v) => !isPimInvalidVendorCategoryLabel(v.name)).map((v) => ({ id: v.id, name: v.name })),
    [vendorsAgg],
  );
  const invalidVendorAudit = useMemo(() => vendorsAgg.filter((v) => isPimInvalidVendorCategoryLabel(v.name)), [vendorsAgg]);
  const categoryListUrl = useMemo(() => {
    if (!oid) return "";
    return `/api/dashboard/product-categories?organization_id=${encodeURIComponent(oid)}${storeId ? `&store_id=${encodeURIComponent(storeId)}&include_counts=1` : ""}`;
  }, [oid, storeId]);

  const [categoryOptionsRaw, setCategoryOptionsRaw] = useState<{ id: string; name: string; product_count?: number }[]>([]);

  const categoryFilterOptions = useMemo(
    () => categoryOptionsRaw.filter((c) => Boolean(c.id) && Boolean(String(c.name ?? "").trim())),
    [categoryOptionsRaw],
  );
  const invalidCategoryAudit = useMemo(
    () => categoryOptionsRaw.filter((c) => isPimInvalidVendorCategoryLabel(c.name)),
    [categoryOptionsRaw],
  );

  const statusFilterOptions = useMemo(() => {
    const fromFacets = (facets?.statuses ?? []).map((s) => String(s).trim()).filter(Boolean);
    const set = new Set<string>([...PIM_PRODUCT_STATUSES]);
    for (const s of fromFacets) set.add(s);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [facets?.statuses]);

  useEffect(() => {
    if (!categoryListUrl) return;
    void fetch(categoryListUrl, { credentials: "same-origin" })
      .then(async (r) => {
        const d = (await r.json()) as { ok?: boolean; categories?: { id: string; name: string; product_count?: number }[]; error?: string };
        if (!r.ok || d.ok === false) {
          setCategoryOptionsRaw([]);
          return;
        }
        setCategoryOptionsRaw(Array.isArray(d.categories) ? d.categories : []);
      })
      .catch(() => setCategoryOptionsRaw([]));
  }, [categoryListUrl]);

  if (!oid) {
    return (
      <section className="rounded-2xl border border-border/60 bg-card/70 p-6 shadow-xl">
        <p className="text-sm text-muted-foreground">Select a workspace organization to use the catalog.</p>
      </section>
    );
  }

  return (
    <section className="w-full max-w-none rounded-2xl border border-border/60 bg-card/70 p-4 shadow-xl backdrop-blur-md dark:bg-card/50 sm:p-5">
      {toast ? (
        <div className="mb-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground" role="status">
          {toast}
        </div>
      ) : null}

      <div className="mb-3 space-y-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-foreground sm:text-lg">Catalog Hub</h2>
            <PimHelpNote label="Catalog Hub">
              <div className="space-y-2">
                <div>
                  Grid plus tree groupings for vendor, category, and brand. Use <strong>Identifiers</strong> for SKU/ASIN/FNSKU/UPC groups from the identity map. Optional Amazon enrichment runs as a batch job only — not while the table renders.
                  Invalid vendor or category labels appear in the audit banner when present.
                </div>
                <div>
                  <Link href="/dashboard/file-import" className="font-medium text-primary underline-offset-2 hover:underline">
                    Full staged file imports
                  </Link>{" "}
                  use the Imports pipeline.
                </div>
              </div>
            </PimHelpNote>
          </div>
          <p className="text-sm text-muted-foreground">Browse and manage store products.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex select-none items-center gap-1.5">
            <button
              type="button"
              disabled={!storeId || enrichBusy || !amazonSpConfigured}
              title={
                !amazonSpConfigured
                  ? "Connect Amazon SP-API for this workspace (Settings → Marketplaces & Stores, or organization amazon_sp_api key)."
                  : "Batch job: call Amazon Catalog (ASIN) to fill missing images, weak titles, missing brand, matching category, and optional list price when present. Never runs during table render."
              }
              onClick={() => {
                if (!oid || !storeId || enrichBusy) return;
                setEnrichBusy(true);
                setEnrichErr(null);
                setEnrichFailures([]);
                setEnrichDetailOpen(false);
                setEnrichDebugOpen(false);
                setEnrichDebugRows([]);
                void runEnrichmentBatches(
                  { organization_id: oid, store_id: storeId, include_enrichment_debug: enrichAdminDebug },
                  true,
                ).finally(() => setEnrichBusy(false));
              }}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {enrichBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Enrich catalog data
            </button>
            <PimHelpNote label="Catalog enrichment">
              <div className="space-y-2">
                <div>
                  Batch Amazon Catalog Items call for every product with an ASIN. The hub automatically continues in batches until the full list is
                  covered (not only the first few hundred). Fills images, titles, brand, category, and prices when APIs return them. Never runs during
                  table render.
                </div>
                <div>
                  If the AI module is enabled, mapping or validation may be assisted automatically. AI should not invent product data.
                </div>
              </div>
            </PimHelpNote>
          </div>
          {enrichRetryIds.length > 0 && !enrichBusy ? (
            <button
              type="button"
              disabled={!storeId || enrichBusy || !amazonSpConfigured}
              title="Re-run Amazon catalog fetch only for products that failed last time."
              onClick={() => {
                if (!oid || !storeId || enrichBusy) return;
                setEnrichBusy(true);
                setEnrichErr(null);
                void runEnrichmentBatches(
                  {
                    organization_id: oid,
                    store_id: storeId,
                    retry_failed_only: true,
                    product_ids: enrichRetryIds,
                    include_enrichment_debug: enrichAdminDebug,
                  },
                  false,
                ).finally(() => setEnrichBusy(false));
              }}
              className="h-10 rounded-lg border border-dashed border-border px-3 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              Retry failed only
            </button>
          ) : null}
          <button
            type="button"
            disabled={!storeId || enrichBusy || !amazonSpConfigured}
            title="Re-run pricing paths only for products that have an ASIN but no product_prices row yet. Uses extra ASINs from identifier map, saved catalog JSON, and listing snapshots when APIs return nothing."
            onClick={() => {
              if (!oid || !storeId || enrichBusy) return;
              setEnrichBusy(true);
              setEnrichErr(null);
              setEnrichFailures([]);
              setEnrichDetailOpen(false);
              setEnrichDebugOpen(false);
              setEnrichDebugRows([]);
              void runEnrichmentBatches(
                {
                  organization_id: oid,
                  store_id: storeId,
                  retry_missing_prices_only: true,
                  include_enrichment_debug: enrichAdminDebug,
                },
                true,
              ).finally(() => setEnrichBusy(false));
            }}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {enrichBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Retry missing prices only
          </button>
          <button
            type="button"
            onClick={() => {
              setEditId(null);
              setFormOpen(true);
            }}
            disabled={!storeId}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Add product
          </button>
          <button
            type="button"
            disabled={!storeId || gridLoading}
            onClick={() => {
              void loadGrid();
              void loadFacets();
              void refreshVendorsAgg();
              window.dispatchEvent(new Event("pim-catalog-refresh"));
            }}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium hover:bg-muted"
          >
            <RefreshCw className={`h-4 w-4 ${gridLoading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {(enrichMetrics || enrichErr || enrichFailures.length > 0) && (
        <div className="mb-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm">
          {enrichErr ? <p className="text-destructive">{enrichErr}</p> : null}
          {enrichMetrics && !enrichErr ? (
            <div className="space-y-1 text-muted-foreground">
              <p className="text-xs font-semibold text-foreground">Last enrichment result</p>
              {enrichLastRunAt ? (
                <p className="text-[11px] text-muted-foreground">
                  Finished:{" "}
                  <span className="font-mono text-foreground">
                    {new Date(enrichLastRunAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" })}
                  </span>
                </p>
              ) : null}
              <ul className="grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
                <li>scanned: {enrichMetrics.scanned}</li>
                {typeof enrichMetrics.rows_saved === "number" ? <li>rows saved: {enrichMetrics.rows_saved}</li> : null}
                <li>with ASIN: {enrichMetrics.with_asin}</li>
                {typeof enrichMetrics.with_fnsku === "number" ? <li>with FNSKU: {enrichMetrics.with_fnsku}</li> : null}
                {typeof enrichMetrics.with_sku === "number" ? <li>with SKU: {enrichMetrics.with_sku}</li> : null}
                {typeof enrichMetrics.with_name === "number" ? <li>with solid title: {enrichMetrics.with_name}</li> : null}
                {typeof enrichMetrics.enriched_images === "number" ? <li>images filled: {enrichMetrics.enriched_images}</li> : null}
                {typeof enrichMetrics.enriched_title === "number" ? <li>titles filled: {enrichMetrics.enriched_title}</li> : null}
                {typeof enrichMetrics.enriched_brand === "number" ? <li>brands filled: {enrichMetrics.enriched_brand}</li> : null}
                {typeof enrichMetrics.categories_updated === "number" ? (
                  <li>categories updated: {enrichMetrics.categories_updated}</li>
                ) : null}
                {typeof enrichMetrics.category_candidates_found === "number" ? (
                  <li>category candidates found: {enrichMetrics.category_candidates_found}</li>
                ) : null}
                {typeof enrichMetrics.category_skipped_low_confidence === "number" ? (
                  <li>category skipped (low confidence): {enrichMetrics.category_skipped_low_confidence}</li>
                ) : null}
                {typeof enrichMetrics.price_candidates_found === "number" ? (
                  <li>price candidates found: {enrichMetrics.price_candidates_found}</li>
                ) : null}
                {typeof enrichMetrics.prices_inserted === "number" ? <li>prices inserted: {enrichMetrics.prices_inserted}</li> : null}
                {typeof enrichMetrics.pricing_api_not_available === "number" ? (
                  <li>pricing API not available: {enrichMetrics.pricing_api_not_available}</li>
                ) : null}
                {typeof enrichMetrics.pricing_permission_missing === "number" ? (
                  <li>pricing permission missing: {enrichMetrics.pricing_permission_missing}</li>
                ) : null}
                {typeof enrichMetrics.price_skipped_no_match === "number" ? (
                  <li>price skipped (no match): {enrichMetrics.price_skipped_no_match}</li>
                ) : null}
                {typeof enrichMetrics.products_with_existing_price === "number" ? (
                  <li>products with existing price row: {enrichMetrics.products_with_existing_price}</li>
                ) : null}
                {typeof enrichMetrics.category_retry_attempted === "number" ? (
                  <li>category retry attempted: {enrichMetrics.category_retry_attempted}</li>
                ) : null}
                {typeof enrichMetrics.category_retry_success === "number" ? (
                  <li>category retry success: {enrichMetrics.category_retry_success}</li>
                ) : null}
                {typeof enrichMetrics.image_retry_attempted === "number" ? (
                  <li>image retry attempted: {enrichMetrics.image_retry_attempted}</li>
                ) : null}
                {typeof enrichMetrics.image_retry_success === "number" ? (
                  <li>image retry success: {enrichMetrics.image_retry_success}</li>
                ) : null}
                {typeof enrichMetrics.still_missing_category === "number" ? (
                  <li>still missing category: {enrichMetrics.still_missing_category}</li>
                ) : null}
                {typeof enrichMetrics.still_missing_image === "number" ? (
                  <li>still missing image: {enrichMetrics.still_missing_image}</li>
                ) : null}
                {typeof enrichMetrics.catalog_snapshots_saved === "number" ? (
                  <li>catalog snapshots saved: {enrichMetrics.catalog_snapshots_saved}</li>
                ) : null}
                {typeof enrichMetrics.catalog_only_refresh === "number" && enrichMetrics.catalog_only_refresh > 0 ? (
                  <li>catalog-only refresh (no new scalars): {enrichMetrics.catalog_only_refresh}</li>
                ) : null}
                {typeof enrichMetrics.no_match === "number" ? <li>no catalog payload: {enrichMetrics.no_match}</li> : null}
                <li>no ASIN (skipped): {enrichMetrics.skipped_no_asin}</li>
                <li>no image in response: {enrichMetrics.skipped_no_image_found}</li>
                <li>failed: {enrichMetrics.failed}</li>
                {typeof enrichMetrics.throttled_count === "number" ? (
                  <li>throttled (catalog/pricing): {enrichMetrics.throttled_count}</li>
                ) : null}
                {typeof enrichMetrics.retry_count === "number" ? (
                  <li>SP-API retry attempts (extra): {enrichMetrics.retry_count}</li>
                ) : null}
                {typeof enrichMetrics.deferred_count === "number" ? (
                  <li>deferred (catalog 429): {enrichMetrics.deferred_count}</li>
                ) : null}
                {typeof enrichMetrics.pricing_throttled_count === "number" ? (
                  <li>pricing throttled: {enrichMetrics.pricing_throttled_count}</li>
                ) : null}
                {typeof enrichMetrics.pricing_invalid_marketplace_count === "number" ? (
                  <li>pricing invalid marketplace: {enrichMetrics.pricing_invalid_marketplace_count}</li>
                ) : null}
                {typeof enrichMetrics.pricing_asin_not_found_count === "number" ? (
                  <li>pricing ASIN not found: {enrichMetrics.pricing_asin_not_found_count}</li>
                ) : null}
                {typeof enrichMetrics.pricing_no_offer_data_count === "number" ? (
                  <li>pricing no offer data: {enrichMetrics.pricing_no_offer_data_count}</li>
                ) : null}
                {typeof enrichMetrics.pricing_endpoint_not_configured_count === "number" ? (
                  <li>pricing endpoint / marketplace missing: {enrichMetrics.pricing_endpoint_not_configured_count}</li>
                ) : null}
                {typeof enrichMetrics.price_insert_skipped_duplicate === "number" ? (
                  <li>price insert skipped (recent duplicate): {enrichMetrics.price_insert_skipped_duplicate}</li>
                ) : null}
                {typeof enrichMetrics.price_insert_db_errors === "number" ? (
                  <li>price insert DB errors: {enrichMetrics.price_insert_db_errors}</li>
                ) : null}
                {typeof enrichMetrics.catalog_not_found_count === "number" ? (
                  <li>catalog NOT_FOUND (404): {enrichMetrics.catalog_not_found_count}</li>
                ) : null}
                {typeof enrichMetrics.price_from_alternate_asin === "number" && enrichMetrics.price_from_alternate_asin > 0 ? (
                  <li>prices from alternate ASIN (identifier map): {enrichMetrics.price_from_alternate_asin}</li>
                ) : null}
                {typeof enrichMetrics.price_from_saved_amazon_raw === "number" && enrichMetrics.price_from_saved_amazon_raw > 0 ? (
                  <li>prices from saved amazon_raw catalog fields: {enrichMetrics.price_from_saved_amazon_raw}</li>
                ) : null}
                {typeof enrichMetrics.price_from_catalog_products_listing === "number" &&
                enrichMetrics.price_from_catalog_products_listing > 0 ? (
                  <li>prices from catalog_products listing column: {enrichMetrics.price_from_catalog_products_listing}</li>
                ) : null}
                {typeof enrichMetrics.price_from_catalog_products_fallback_offer === "number" &&
                enrichMetrics.price_from_catalog_products_fallback_offer > 0 ? (
                  <li>prices from catalog_products offer-like fields (raw_payload): {enrichMetrics.price_from_catalog_products_fallback_offer}</li>
                ) : null}
                {typeof enrichMetrics.api_price_ai_disambiguations === "number" && enrichMetrics.api_price_ai_disambiguations > 0 ? (
                  <li>API price picks via AI (offers vs list): {enrichMetrics.api_price_ai_disambiguations}</li>
                ) : null}
                {enrichMetrics.retry_missing_prices_only ? <li>run mode: missing prices only</li> : null}
              </ul>
              {enrichAdminDebug && enrichDebugRows.length > 0 ? (
                <div className="mt-2 border-t border-border/50 pt-2">
                  <button
                    type="button"
                    className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                    onClick={() => setEnrichDebugOpen((o) => !o)}
                  >
                    {enrichDebugOpen ? "Hide admin enrichment debug" : "Show admin enrichment debug"}
                  </button>
                  {enrichDebugOpen ? (
                    <div className="mt-2 max-h-64 overflow-auto rounded-md border border-border/50 bg-background/80">
                      <table className="w-full min-w-[48rem] border-collapse text-[10px]">
                        <thead>
                          <tr className="border-b border-border bg-muted/40 text-left">
                            <th className="px-1 py-0.5">product</th>
                            <th className="px-1 py-0.5">asin</th>
                            <th className="px-1 py-0.5">mp</th>
                            <th className="px-1 py-0.5">cat HTTP</th>
                            <th className="px-1 py-0.5">price HTTP</th>
                            <th className="px-1 py-0.5">price outcome</th>
                            <th className="px-1 py-0.5">list $</th>
                            <th className="px-1 py-0.5">offers $</th>
                            <th className="px-1 py-0.5">insert</th>
                            <th className="px-1 py-0.5">cat/img</th>
                          </tr>
                        </thead>
                        <tbody>
                          {enrichDebugRows.map((d) => (
                            <tr key={d.product_id} className="border-b border-border/30 align-top">
                              <td className="px-1 py-0.5 font-mono text-[9px]">{d.product_id.slice(0, 8)}…</td>
                              <td className="px-1 py-0.5 font-mono">{d.asin}</td>
                              <td className="px-1 py-0.5 font-mono text-[9px]">{d.marketplace_id ?? "—"}</td>
                              <td className="px-1 py-0.5">{d.catalog_http ?? "—"}</td>
                              <td className="px-1 py-0.5">{d.pricing_http ?? "—"}</td>
                              <td className="px-1 py-0.5">{d.pricing_outcome}</td>
                              <td className="px-1 py-0.5">{d.list_price_candidate}</td>
                              <td className="px-1 py-0.5">{d.offers_price_candidate}</td>
                              <td className="px-1 py-0.5">{d.price_insert}</td>
                              <td className="px-1 py-0.5">
                                {d.category_status} / {d.image_status}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {enrichFailures.length > 0 ? (
                <div className="mt-2 border-t border-border/50 pt-2">
                  <button
                    type="button"
                    className="text-xs font-medium text-primary underline-offset-2 hover:underline"
                    onClick={() => setEnrichDetailOpen((o) => !o)}
                  >
                    {enrichDetailOpen ? "Hide details" : "View details"}
                  </button>
                  {enrichDetailOpen ? (
                    <ul className="mt-2 max-h-48 list-none space-y-1 overflow-y-auto text-[11px] text-muted-foreground">
                      {enrichFailures.slice(0, 80).map((f) => (
                        <li key={f.product_id} className="break-words border-b border-border/30 py-1">
                          <span className="font-mono text-foreground">{f.product_id}</span>: {f.reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <div className="mb-4 flex min-w-0 flex-wrap items-end gap-3">
        <div className="flex min-w-0 w-full max-w-full flex-1 flex-col gap-1 sm:min-w-[20rem] sm:max-w-[min(100%,42rem)] lg:min-w-[24rem]">
          <span className="shrink-0 text-sm font-medium leading-none text-foreground">Store *</span>
          <select
            value={storeId}
            disabled={storeLoading || !stores.length}
            onChange={(e) => {
              const v = e.target.value;
              setStoreId(v);
              setPage(1);
              syncStoreUrl(v);
            }}
            title={stores.find((s) => s.id === storeId)?.display_name}
            className="block h-10 w-full min-w-[18rem] max-w-full truncate rounded-lg border border-border bg-background px-3 text-sm"
          >
            {stores.length === 0 ? <option value="">No stores</option> : null}
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex w-full min-w-[12rem] max-w-full flex-col gap-1 sm:w-auto">
          <span className="flex items-center gap-1.5 text-sm font-medium leading-none text-foreground">
            <Banknote className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            Price display
            <PimHelpNote label="Currency in the catalog">
              <div className="space-y-2">
                <p>
                  Default comes from <span className="font-medium">Settings → General → Display currency</span>. Changing the menu here only affects
                  number formatting in this catalog (grid, groups, product details). Stored amounts in the database are unchanged.
                </p>
                <p>If a row has its own currency from imports or Amazon, that value still wins.</p>
              </div>
            </PimHelpNote>
          </span>
          <select
            value={displayCurrency}
            onChange={(e) => setDisplayCurrency(e.target.value)}
            className="block h-10 w-full min-w-[10rem] rounded-lg border border-border bg-background px-3 text-sm sm:w-40"
            aria-label="Display currency for prices"
          >
            {PIM_DISPLAY_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="max-w-full overflow-x-auto rounded-lg border border-border p-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex min-w-max flex-nowrap">
            {(
              [
                ["grid", "Grid", LayoutGrid] as const,
                ["vendor", "Vendor", Store] as const,
                ["category", "Category", FolderTree] as const,
                ["brand", "Brand", Tag] as const,
                ["identifiers", "Identifiers", Fingerprint] as const,
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setView(id as ViewMode)}
                className={[
                  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-2 text-xs font-medium sm:px-3",
                  view === id ? "bg-muted text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                ].join(" ")}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {!storeId ? (
        <p className="text-sm text-amber-800 dark:text-amber-200">Pick a store to load the catalog.</p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <label className="min-w-[200px] flex-1 text-sm font-medium">
              Search
              <span className="relative mt-1 block">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Name, SKU, ASIN, FNSKU, UPC, brand, vendor…"
                  className="h-10 w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm"
                />
              </span>
            </label>
          </div>

          <div className="mb-4 space-y-1.5 rounded-xl border border-border/50 bg-muted/10 p-2.5 sm:p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex select-none items-center gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filters</span>
                <PimHelpNote label="Filters">
                  <div className="space-y-2">
                    <div>Filters combine with AND (narrow results).</div>
                    <div>
                      If the AI module is enabled, mapping or validation may be assisted automatically on supported import or sync steps; this grid
                      does not call Amazon live APIs.
                    </div>
                  </div>
                </PimHelpNote>
              </div>
              <button
                type="button"
                disabled={!filtersActive}
                onClick={() => clearAllFilters()}
                className="h-8 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              >
                Clear all filters
              </button>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-4">
              <label className="text-xs font-medium text-muted-foreground">
                Vendor
                <select
                  value={vendorFilter}
                  onChange={(e) => {
                    setVendorFilter(e.target.value);
                    setPage(1);
                  }}
                  className="mt-1 h-9 w-full rounded-lg border border-border bg-background text-sm"
                >
                  <option value="">All vendors</option>
                  {vendorOptions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-medium text-muted-foreground">
                Category
                <select
                  value={categoryFilter}
                  onChange={(e) => {
                    setCategoryFilter(e.target.value);
                    setPage(1);
                  }}
                  className="mt-1 h-9 w-full rounded-lg border border-border bg-background text-sm"
                >
                  <option value="">All categories</option>
                  {categoryFilterOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-medium text-muted-foreground">
                Brand name
                <select
                  value={brandFilter}
                  onChange={(e) => {
                    setBrandFilter(e.target.value);
                    setPage(1);
                  }}
                  className="mt-1 h-9 w-full rounded-lg border border-border bg-background text-sm"
                >
                  <option value="">Any brand</option>
                  {(facets?.brands ?? []).map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-medium text-muted-foreground">
                Status
                <select
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value);
                    setPage(1);
                  }}
                  className="mt-1 h-9 w-full rounded-lg border border-border bg-background text-sm"
                >
                  <option value="">All</option>
                  {statusFilterOptions.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <details className="rounded-lg border border-border/60 bg-background/60 px-2.5 py-1.5">
              <summary className="cursor-pointer select-none text-xs font-medium text-foreground">Advanced filters</summary>
              <div className="mt-2 space-y-3">
                <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-4">
                  <TriSelect
                    label="Image"
                    value={filterImage}
                    onChange={(v) => {
                      setFilterImage(v);
                      setPage(1);
                    }}
                  />
                  <TriSelect
                    label="SKU"
                    value={filterSku}
                    onChange={(v) => {
                      setFilterSku(v);
                      setPage(1);
                    }}
                  />
                  <TriSelect
                    label="ASIN"
                    value={filterAsin}
                    onChange={(v) => {
                      setFilterAsin(v);
                      setPage(1);
                    }}
                  />
                  <TriSelect
                    label="FNSKU"
                    value={filterFnsku}
                    onChange={(v) => {
                      setFilterFnsku(v);
                      setPage(1);
                    }}
                  />
                  <TriSelect
                    label="UPC"
                    value={filterUpc}
                    onChange={(v) => {
                      setFilterUpc(v);
                      setPage(1);
                    }}
                  />
                  <TriSelect
                    label="Vendor (assigned)"
                    value={filterVendor}
                    onChange={(v) => {
                      setFilterVendor(v);
                      setPage(1);
                    }}
                  />
                  <TriSelect
                    label="Category (assigned)"
                    value={filterCategory}
                    onChange={(v) => {
                      setFilterCategory(v);
                      setPage(1);
                    }}
                  />
                  <TriSelect
                    label="Brand field"
                    value={filterBrandField}
                    onChange={(v) => {
                      setFilterBrandField(v);
                      setPage(1);
                    }}
                  />
                </div>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  <div className="text-xs font-medium text-muted-foreground">
                    <div className="mb-1">Match source</div>
                    <select
                      aria-label="Match source"
                      value={matchSourceFilter}
                      onChange={(e) => {
                        setMatchSourceFilter(e.target.value);
                        setPage(1);
                      }}
                      className="h-9 w-full rounded-lg border border-border bg-background text-sm"
                    >
                      <option value="">All</option>
                      {(facets?.match_sources ?? []).map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="text-xs font-medium text-muted-foreground">
                    <div className="mb-1">Source report type</div>
                    <select
                      aria-label="Source report type"
                      value={reportTypeFilter}
                      onChange={(e) => {
                        setReportTypeFilter(e.target.value);
                        setPage(1);
                      }}
                      className="h-9 w-full rounded-lg border border-border bg-background text-sm"
                    >
                      <option value="">All</option>
                      {(facets?.source_report_types ?? []).map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </details>
          </div>

          {gridErr ? (
            <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {gridErr}
            </div>
          ) : null}

          {(invalidVendorAudit.length > 0 || invalidCategoryAudit.length > 0) && (
            <div className="mb-4 rounded-xl border border-amber-200/80 bg-amber-50/40 px-3 py-2 dark:border-amber-900/50 dark:bg-amber-950/20">
              <button
                type="button"
                onClick={() => setAuditOpen((o) => !o)}
                className="flex w-full items-center justify-between gap-2 text-left text-sm font-medium text-amber-950 dark:text-amber-100"
              >
                <span>Vendor or category names need cleanup</span>
                <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${auditOpen ? "rotate-180" : ""}`} aria-hidden />
              </button>
              {auditOpen ? (
                <div className="mt-2 space-y-3 text-xs sm:grid sm:grid-cols-2 sm:gap-3 sm:space-y-0">
                  <p className="text-muted-foreground sm:col-span-2">
                    These labels look like placeholders or raw codes (for example bare numbers). Rename the vendor or category in your catalog
                    tools so reporting and filters stay clear.
                  </p>
                  <div>
                    <p className="font-semibold text-foreground">Vendors ({invalidVendorAudit.length})</p>
                    <ul className="mt-1 max-h-48 space-y-1.5 overflow-y-auto text-muted-foreground">
                      {invalidVendorAudit.map((v) => (
                        <li key={v.id} className="rounded-md border border-border/50 bg-background/60 px-2 py-1.5">
                          <span className="text-foreground">{v.name}</span>
                          {typeof v.product_count === "number" ? (
                            <span className="mt-0.5 block text-[11px] text-muted-foreground">
                              {v.product_count} product{v.product_count === 1 ? "" : "s"} in this store
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="font-semibold text-foreground">Categories ({invalidCategoryAudit.length})</p>
                    <ul className="mt-1 max-h-48 space-y-1.5 overflow-y-auto text-muted-foreground">
                      {invalidCategoryAudit.map((c) => (
                        <li key={c.id} className="rounded-md border border-border/50 bg-background/60 px-2 py-1.5">
                          <span className="text-foreground">{c.name}</span>
                          {typeof c.product_count === "number" ? (
                            <span className="mt-0.5 block text-[11px] text-muted-foreground">
                              {c.product_count} product{c.product_count === 1 ? "" : "s"} in this store
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {view === "identifiers" ? (
            <PimIdentifierGroupsView organizationId={oid} storeId={storeId} onSearchThisKey={applyIdentifierSearch} />
          ) : view === "grid" ? (
            <CatalogDataGrid
              rows={rows}
              total={total}
              loading={gridLoading}
              page={page}
              pageSize={pageSize}
              sort={sort}
              dir={dir}
              onSort={onSort}
              onPageChange={(p) => setPage(p)}
              onPageSizeChange={(n) => {
                setPageSize(n);
                setPage(1);
              }}
              onOpenProduct={(id) => setDrawerId(id)}
              onEditProduct={(id) => {
                setEditId(id);
                setFormOpen(true);
              }}
              filtersActive={filtersActive}
              onClearFilters={() => clearAllFilters()}
              onImagePreview={(urls, startIndex) => setImagePreview({ urls, index: startIndex })}
              displayCurrency={displayCurrency}
            />
          ) : bucketDimension ? (
            <PimGroupTreeView
              organizationId={oid}
              storeId={storeId}
              dimension={bucketDimension}
              onApplyToGrid={applyGroupToGrid}
              onOpenProduct={(id) => setDrawerId(id)}
              onEditProduct={(id) => {
                setEditId(id);
                setFormOpen(true);
              }}
              displayCurrency={displayCurrency}
            />
          ) : null}
        </>
      )}

      {imagePreview ? (
        <ImageLightbox
          urls={imagePreview.urls}
          index={imagePreview.index}
          onClose={() => setImagePreview(null)}
          onIndexChange={(i) => setImagePreview((s) => (s ? { ...s, index: i } : s))}
        />
      ) : null}

      {drawerId && storeId ? (
        <ProductDetailDrawer
          organizationId={oid}
          storeId={storeId}
          productId={drawerId}
          displayCurrency={displayCurrency}
          onClose={() => setDrawerId(null)}
          onEdit={(id) => {
            setDrawerId(null);
            setEditId(id);
            setFormOpen(true);
          }}
        />
      ) : null}

      <ManualProductForm
        open={formOpen}
        onClose={() => {
          setFormOpen(false);
          setEditId(null);
        }}
        organizationId={oid}
        storeId={storeId}
        stores={stores}
        storesLoading={storeLoading}
        editingProductId={editId}
        onSaved={() => {
          setToast("Saved.");
          window.setTimeout(() => setToast(null), 3000);
          void loadGrid();
          void loadFacets();
          void refreshVendorsAgg();
          if (categoryListUrl) {
            void fetch(categoryListUrl, { credentials: "same-origin" })
              .then(async (r) => {
                const d = (await r.json()) as {
                  ok?: boolean;
                  categories?: { id: string; name: string; product_count?: number }[];
                };
                if (!r.ok || d.ok === false) return;
                setCategoryOptionsRaw(Array.isArray(d.categories) ? d.categories : []);
              })
              .catch(() => {});
          }
          window.dispatchEvent(new Event("pim-catalog-refresh"));
        }}
      />
    </section>
  );
}
