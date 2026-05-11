"use client";

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import { normalizePimProductStatus, PIM_PRODUCT_STATUSES } from "../../../../lib/pim-product-status";
import type { PimStoreOption } from "../pim-actions";

type PimVendorRow = { id: string; name: string };
type PimCategoryRow = { id: string; name: string };

function isUuidString(s: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(s.trim());
}

export function ManualProductForm({
  open,
  onClose,
  organizationId,
  storeId,
  stores,
  storesLoading,
  editingProductId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  organizationId: string;
  storeId: string;
  stores: PimStoreOption[];
  storesLoading: boolean;
  editingProductId: string | null;
  onSaved: () => void;
}) {
  const [vendors, setVendors] = useState<PimVendorRow[]>([]);
  const [categories, setCategories] = useState<PimCategoryRow[]>([]);
  const [listsLoading, setListsLoading] = useState(false);
  const [productName, setProductName] = useState("");
  const [localStoreId, setLocalStoreId] = useState(storeId);
  const [vendorId, setVendorId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [brand, setBrand] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [sku, setSku] = useState("");
  const [asin, setAsin] = useState("");
  const [fnsku, setFnsku] = useState("");
  const [upc, setUpc] = useState("");
  const [mpn, setMpn] = useState("");
  const [status, setStatus] = useState("");
  const [condition, setCondition] = useState("");
  const [mainImageUrl, setMainImageUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [productAttributesJson, setProductAttributesJson] = useState("");
  const [newVendor, setNewVendor] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Resolved display name for category_id from product GET (join / product row). */
  const [apiCategoryName, setApiCategoryName] = useState("");
  /** Product has category text on the row but no category_id FK. */
  const [categoryUnlinkedLabel, setCategoryUnlinkedLabel] = useState("");
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const scrollLockRef = useRef<{
    scrollY: number;
    bodyPosition: string;
    bodyTop: string;
    bodyLeft: string;
    bodyRight: string;
    bodyWidth: string;
  } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const scrollY = window.scrollY;
    const b = document.body;
    scrollLockRef.current = {
      scrollY,
      bodyPosition: b.style.position,
      bodyTop: b.style.top,
      bodyLeft: b.style.left,
      bodyRight: b.style.right,
      bodyWidth: b.style.width,
    };
    b.style.position = "fixed";
    b.style.top = `-${scrollY}px`;
    b.style.left = "0";
    b.style.right = "0";
    b.style.width = "100%";
    return () => {
      const prev = scrollLockRef.current;
      scrollLockRef.current = null;
      if (!prev) return;
      b.style.position = prev.bodyPosition;
      b.style.top = prev.bodyTop;
      b.style.left = prev.bodyLeft;
      b.style.right = prev.bodyRight;
      b.style.width = prev.bodyWidth;
      window.scrollTo(0, prev.scrollY);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => {
      firstFieldRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(id);
  }, [open, editingProductId]);

  useEffect(() => {
    if (!open) return;
    if (!editingProductId) setLocalStoreId(storeId);
    setListsLoading(true);
    const vq = new URLSearchParams({ organization_id: organizationId, exclude_invalid_names: "1" });
    const cq = new URLSearchParams({ organization_id: organizationId, exclude_invalid_names: "1" });
    const sidForLists = (editingProductId ? storeId : localStoreId).trim();
    if (sidForLists) {
      vq.set("store_id", sidForLists);
      cq.set("store_id", sidForLists);
    }
    void Promise.all([
      fetch(`/api/dashboard/vendors?${vq.toString()}`, { credentials: "same-origin" }).then(async (r) => ({
        ok: r.ok,
        json: (await r.json()) as { ok?: boolean; vendors?: PimVendorRow[] },
      })),
      fetch(`/api/dashboard/product-categories?${cq.toString()}`, { credentials: "same-origin" }).then(async (r) => ({
        ok: r.ok,
        json: (await r.json()) as { ok?: boolean; categories?: PimCategoryRow[]; error?: string },
      })),
    ])
      .then(([v, c]) => {
        if (v.ok && v.json?.ok) setVendors(Array.isArray(v.json.vendors) ? v.json.vendors : []);
        if (c.ok && c.json?.ok) setCategories(Array.isArray(c.json.categories) ? c.json.categories : []);
      })
      .finally(() => setListsLoading(false));
  }, [open, organizationId, storeId, localStoreId, editingProductId]);

  useEffect(() => {
    if (!open) return;
    if (editingProductId) {
      const u = new URL(`/api/dashboard/products/${encodeURIComponent(editingProductId)}`, window.location.origin);
      u.searchParams.set("organization_id", organizationId);
      u.searchParams.set("store_id", storeId);
      void fetch(u.toString(), { credentials: "same-origin" })
        .then(async (r) => {
          const data = (await r.json()) as {
            ok?: boolean;
            product?: Record<string, unknown>;
            category_name?: string | null;
          };
          if (!r.ok || !data.ok || !data.product) return;
          const pr = data.product;
          setProductName(String(pr.product_name ?? ""));
          setLocalStoreId(String(pr.store_id ?? storeId));
          setVendorId(String(pr.vendor_id ?? ""));
          const cid = String(pr.category_id ?? "").trim();
          setCategoryId(cid);
          setBrand(String(pr.brand ?? ""));
          setVendorName(String(pr.vendor_name ?? ""));
          setSku(String(pr.sku ?? ""));
          setAsin(String(pr.asin ?? ""));
          setFnsku(String(pr.fnsku ?? ""));
          setUpc(String(pr.upc_code ?? ""));
          setMpn(String(pr.mfg_part_number ?? ""));
          setStatus(normalizePimProductStatus(String(pr.status ?? "")));
          setCondition(String(pr.condition ?? ""));
          setMainImageUrl(String(pr.main_image_url ?? ""));
          const meta = pr.metadata as { pim_ui?: { notes?: string }; product_attributes?: Record<string, unknown> } | undefined;
          setNotes(typeof meta?.pim_ui?.notes === "string" ? meta.pim_ui.notes : "");
          const pa = meta?.product_attributes;
          setProductAttributesJson(
            pa && typeof pa === "object" && !Array.isArray(pa) ? JSON.stringify(pa, null, 2) : "",
          );

          const fromApi = data.category_name != null && String(data.category_name).trim() ? String(data.category_name).trim() : "";
          const fromProductNameCol =
            pr.category_name != null && String(pr.category_name).trim() ? String(pr.category_name).trim() : "";
          const fromLegacyCategory = pr.category != null && String(pr.category).trim() ? String(pr.category).trim() : "";
          const resolved = fromApi || fromProductNameCol || fromLegacyCategory;
          setApiCategoryName(resolved);
          if (!cid && resolved) setCategoryUnlinkedLabel(resolved);
          else setCategoryUnlinkedLabel("");
        })
        .catch(() => {});
    } else {
      setProductName("");
      setVendorId("");
      setCategoryId("");
      setBrand("");
      setVendorName("");
      setSku("");
      setAsin("");
      setFnsku("");
      setUpc("");
      setMpn("");
      setStatus("active");
      setCondition("");
      setMainImageUrl("");
      setNotes("");
      setNewVendor("");
      setNewCategory("");
      setErr(null);
      setApiCategoryName("");
      setCategoryUnlinkedLabel("");
      setProductAttributesJson("");
    }
  }, [open, editingProductId, organizationId, storeId]);

  const categorySelectRows = useMemo(() => {
    const rows: PimCategoryRow[] = categories.map((c) => ({ id: c.id, name: c.name }));
    const cid = categoryId.trim();
    if (cid && isUuidString(cid) && !rows.some((r) => r.id === cid)) {
      const label = apiCategoryName.trim()
        ? `${apiCategoryName.trim()} (linked id)`
        : "Linked category (not in current dropdown list)";
      rows.push({ id: cid, name: label });
    }
    return rows;
  }, [categories, categoryId, apiCategoryName]);

  async function addVendorInline() {
    const n = newVendor.trim();
    if (!n) return;
    const res = await fetch("/api/dashboard/vendors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization_id: organizationId, name: n }),
    });
    const data = (await res.json()) as { ok?: boolean; vendor?: { id: string }; error?: string };
    if (!res.ok || !data.ok) {
      setErr(data.error ?? "Vendor create failed.");
      return;
    }
    setNewVendor("");
    if (data.vendor?.id) setVendorId(data.vendor.id);
    const vq = new URLSearchParams({ organization_id: organizationId, exclude_invalid_names: "1" });
    if (storeId.trim()) vq.set("store_id", storeId.trim());
    const r = await fetch(`/api/dashboard/vendors?${vq.toString()}`);
    const j = (await r.json()) as { vendors?: PimVendorRow[] };
    setVendors(j.vendors ?? []);
  }

  async function addCategoryInline() {
    const n = newCategory.trim();
    if (!n) return;
    const res = await fetch("/api/dashboard/product-categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization_id: organizationId, name: n }),
    });
    const data = (await res.json()) as { ok?: boolean; category?: { id: string }; error?: string };
    if (!res.ok || !data.ok) {
      setErr(data.error ?? "Category create failed.");
      return;
    }
    setNewCategory("");
    if (data.category?.id) setCategoryId(data.category.id);
    const cq = new URLSearchParams({ organization_id: organizationId, exclude_invalid_names: "1" });
    if (storeId.trim()) cq.set("store_id", storeId.trim());
    const r = await fetch(`/api/dashboard/product-categories?${cq.toString()}`, { credentials: "same-origin" });
    const j = (await r.json()) as { ok?: boolean; categories?: PimCategoryRow[] };
    if (r.ok && j?.ok) setCategories(Array.isArray(j.categories) ? j.categories : []);
  }

  async function submit() {
    const sid = (localStoreId || storeId).trim();
    if (!productName.trim() || !sku.trim() || !sid) {
      setErr("Product name, SKU, and store are required.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      let product_attributes: Record<string, unknown> | null = null;
      const rawJson = productAttributesJson.trim();
      if (rawJson) {
        try {
          const parsed = JSON.parse(rawJson) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            setErr("Product attributes must be a JSON object, e.g. {\"pack_count\": \"6\"}.");
            setSaving(false);
            return;
          }
          product_attributes = parsed as Record<string, unknown>;
        } catch {
          setErr("Invalid JSON in product attributes.");
          setSaving(false);
          return;
        }
      }
      const body = {
        organization_id: organizationId,
        store_id: sid,
        product_name: productName.trim(),
        brand: brand.trim() || null,
        vendor_name: vendorName.trim() || null,
        vendor_id: vendorId || null,
        category_id: categoryId || null,
        sku: sku.trim(),
        asin: asin.trim() || null,
        fnsku: fnsku.trim() || null,
        upc_code: upc.trim() || null,
        mfg_part_number: mpn.trim() || null,
        status: status.trim() || "active",
        condition: condition.trim() || null,
        main_image_url: mainImageUrl.trim() || null,
        notes: notes.trim() || null,
        ...(product_attributes ? { product_attributes } : {}),
      };
      const url = editingProductId
        ? `/api/dashboard/products/${encodeURIComponent(editingProductId)}`
        : "/api/dashboard/products";
      const res = await fetch(url, {
        method: editingProductId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setErr(data.error ?? "Save failed.");
        return;
      }
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  const field =
    "mt-1 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

  const modal = (
    <div
      className="fixed inset-0 z-[350] flex items-center justify-center overflow-hidden bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[min(92vh,900px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border p-6 pb-4">
          <h2 className="text-lg font-semibold text-foreground">{editingProductId ? "Edit product" : "Add product"}</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pt-4">
          {err ? <p className="mb-3 text-sm text-destructive">{err}</p> : null}
          <div className="grid gap-3 sm:grid-cols-2">
          <label className="sm:col-span-2 block text-sm font-medium">
            Product name *
            <input ref={firstFieldRef} value={productName} onChange={(e) => setProductName(e.target.value)} className={field} />
          </label>
          <label className="block text-sm font-medium">
            Store *
            <select
              value={localStoreId}
              disabled={storesLoading || !!editingProductId}
              onChange={(e) => setLocalStoreId(e.target.value)}
              className={field}
            >
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.display_name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium">
            Status
            <select value={status || "active"} onChange={(e) => setStatus(e.target.value)} className={field}>
              {PIM_PRODUCT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium">
            Vendor
            <select value={vendorId} disabled={listsLoading} onChange={(e) => setVendorId(e.target.value)} className={field}>
              <option value="">—</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 text-sm font-medium">
              New vendor
              <input value={newVendor} onChange={(e) => setNewVendor(e.target.value)} className={field} placeholder="Name" />
            </label>
            <button
              type="button"
              disabled={!newVendor.trim()}
              onClick={() => void addVendorInline()}
              className="mb-0.5 h-10 shrink-0 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              Add
            </button>
          </div>
          <label className="block text-sm font-medium">
            Category
            <select value={categoryId} disabled={listsLoading} onChange={(e) => setCategoryId(e.target.value)} className={field}>
              <option value="">—</option>
              {categorySelectRows.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {categoryUnlinkedLabel ? (
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Displayed category (not linked to taxonomy): <span className="font-medium text-foreground">{categoryUnlinkedLabel}</span>
              {" — "}
              pick a row above to set <span className="font-mono">category_id</span>.
            </p>
          ) : null}
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 text-sm font-medium">
              New category
              <input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} className={field} placeholder="Name" />
            </label>
            <button
              type="button"
              disabled={!newCategory.trim()}
              onClick={() => void addCategoryInline()}
              className="mb-0.5 h-10 shrink-0 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              Add
            </button>
          </div>
          <label className="block text-sm font-medium">
            Vendor name (display)
            <input value={vendorName} onChange={(e) => setVendorName(e.target.value)} className={field} />
          </label>
          <label className="block text-sm font-medium">
            Brand
            <input value={brand} onChange={(e) => setBrand(e.target.value)} className={field} />
          </label>
          <label className="block text-sm font-medium">
            SKU *
            <input value={sku} onChange={(e) => setSku(e.target.value)} disabled={!!editingProductId} className={`${field} font-mono`} />
          </label>
          <label className="block text-sm font-medium">
            ASIN
            <input value={asin} onChange={(e) => setAsin(e.target.value)} className={`${field} font-mono`} />
          </label>
          <label className="block text-sm font-medium">
            FNSKU
            <input value={fnsku} onChange={(e) => setFnsku(e.target.value)} className={`${field} font-mono`} />
          </label>
          <label className="block text-sm font-medium">
            UPC
            <input value={upc} onChange={(e) => setUpc(e.target.value)} className={`${field} font-mono`} />
          </label>
          <label className="block text-sm font-medium">
            MPN
            <input value={mpn} onChange={(e) => setMpn(e.target.value)} className={field} />
          </label>
          <label className="block text-sm font-medium">
            Condition
            <input value={condition} onChange={(e) => setCondition(e.target.value)} className={field} />
          </label>
          <label className="sm:col-span-2 block text-sm font-medium">
            Main image URL
            <input value={mainImageUrl} onChange={(e) => setMainImageUrl(e.target.value)} className={field} />
          </label>
          <label className="sm:col-span-2 block text-sm font-medium">
            Notes (stored in metadata.pim_ui.notes)
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={`${field} h-auto py-2`} />
          </label>
          <label className="sm:col-span-2 block text-sm font-medium">
            Extra attributes (JSON → metadata.product_attributes)
            <textarea
              value={productAttributesJson}
              onChange={(e) => setProductAttributesJson(e.target.value)}
              rows={5}
              placeholder='{"pack_count":"6","weight":"1.2 lb"}'
              className={`${field} h-auto py-2 font-mono text-xs`}
            />
          </label>
          </div>
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-border bg-card p-6 pt-4">
          <button type="button" onClick={onClose} className="h-10 rounded-lg border border-border px-4 text-sm hover:bg-muted">
            Cancel
          </button>
          <button
            type="button"
            disabled={saving || storesLoading || !productName.trim() || !sku.trim()}
            onClick={() => void submit()}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(modal, document.body) : null;
}
