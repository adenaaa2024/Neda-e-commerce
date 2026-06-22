/**
 * Phase 1 — Returns & Logistics "Items" tab column registry + view-settings persistence.
 *
 * Pure UI/presentation config. No backend, no DB schema, no data logic.
 * Controls which Items-report columns are rendered (header + body). Hidden columns
 * are simply not rendered; sorting state is independent and is never mutated here.
 *
 * User choice persists in localStorage under `returns.items.visibleColumns`.
 * Invalid/corrupt storage falls back to the default visible set.
 */

export type ItemsColumnId =
  | "company"
  | "item_identifiers"
  | "product"
  | "tracking"
  | "lpn"
  | "store"
  | "condition"
  | "status"
  | "expiry"
  | "photo"
  | "hierarchy"
  | "box"
  | "pallet"
  | "scan_source"
  | "exception"
  | "operator"
  | "date";

export type ItemsColumnDef = {
  id: ItemsColumnId;
  /** Human label shown in the column manager. */
  label: string;
  /** Visible by default (when applicable to the current scope). */
  defaultVisible: boolean;
  /**
   * Column is only available/toggleable when "All companies" mode is active.
   * When scoped to a single company it is never offered or rendered.
   */
  requiresAllCompanies?: boolean;
};

/**
 * Ordered registry — order matches the Items table header/body column order so the
 * column manager and the rendered table stay aligned.
 */
export const ITEMS_COLUMN_REGISTRY: readonly ItemsColumnDef[] = [
  { id: "company", label: "Company", defaultVisible: true, requiresAllCompanies: true },
  { id: "item_identifiers", label: "Item / Identifiers", defaultVisible: true },
  { id: "product", label: "Product", defaultVisible: true },
  { id: "tracking", label: "Tracking", defaultVisible: true },
  { id: "lpn", label: "LPN", defaultVisible: false },
  { id: "store", label: "Store", defaultVisible: true },
  { id: "condition", label: "Conditions", defaultVisible: false },
  { id: "status", label: "Status", defaultVisible: true },
  { id: "expiry", label: "Expiry", defaultVisible: false },
  { id: "photo", label: "Photo", defaultVisible: false },
  { id: "hierarchy", label: "Hierarchy", defaultVisible: false },
  { id: "box", label: "Box #", defaultVisible: true },
  { id: "pallet", label: "Pallet #", defaultVisible: true },
  { id: "scan_source", label: "Scan Source", defaultVisible: true },
  { id: "exception", label: "Exception", defaultVisible: true },
  { id: "operator", label: "Operator", defaultVisible: true },
  { id: "date", label: "Date", defaultVisible: true },
] as const;

export const ITEMS_COLUMNS_STORAGE_KEY = "returns.items.visibleColumns";

const KNOWN_COLUMN_IDS: ReadonlySet<ItemsColumnId> = new Set(
  ITEMS_COLUMN_REGISTRY.map((c) => c.id),
);

/** Registry entries available in the current scope (drops all-companies-only columns when scoped). */
export function availableItemsColumns(allCompanies: boolean): ItemsColumnDef[] {
  return ITEMS_COLUMN_REGISTRY.filter((c) => !(c.requiresAllCompanies && !allCompanies));
}

/** Default visible column ids for the current scope. */
export function defaultVisibleItemsColumns(allCompanies: boolean): ItemsColumnId[] {
  return availableItemsColumns(allCompanies)
    .filter((c) => c.defaultVisible)
    .map((c) => c.id);
}

/** Re-order an arbitrary id collection into canonical registry order (dedups + drops unknown). */
export function orderItemsColumns(ids: Iterable<ItemsColumnId>): ItemsColumnId[] {
  const wanted = new Set<ItemsColumnId>();
  for (const id of ids) {
    if (KNOWN_COLUMN_IDS.has(id)) wanted.add(id);
  }
  return ITEMS_COLUMN_REGISTRY.filter((c) => wanted.has(c.id)).map((c) => c.id);
}

/**
 * Read persisted visible columns, falling back to defaults on missing/invalid storage.
 * SSR-safe (returns defaults when `window` is unavailable).
 */
export function readVisibleItemsColumns(allCompanies: boolean): ItemsColumnId[] {
  const fallback = defaultVisibleItemsColumns(allCompanies);
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(ITEMS_COLUMNS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const valid = parsed.filter(
      (x): x is ItemsColumnId => typeof x === "string" && KNOWN_COLUMN_IDS.has(x as ItemsColumnId),
    );
    if (valid.length === 0) return fallback;
    return orderItemsColumns(valid);
  } catch {
    return fallback;
  }
}

/** Persist visible columns (canonical order). No-op on SSR / storage errors. */
export function writeVisibleItemsColumns(ids: Iterable<ItemsColumnId>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      ITEMS_COLUMNS_STORAGE_KEY,
      JSON.stringify(orderItemsColumns(ids)),
    );
  } catch {
    /* ignore quota / disabled storage */
  }
}
