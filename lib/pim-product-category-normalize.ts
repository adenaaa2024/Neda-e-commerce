/**
 * Normalize `public.product_categories` rows for PIM UI + APIs.
 * Supports canonical columns (`id`, `name`) and legacy / alternate shapes
 * (`category_id`, `category_name`, `label`).
 */

export type PimProductCategoryOption = {
  id: string;
  name: string;
  slug?: string | null;
  parent_id?: string | null;
  store_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  product_count?: number;
};

function firstNonEmptyString(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (c == null) continue;
    const s = String(c).trim();
    if (s) return s;
  }
  return "";
}

/** Resolve primary key from a PostgREST row. */
export function pimProductCategoryRowId(row: Record<string, unknown>): string {
  return firstNonEmptyString(row.id, row.category_id);
}

/** Resolve human-readable label for dropdowns. */
export function pimProductCategoryRowName(row: Record<string, unknown>): string {
  return firstNonEmptyString(row.name, row.category_name, row.label);
}

export function normalizePimProductCategoryRow(
  row: Record<string, unknown>,
  extras?: { product_count?: number },
): PimProductCategoryOption | null {
  const id = pimProductCategoryRowId(row);
  const name = pimProductCategoryRowName(row);
  if (!id || !name) return null;
  const slug = row.slug != null ? (String(row.slug).trim() || null) : null;
  const parentRaw = row.parent_id ?? row.parent_category_id;
  const parent_id =
    parentRaw != null && String(parentRaw).trim() && /^[0-9a-f-]{36}$/i.test(String(parentRaw).trim())
      ? String(parentRaw).trim()
      : null;
  const storeRaw = row.store_id;
  const store_id =
    storeRaw != null && String(storeRaw).trim() && /^[0-9a-f-]{36}$/i.test(String(storeRaw).trim())
      ? String(storeRaw).trim()
      : null;
  const out: PimProductCategoryOption = {
    id,
    name,
    slug,
    parent_id,
    store_id,
    created_at: row.created_at != null ? String(row.created_at) : null,
    updated_at: row.updated_at != null ? String(row.updated_at) : null,
  };
  if (typeof extras?.product_count === "number") out.product_count = extras.product_count;
  return out;
}

export function normalizePimProductCategoryRows(rows: unknown[]): PimProductCategoryOption[] {
  const out: PimProductCategoryOption[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const n = normalizePimProductCategoryRow(r as Record<string, unknown>);
    if (n) out.push(n);
  }
  return out;
}

/** When store-scoped rows exist, keep globals (null store) + matching store. */
export function filterPimProductCategoriesForStore(
  rows: Record<string, unknown>[],
  storeId: string | null,
): Record<string, unknown>[] {
  const sid = storeId?.trim() ?? "";
  if (!sid) return rows;
  const anyScoped = rows.some((r) => {
    const s = r.store_id;
    return s != null && String(s).trim() !== "";
  });
  if (!anyScoped) return rows;
  return rows.filter((r) => {
    const s = r.store_id;
    if (s == null || String(s).trim() === "") return true;
    return String(s).trim() === sid;
  });
}
