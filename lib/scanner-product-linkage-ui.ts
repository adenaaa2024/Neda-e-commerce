/**
 * Scanner / return_items product linkage display helpers (SCANNER-02E).
 * Client-safe — no server-only imports.
 */

export type IdentifierResolutionStatus =
  | "resolved"
  | "ambiguous"
  | "unresolved"
  | "mismatch"
  | string
  | null;

export type ProductLinkageFields = {
  item_name?: string | null;
  sku?: string | null;
  asin?: string | null;
  fnsku?: string | null;
  product_identifier?: string | null;
  resolved_product_id?: string | null;
  resolved_catalog_product_id?: string | null;
  identifier_resolution_status?: IdentifierResolutionStatus;
  identifier_resolution_confidence?: number | null;
  expiration_date?: string | null;
  /** Populated by listReturns batch hydrate — avoids per-row client fetch. */
  catalog_product_name?: string | null;
};

export const RESOLVER_SOURCE_LABEL = "product_identifier_map" as const;

/** Short UI label for dense tables; full table name in `title` / tooltips via `RESOLVER_SOURCE_LABEL`. */
export const RESOLVER_SOURCE_LABEL_COMPACT = "Identifier map" as const;

export function normalizeResolutionStatus(
  status: IdentifierResolutionStatus,
): IdentifierResolutionStatus {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  /** EP/view rows often persist `matched` while return_items use `resolved` — same operator meaning. */
  if (s === "matched") return "resolved";
  if (s === "resolved" || s === "ambiguous" || s === "unresolved" || s === "mismatch") return s;
  return status;
}

export function isUnresolvedLinkageStatus(status: IdentifierResolutionStatus): boolean {
  const s = normalizeResolutionStatus(status);
  return s === "unresolved" || s == null || s === "";
}

export function isAmbiguousLinkageStatus(status: IdentifierResolutionStatus): boolean {
  return normalizeResolutionStatus(status) === "ambiguous";
}

export function isMismatchLinkageStatus(status: IdentifierResolutionStatus): boolean {
  return normalizeResolutionStatus(status) === "mismatch";
}

export function isResolvedLinkageStatus(status: IdentifierResolutionStatus): boolean {
  return normalizeResolutionStatus(status) === "resolved" && true;
}

export function resolutionStatusLabel(status: IdentifierResolutionStatus): string {
  const s = normalizeResolutionStatus(status);
  switch (s) {
    case "resolved":
      return "Linked";
    case "ambiguous":
      return "Ambiguous";
    case "unresolved":
      return "Unresolved";
    case "mismatch":
      return "Mismatch";
    default:
      return "No map link";
  }
}

export function resolutionStatusBadgeClass(status: IdentifierResolutionStatus): string {
  const s = normalizeResolutionStatus(status);
  switch (s) {
    case "resolved":
      return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border-emerald-500/30";
    case "ambiguous":
      return "bg-amber-500/15 text-amber-900 dark:text-amber-200 border-amber-500/30";
    case "mismatch":
      return "bg-rose-500/15 text-rose-800 dark:text-rose-300 border-rose-500/30";
    case "unresolved":
      return "bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/30";
    default:
      return "bg-slate-500/10 text-muted-foreground border-border";
  }
}

export function formatLinkageConfidence(confidence: number | null | undefined): string | null {
  if (confidence == null || Number.isNaN(confidence)) return null;
  const pct = confidence <= 1 ? Math.round(confidence * 100) : Math.round(confidence);
  return `${pct}%`;
}

/** `products` row may expose legacy `name` and/or PIM `product_name` depending on migration state. */
export type ProductNameFields = {
  name?: string | null;
  product_name?: string | null;
};

/** Canonical product title from DB row: `name` then `product_name`. */
export function pickProductRowDisplayName(row: ProductNameFields): string | null {
  const fromName = row.name?.trim();
  if (fromName) return fromName;
  const fromProductName = row.product_name?.trim();
  if (fromProductName) return fromProductName;
  return null;
}

/**
 * UI headline: resolved canonical title when present, else operator/OCR/identifier fallback.
 */
export function resolveLinkageDisplayTitle(
  canonicalTitle: string | null | undefined,
  fields: ProductLinkageFields,
): string {
  const canonical = canonicalTitle?.trim();
  if (canonical) return canonical;
  return fallbackDisplayTitle(fields);
}

/** Primary display title when not using canonical fetch: operator/OCR item_name, then identifiers. */
export function fallbackDisplayTitle(fields: ProductLinkageFields): string {
  const name = fields.item_name?.trim();
  if (name) return name;
  return (
    fields.sku?.trim() ||
    fields.asin?.trim() ||
    fields.fnsku?.trim() ||
    fields.product_identifier?.trim() ||
    "—"
  );
}

export function rawIdentifierSummary(fields: ProductLinkageFields): string {
  const parts = [
    fields.sku?.trim() ? `SKU ${fields.sku.trim()}` : null,
    fields.asin?.trim() ? `ASIN ${fields.asin.trim()}` : null,
    fields.fnsku?.trim() ? `FNSKU ${fields.fnsku.trim()}` : null,
    fields.product_identifier?.trim() ? `UPC/GTIN ${fields.product_identifier.trim()}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No identifiers";
}
