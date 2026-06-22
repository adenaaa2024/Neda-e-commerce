/**
 * Phase 1 — Returns & Logistics "Boxes" tab column registry + view-settings persistence.
 *
 * Pure UI/presentation config. No backend, no DB schema, no data logic.
 * Controls which Boxes-report columns are rendered (header + body). Hidden columns
 * are simply not rendered; sorting state is independent and is never mutated here.
 *
 * User choice persists in localStorage under `returns.boxes.visibleColumns`.
 * Invalid/corrupt storage falls back to the default visible set.
 */

export type BoxesColumnId =
  | "company"
  | "box_number"
  | "store"
  | "carrier_tracking"
  | "items"
  | "expected"
  | "scanned"
  | "missing"
  | "marked_missing"
  | "slip_review"
  | "status"
  | "last_operator"
  | "last_activity"
  | "operator"
  | "date";

export type BoxesColumnDef = {
  id: BoxesColumnId;
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
 * Ordered registry — order matches the Boxes table header/body column order so the
 * column manager and the rendered table stay aligned.
 */
export const BOXES_COLUMN_REGISTRY: readonly BoxesColumnDef[] = [
  { id: "company", label: "Company", defaultVisible: true, requiresAllCompanies: true },
  { id: "box_number", label: "Box #", defaultVisible: true },
  { id: "store", label: "Store", defaultVisible: true },
  { id: "carrier_tracking", label: "Carrier / Tracking", defaultVisible: true },
  { id: "items", label: "Items", defaultVisible: true },
  { id: "expected", label: "Expected", defaultVisible: true },
  { id: "scanned", label: "Scanned", defaultVisible: true },
  { id: "missing", label: "Missing", defaultVisible: true },
  { id: "marked_missing", label: "Marked Missing", defaultVisible: true },
  { id: "slip_review", label: "Slip Review", defaultVisible: true },
  { id: "status", label: "Status", defaultVisible: true },
  { id: "last_operator", label: "Last Operator", defaultVisible: true },
  { id: "last_activity", label: "Last Activity", defaultVisible: true },
  { id: "operator", label: "Operator", defaultVisible: false },
  { id: "date", label: "Date", defaultVisible: false },
] as const;

export const BOXES_COLUMNS_STORAGE_KEY = "returns.boxes.visibleColumns";

const KNOWN_COLUMN_IDS: ReadonlySet<BoxesColumnId> = new Set(
  BOXES_COLUMN_REGISTRY.map((c) => c.id),
);

/** Registry entries available in the current scope (drops all-companies-only columns when scoped). */
export function availableBoxesColumns(allCompanies: boolean): BoxesColumnDef[] {
  return BOXES_COLUMN_REGISTRY.filter((c) => !(c.requiresAllCompanies && !allCompanies));
}

/** Default visible column ids for the current scope. */
export function defaultVisibleBoxesColumns(allCompanies: boolean): BoxesColumnId[] {
  return availableBoxesColumns(allCompanies)
    .filter((c) => c.defaultVisible)
    .map((c) => c.id);
}

/** Re-order an arbitrary id collection into canonical registry order (dedups + drops unknown). */
export function orderBoxesColumns(ids: Iterable<BoxesColumnId>): BoxesColumnId[] {
  const wanted = new Set<BoxesColumnId>();
  for (const id of ids) {
    if (KNOWN_COLUMN_IDS.has(id)) wanted.add(id);
  }
  return BOXES_COLUMN_REGISTRY.filter((c) => wanted.has(c.id)).map((c) => c.id);
}

/**
 * Read persisted visible columns, falling back to defaults on missing/invalid storage.
 * SSR-safe (returns defaults when `window` is unavailable).
 */
export function readVisibleBoxesColumns(allCompanies: boolean): BoxesColumnId[] {
  const fallback = defaultVisibleBoxesColumns(allCompanies);
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(BOXES_COLUMNS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const valid = parsed.filter(
      (x): x is BoxesColumnId => typeof x === "string" && KNOWN_COLUMN_IDS.has(x as BoxesColumnId),
    );
    if (valid.length === 0) return fallback;
    return orderBoxesColumns(valid);
  } catch {
    return fallback;
  }
}

/** Persist visible columns (canonical order). No-op on SSR / storage errors. */
export function writeVisibleBoxesColumns(ids: Iterable<BoxesColumnId>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      BOXES_COLUMNS_STORAGE_KEY,
      JSON.stringify(orderBoxesColumns(ids)),
    );
  } catch {
    /* ignore quota / disabled storage */
  }
}
