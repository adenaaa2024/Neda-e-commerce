/**
 * Phase 1 — Returns & Logistics "Saved Report Views" foundation.
 *
 * Pure UI/presentation persistence. No backend, no DB schema, no data logic, no
 * cross-user sharing. A saved view captures the *active* report tab plus that
 * tab's primary filters, advanced filters, and visible column layout so the user
 * can re-apply a named report configuration later.
 *
 * Persistence is browser-local only, under `returns.report.savedViews`.
 * Invalid/corrupt storage is ignored and treated as an empty list.
 */

export type ReturnsReportTab = "items" | "packages" | "pallets";

/**
 * Tab-agnostic snapshot of a report configuration.
 *
 * `filters` is a flat map keyed by the table's internal filter-field name (both
 * primary and advanced filters), with string values ("" means "no filter").
 * `columns` is the ordered list of visible column ids for the tab.
 */
export type ReturnsReportViewSnapshot = {
  filters: Record<string, string>;
  columns: string[];
};

export type ReturnsReportSavedView = {
  id: string;
  name: string;
  tab: ReturnsReportTab;
  /** ISO timestamp — used only for stable ordering / display. */
  createdAt: string;
  snapshot: ReturnsReportViewSnapshot;
};

/**
 * A request to apply a saved view to a specific tab. Passed down to the data
 * tables; the matching tab consumes it once and reports back via a callback.
 */
export type AppliedReturnsView = {
  tab: ReturnsReportTab;
  snapshot: ReturnsReportViewSnapshot;
};

export const RETURNS_SAVED_VIEWS_STORAGE_KEY = "returns.report.savedViews";

export function isReturnsReportTab(value: unknown): value is ReturnsReportTab {
  return value === "items" || value === "packages" || value === "pallets";
}

function sanitizeSnapshot(value: unknown): ReturnsReportViewSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;

  const filters: Record<string, string> = {};
  if (obj.filters && typeof obj.filters === "object") {
    for (const [k, v] of Object.entries(obj.filters as Record<string, unknown>)) {
      if (typeof v === "string") filters[k] = v;
    }
  }

  const columns: string[] = Array.isArray(obj.columns)
    ? obj.columns.filter((c): c is string => typeof c === "string")
    : [];

  return { filters, columns };
}

function sanitizeView(value: unknown): ReturnsReportSavedView | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== "string" || !obj.id) return null;
  if (typeof obj.name !== "string" || !obj.name.trim()) return null;
  if (!isReturnsReportTab(obj.tab)) return null;
  const snapshot = sanitizeSnapshot(obj.snapshot);
  if (!snapshot) return null;
  const createdAt =
    typeof obj.createdAt === "string" && obj.createdAt ? obj.createdAt : new Date(0).toISOString();
  return { id: obj.id, name: obj.name, tab: obj.tab, createdAt, snapshot };
}

/** Read all saved views. SSR-safe; returns [] on missing/invalid/disabled storage. */
export function readSavedViews(): ReturnsReportSavedView[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RETURNS_SAVED_VIEWS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(sanitizeView)
      .filter((v): v is ReturnsReportSavedView => v !== null);
  } catch {
    return [];
  }
}

/** Persist the full list of saved views. No-op on SSR / storage errors. */
export function writeSavedViews(views: ReturnsReportSavedView[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RETURNS_SAVED_VIEWS_STORAGE_KEY, JSON.stringify(views));
  } catch {
    /* ignore quota / disabled storage */
  }
}

/** Stable id for a freshly created view. */
export function makeSavedViewId(): string {
  return `view_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Append (or replace by same tab+name) a saved view and persist.
 * Returns the updated list so callers can update React state in one step.
 */
export function addSavedView(
  view: ReturnsReportSavedView,
  existing: ReturnsReportSavedView[] = readSavedViews(),
): ReturnsReportSavedView[] {
  const name = view.name.trim();
  const deduped = existing.filter(
    (v) => !(v.tab === view.tab && v.name.trim().toLowerCase() === name.toLowerCase()),
  );
  const next = [...deduped, { ...view, name }];
  writeSavedViews(next);
  return next;
}

/** Delete a saved view by id and persist. Returns the updated list. */
export function deleteSavedView(
  id: string,
  existing: ReturnsReportSavedView[] = readSavedViews(),
): ReturnsReportSavedView[] {
  const next = existing.filter((v) => v.id !== id);
  writeSavedViews(next);
  return next;
}
