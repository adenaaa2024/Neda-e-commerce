/**
 * Shared COGS override value extraction — supports legacy number map and rich record objects.
 */

export type CogsOverrideRecordV1 = {
  identifier_type: "FNSKU" | "SKU" | "ASIN" | "resolved_product_id";
  identifier_value: string;
  unit_cost: number;
  currency: string;
  effective_date: string;
  source_note: string;
  source_type: "manual_override" | string;
  approved_by: string;
  approved_at: string;
  run_id: string;
  pilot_case_run_id?: string;
  intake_run_id?: string;
  sale_price_review_confirmed?: boolean;
};

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Extract positive unit cost from legacy number or rich override record. */
export function extractCogsOverrideUnitCost(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") {
    return v > 0 ? v : null;
  }
  if (typeof v === "string") {
    const n = num(v);
    return n != null && n > 0 ? n : null;
  }
  if (typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const fromUnit = num(o.unit_cost ?? o.unitCost);
    if (fromUnit != null && fromUnit > 0) return fromUnit;
  }
  return null;
}

export function isCogsOverrideRecord(v: unknown): v is CogsOverrideRecordV1 {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return extractCogsOverrideUnitCost(o) != null;
}
