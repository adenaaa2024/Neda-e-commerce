/**
 * PIM product lifecycle status — aligned with Product Master import and catalog UI.
 */

export const PIM_PRODUCT_STATUSES = ["active", "inactive", "draft", "discontinued", "needs_review"] as const;

export type PimProductStatus = (typeof PIM_PRODUCT_STATUSES)[number];

const ALIASES: Record<string, PimProductStatus> = {
  "": "active",
  enabled: "active",
  live: "active",
  disabled: "inactive",
  archived: "inactive",
  active: "active",
  inactive: "inactive",
  draft: "draft",
  discontinued: "discontinued",
  needs_review: "needs_review",
};

export function normalizePimProductStatus(raw: string | null | undefined): PimProductStatus {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!s) return "active";
  if ((PIM_PRODUCT_STATUSES as readonly string[]).includes(s)) return s as PimProductStatus;
  const mapped = ALIASES[s];
  if (mapped) return mapped;
  return "needs_review";
}

export function mergePimProductAttributesMetadata(
  existingMetadata: unknown,
  incoming: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const base =
    existingMetadata && typeof existingMetadata === "object" && !Array.isArray(existingMetadata)
      ? { ...(existingMetadata as Record<string, unknown>) }
      : {};
  const prev =
    base.product_attributes && typeof base.product_attributes === "object" && !Array.isArray(base.product_attributes)
      ? { ...(base.product_attributes as Record<string, unknown>) }
      : {};
  const next = { ...prev };
  if (incoming && typeof incoming === "object") {
    for (const [k, v] of Object.entries(incoming)) {
      const key = String(k).trim();
      if (!key) continue;
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && !v.trim()) continue;
      next[key] = typeof v === "string" ? v.trim() : v;
    }
  }
  base.product_attributes = next;
  return base;
}
