/**
 * Phase 1 — Returns & Logistics "Pallets" tab column registry + view-settings persistence.
 *
 * Pure UI/presentation config. No backend, no DB schema, no data logic.
 * Controls which Pallets-report columns are rendered (header + body). Hidden columns
 * are simply not rendered; sorting state is independent and is never mutated here.
 *
 * User choice persists in localStorage under `returns.pallets.visibleColumns`.
 * Invalid/corrupt storage falls back to the default visible set.
 */

export type PalletsColumnId =
  | "company"
  | "pallet_number"
  | "store"
  | "boxes_items"
  | "boxes_closed_total"
  | "expected"
  | "scanned"
  | "missing"
  | "issues"
  | "status"
  | "last_operator"
  | "last_activity"
  | "operator"
  | "date";

export type PalletsColumnDef = {
  id: PalletsColumnId;
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
 * Ordered registry — order matches the Pallets table header/body column order so the
 * column manager and the rendered table stay aligned.
 */
export const PALLETS_COLUMN_REGISTRY: readonly PalletsColumnDef[] = [
  { id: "company", label: "Company", defaultVisible: true, requiresAllCompanies: true },
  { id: "pallet_number", label: "Pallet #", defaultVisible: true },
  { id: "store", label: "Store", defaultVisible: true },
  { id: "boxes_items", label: "Boxes / Items", defaultVisible: true },
  { id: "boxes_closed_total", label: "Boxes (closed/total)", defaultVisible: true },
  { id: "expected", label: "Expected", defaultVisible: true },
  { id: "scanned", label: "Scanned", defaultVisible: true },
  { id: "missing", label: "Missing", defaultVisible: true },
  { id: "issues", label: "Issues", defaultVisible: true },
  { id: "status", label: "Status", defaultVisible: true },
  { id: "last_operator", label: "Last Operator", defaultVisible: true },
  { id: "last_activity", label: "Last Activity", defaultVisible: true },
  { id: "operator", label: "Operator", defaultVisible: false },
  { id: "date", label: "Date", defaultVisible: false },
] as const;

export const PALLETS_COLUMNS_STORAGE_KEY = "returns.pallets.visibleColumns";

const KNOWN_COLUMN_IDS: ReadonlySet<PalletsColumnId> = new Set(
  PALLETS_COLUMN_REGISTRY.map((c) => c.id),
);

/** Registry entries available in the current scope (drops all-companies-only columns when scoped). */
export function availablePalletsColumns(allCompanies: boolean): PalletsColumnDef[] {
  return PALLETS_COLUMN_REGISTRY.filter((c) => !(c.requiresAllCompanies && !allCompanies));
}

/** Default visible column ids for the current scope. */
export function defaultVisiblePalletsColumns(allCompanies: boolean): PalletsColumnId[] {
  return availablePalletsColumns(allCompanies)
    .filter((c) => c.defaultVisible)
    .map((c) => c.id);
}

/** Re-order an arbitrary id collection into canonical registry order (dedups + drops unknown). */
export function orderPalletsColumns(ids: Iterable<PalletsColumnId>): PalletsColumnId[] {
  const wanted = new Set<PalletsColumnId>();
  for (const id of ids) {
    if (KNOWN_COLUMN_IDS.has(id)) wanted.add(id);
  }
  return PALLETS_COLUMN_REGISTRY.filter((c) => wanted.has(c.id)).map((c) => c.id);
}

/**
 * Read persisted visible columns, falling back to defaults on missing/invalid storage.
 * SSR-safe (returns defaults when `window` is unavailable).
 */
export function readVisiblePalletsColumns(allCompanies: boolean): PalletsColumnId[] {
  const fallback = defaultVisiblePalletsColumns(allCompanies);
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(PALLETS_COLUMNS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const valid = parsed.filter(
      (x): x is PalletsColumnId => typeof x === "string" && KNOWN_COLUMN_IDS.has(x as PalletsColumnId),
    );
    if (valid.length === 0) return fallback;
    return orderPalletsColumns(valid);
  } catch {
    return fallback;
  }
}

/** Persist visible columns (canonical order). No-op on SSR / storage errors. */
export function writeVisiblePalletsColumns(ids: Iterable<PalletsColumnId>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      PALLETS_COLUMNS_STORAGE_KEY,
      JSON.stringify(orderPalletsColumns(ids)),
    );
  } catch {
    /* ignore quota / disabled storage */
  }
}
