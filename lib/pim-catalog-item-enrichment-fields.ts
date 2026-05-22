/**
 * Pure helpers to read fields from Amazon Catalog Items API JSON (no network).
 */

export function isWeakProductName(name: unknown): boolean {
  const t = typeof name === "string" ? name.trim() : "";
  if (!t || t.length < 2) return true;
  if (/^(untitled|product|item|new product|sku|tbd)$/i.test(t)) return true;
  return false;
}

export function extractSummaryItemNameBrand(body: unknown): { product_name: string | null; brand: string | null } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { product_name: null, brand: null };
  }
  const root = body as unknown as Record<string, unknown>;
  const summaries = root.summaries;
  let product_name: string | null = null;
  let brand: string | null = null;
  if (Array.isArray(summaries) && summaries[0] && typeof summaries[0] === "object") {
    const s0 = summaries[0] as unknown as Record<string, unknown>;
    const n = s0.itemName ?? s0.item_name;
    const b = s0.brand;
    if (typeof n === "string" && n.trim()) product_name = n.trim();
    if (typeof b === "string" && b.trim()) brand = b.trim();
  }
  return { product_name, brand };
}

export type AmazonCategoryCandidate = {
  label: string;
  source:
    | "browse_classification"
    | "browse_hierarchy"
    | "product_type"
    | "sales_ranks"
    | "attr_item_type_keyword"
    | "attr_product_type"
    | "attr_department"
    | "attr_target_audience"
    | "attr_item_type_name";
  score: number;
};

function flattenAmazonAttrValues(v: unknown): string[] {
  if (v == null) return [];
  if (typeof v === "string") {
    const t = v.trim();
    return t.length > 1 ? [t] : [];
  }
  if (typeof v === "number" && Number.isFinite(v)) return [String(v)];
  if (Array.isArray(v)) {
    const acc: string[] = [];
    for (const x of v) acc.push(...flattenAmazonAttrValues(x));
    return acc;
  }
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if ("value" in o) return flattenAmazonAttrValues(o.value);
    return [];
  }
  return [];
}

