/**
 * Item-scan unit modal: allowed discrepancy tag keys persisted on `return_items.conditions`.
 * Box-level issues (empty box, damaged box) are excluded — handled in BOX intake wizard.
 */

export const ITEM_UNIT_SELLABLE_OK_TAG = "sellable_ok" as const;

export const ITEM_UNIT_DAMAGE_TAG_KEYS = [
  "damaged_product",
  "scratched",
  "wrong_item",
  "expired",
  "missing_parts",
  "missing_item",
] as const;

export type ItemUnitDamageTagKey = (typeof ITEM_UNIT_DAMAGE_TAG_KEYS)[number];

export type ItemUnitDiscrepancyTagKey = ItemUnitDamageTagKey | typeof ITEM_UNIT_SELLABLE_OK_TAG;

const ALLOWED = new Set<string>([...ITEM_UNIT_DAMAGE_TAG_KEYS, ITEM_UNIT_SELLABLE_OK_TAG]);

/** Perishable / grocery heuristic when catalog has no `expiration_supported` flag. */
const PERISHABLE_DESC_RX =
  /\b(grocery|groceries|perishable|refrigerat|frozen food|frozen|fresh\b|dairy|produce|meat|seafood|deli|vitamin|supplement|protein powder|baby formula|formula\b|organic food|snack foods?|beverage|juice|milk\b|cheese\b|yogurt)\b/i;

export function inferPerishableCategoryFromDescription(description: string | null | undefined): boolean {
  const s = String(description ?? "").trim();
  if (!s) return false;
  return PERISHABLE_DESC_RX.test(s);
}

export function filterPackageItemDiscrepancyTags(raw: unknown): ItemUnitDiscrepancyTagKey[] {
  if (!Array.isArray(raw)) return [];
  const out: ItemUnitDiscrepancyTagKey[] = [];
  for (const x of raw) {
    const k = String(x ?? "").trim();
    if (ALLOWED.has(k) && !out.includes(k as ItemUnitDiscrepancyTagKey)) {
      out.push(k as ItemUnitDiscrepancyTagKey);
    }
  }
  return out;
}

export function normalizeItemUnitDiscrepancySelection(tags: ItemUnitDiscrepancyTagKey[]): ItemUnitDiscrepancyTagKey[] {
  const filtered = filterPackageItemDiscrepancyTags(tags);
  if (filtered.includes(ITEM_UNIT_SELLABLE_OK_TAG)) {
    return [ITEM_UNIT_SELLABLE_OK_TAG];
  }
  return filtered;
}

export function packageItemDamageTagsSelected(tags: ItemUnitDiscrepancyTagKey[]): boolean {
  return tags.some((t) => t !== ITEM_UNIT_SELLABLE_OK_TAG);
}

/** Issue evidence required when any non-OK discrepancy is selected. */
export function packageItemRequiresEvidencePhotos(tags: ItemUnitDiscrepancyTagKey[]): boolean {
  return packageItemDamageTagsSelected(tags);
}

/** Expiration + batch/lot UI required when Expired is tagged or description looks perishable/grocery. */
export function packageItemRequiresExpiryBlock(args: {
  tags: ItemUnitDiscrepancyTagKey[];
  slipDescription: string | null | undefined;
}): boolean {
  if (args.tags.includes("expired")) return true;
  return inferPerishableCategoryFromDescription(args.slipDescription);
}