function humanizeProductTypeLabel(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (s.includes("_") || s === s.toUpperCase()) {
    return s
      .split(/[_\s]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ");
  }
  return s;
}

export function dedupeAmazonCategoryCandidatesByMaxScore(list: AmazonCategoryCandidate[]): AmazonCategoryCandidate[] {
  const dedup = new Map<string, AmazonCategoryCandidate>();
  for (const c of list) {
    const k = c.label.trim().toLowerCase();
    if (!k) continue;
    const prev = dedup.get(k);
    if (!prev || c.score > prev.score) dedup.set(k, c);
  }
  return [...dedup.values()].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

/**
 * Ordered category / taxonomy candidates from Catalog Items API JSON only (no network).
 * Higher `score` = safer for auto-assign / auto-create.
 */
export function extractAmazonCategoryCandidates(body: unknown): AmazonCategoryCandidate[] {
  const out: AmazonCategoryCandidate[] = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return out;
  const root = body as unknown as Record<string, unknown>;

  const browse = extractBrowseCategoryDisplayName(body);
  if (browse) out.push({ label: browse, source: "browse_classification", score: 0.92 });

  const summaries = root.summaries;
  if (Array.isArray(summaries) && summaries[0] && typeof summaries[0] === "object") {
    const s0 = summaries[0] as unknown as Record<string, unknown>;
    const bc = s0.browseClassification ?? s0.browse_classification;
    if (bc && typeof bc === "object" && !Array.isArray(bc)) {
      const b = bc as unknown as Record<string, unknown>;
      const hierarchy = b.classificationHierarchy ?? b.classification_hierarchy;
      if (Array.isArray(hierarchy)) {
        for (const node of hierarchy) {
          if (!node || typeof node !== "object" || Array.isArray(node)) continue;
          const d = (node as unknown as Record<string, unknown>).displayName ?? (node as unknown as Record<string, unknown>).display_name;
          if (typeof d === "string" && d.trim().length > 1) {
            const label = d.trim();
            if (!browse || label.toLowerCase() !== browse.toLowerCase()) {
              out.push({ label, source: "browse_hierarchy", score: 0.84 });
            }
          }
        }
      }
    }
  }

  const productTypes = root.productTypes;
  if (Array.isArray(productTypes)) {
    for (const pt of productTypes) {
      if (typeof pt === "string" && pt.trim()) {
        const label = humanizeProductTypeLabel(pt);
        if (label) out.push({ label, source: "product_type", score: 0.78 });
      } else if (pt && typeof pt === "object" && !Array.isArray(pt)) {
        const o = pt as unknown as Record<string, unknown>;
        const raw =
          (typeof o.productType === "string" && o.productType) ||
          (typeof o.displayName === "string" && o.displayName) ||
          (typeof o.productType === "object" && o.productType != null
            ? String((o.productType as unknown as Record<string, unknown>).displayName ?? "")
            : "");
        const label = humanizeProductTypeLabel(String(raw));
        if (label) out.push({ label, source: "product_type", score: 0.79 });
      }
    }
  }

  const salesRanks = root.salesRanks;
  if (Array.isArray(salesRanks)) {
    for (const block of salesRanks) {
      if (!block || typeof block !== "object" || Array.isArray(block)) continue;
      const ranks = (block as unknown as Record<string, unknown>).ranks;
      if (!Array.isArray(ranks)) continue;
      for (const r of ranks) {
        if (!r || typeof r !== "object" || Array.isArray(r)) continue;
        const title = (r as unknown as Record<string, unknown>).title ?? (r as unknown as Record<string, unknown>).displayName;
        if (typeof title !== "string" || title.trim().length < 3) continue;
        const t = title.trim();
        if (/^\d+$/.test(t)) continue;
        out.push({ label: t, source: "sales_ranks", score: 0.62 });
      }
    }
  }

  const attrs = root.attributes;
  if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
    const a = attrs as unknown as Record<string, unknown>;
    const pushAttr = (key: string, source: AmazonCategoryCandidate["source"], score: number) => {
      for (const s of flattenAmazonAttrValues(a[key])) {
        if (s.length > 1) out.push({ label: s, source, score });
      }
    };
    pushAttr("item_type_keyword", "attr_item_type_keyword", 0.58);
    pushAttr("product_type", "attr_product_type", 0.64);
    pushAttr("department", "attr_department", 0.52);
    pushAttr("target_audience", "attr_target_audience", 0.48);
    pushAttr("item_type_name", "attr_item_type_name", 0.56);
  }

  const dedup = new Map<string, AmazonCategoryCandidate>();
  for (const c of out) {
    const k = c.label.toLowerCase();
    const prev = dedup.get(k);
    if (!prev || c.score > prev.score) dedup.set(k, c);
  }
  return [...dedup.values()].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

/** Stored on `products.metadata.pim_category_source` after enrichment. */
export function pimCategorySourceFromCandidate(
  c: AmazonCategoryCandidate | null,
  viaAi: boolean,
): "amazon_browse" | "amazon_product_type" | "amazon_attributes" | "ai_assisted" {
  if (viaAi) return "ai_assisted";
  if (!c) return "amazon_attributes";
  if (c.source === "browse_classification" || c.source === "browse_hierarchy") return "amazon_browse";
  if (c.source === "product_type") return "amazon_product_type";
  return "amazon_attributes";
}

/** Best-effort browse / classification display label for matching local categories. */
export function extractBrowseCategoryDisplayName(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const root = body as unknown as Record<string, unknown>;
  const summaries = root.summaries;
  if (!Array.isArray(summaries) || !summaries[0] || typeof summaries[0] !== "object") return null;
  const s0 = summaries[0] as unknown as Record<string, unknown>;
  const bc = s0.browseClassification ?? s0.browse_classification;
  if (bc && typeof bc === "object" && !Array.isArray(bc)) {
    const b = bc as unknown as Record<string, unknown>;
    const display = b.displayName ?? b.display_name;
    if (typeof display === "string" && display.trim()) return display.trim();
    const hierarchy = b.classificationHierarchy ?? b.classification_hierarchy;
    if (Array.isArray(hierarchy) && hierarchy.length) {
      const last = hierarchy[hierarchy.length - 1];
      if (last && typeof last === "object") {
        const d = (last as unknown as Record<string, unknown>).displayName ?? (last as unknown as Record<string, unknown>).display_name;
        if (typeof d === "string" && d.trim()) return d.trim();
      }
    }
  }
  return null;
}

export function extractListPriceFromCatalog(body: unknown): { amount: number; currency: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const root = body as unknown as Record<string, unknown>;
  const tryPrice = (node: unknown): { amount: number; currency: string } | null => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return null;
    const o = node as unknown as Record<string, unknown>;
    const amount = o.amount ?? o.value ?? o.price;
    const currency = typeof o.currency === "string" && o.currency.trim() ? o.currency.trim() : "USD";
    const n = typeof amount === "number" ? amount : typeof amount === "string" ? Number.parseFloat(amount) : Number.NaN;
    if (!Number.isFinite(n) || n <= 0) return null;
    return { amount: n, currency: currency.length === 3 ? currency : "USD" };
  };

  const summaries = root.summaries;
  if (Array.isArray(summaries) && summaries[0] && typeof summaries[0] === "object") {
    const s0 = summaries[0] as unknown as Record<string, unknown>;
    const lp = s0.listPrice ?? s0.list_price ?? s0.listingPrice ?? s0.listing_price;
    const hit = tryPrice(lp);
    if (hit) return hit;
  }

  const attrs = root.attributes;
  if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
    const a = attrs as unknown as Record<string, unknown>;
    for (const k of ["list_price", "listPrice", "purchasable_offer", "your_price"]) {
      const hit = tryPrice(a[k]);
      if (hit) return hit;
    }
  }

  return null;
}

export type ProvenanceFieldPatch = {
  source?: string;
  priority?: number;
  confidence?: number;
};

export function mergeEnrichmentProvenance(
  existing: unknown,
  fields: string[],
  perField?: Partial<Record<string, ProvenanceFieldPatch>>,
): Record<string, unknown> | null {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as unknown as Record<string, unknown>) }
      : {};
  const now = new Date().toISOString();
  for (const f of fields) {
    const o = perField?.[f];
    base[f] = {
      source: o?.source ?? "amazon_catalog_enrichment",
      priority: o?.priority ?? 70,
      confidence: o?.confidence ?? 0.82,
      written_at: now,
    };
  }
  return Object.keys(base).length ? base : null;
}
