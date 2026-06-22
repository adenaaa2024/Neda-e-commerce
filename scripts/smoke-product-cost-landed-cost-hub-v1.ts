/**
 * Smoke — pure, no-DB checks for the landed-cost contract.
 *   npx tsx scripts/smoke-product-cost-landed-cost-hub-v1.ts
 */
import {
  COST_CSV_FORBIDDEN_COLUMNS,
  COST_CSV_HEADER_LINE,
  COST_CSV_TEMPLATE_COLUMNS,
  COST_MODEL_FIELDS,
  LANDED_COST_COMPONENT_KEYS,
  PRODUCT_COST_SOURCE_TYPES,
  computeLandedCostUnit,
  requiredCostCsvColumns,
  selectCostForEventDate,
  validateLandedCostRecord,
} from "../lib/products/contracts/product-cost-landed-cost-hub-v1";

let pass = 0;
let fail = 0;
function check(cond: boolean, msg: string): void {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL: ${msg}`);
  }
}

// ---- landed cost summation ----
check(
  computeLandedCostUnit({ purchase_cost_unit: 7.25, freight_to_warehouse_unit: 1.1, prep_labeling_unit: 0.5 }) === 8.85,
  "landed = sum of approved components (7.25+1.1+0.5=8.85)",
);
check(computeLandedCostUnit({}) === null, "no components → null (UNKNOWN), not 0");
check(computeLandedCostUnit({ purchase_cost_unit: null }) === null, "all-null components → null");
check(computeLandedCostUnit({ purchase_cost_unit: 5, other_cost_unit: -3 }) === 5, "negative component ignored in sum (validation flags it)");
check(LANDED_COST_COMPONENT_KEYS.length === 7, "exactly 7 landed-cost components");
check(COST_MODEL_FIELDS.components.length === 7, "model exposes 7 components");

// ---- validation ----
const good = validateLandedCostRecord({ fnsku: "X004N992LN", purchase_cost_unit: 7.25, currency: "USD", effective_from: "2026-01-01" });
check(good.ok && good.landed_cost_unit === 7.25, "valid single-component record passes");

const noId = validateLandedCostRecord({ purchase_cost_unit: 5, currency: "USD", effective_from: "2026-01-01" });
check(!noId.ok && noId.issues.some((i) => i.code === "no_identifier"), "missing identifier → error");

const zeroOnly = validateLandedCostRecord({ sku: "A", currency: "USD", effective_from: "2026-01-01" });
check(!zeroOnly.ok && zeroOnly.issues.some((i) => i.code === "all_components_missing"), "no components → error (never 0)");

const inverted = validateLandedCostRecord({ sku: "A", purchase_cost_unit: 1, currency: "USD", effective_from: "2026-06-01", effective_to: "2026-01-01" });
check(!inverted.ok && inverted.issues.some((i) => i.code === "effective_range_inverted"), "effective_to before effective_from → error");

const salePrice = validateLandedCostRecord({ sku: "A", purchase_cost_unit: 19.99, currency: "USD", effective_from: "2026-01-01", latest_sale_price: 19.99 });
check(salePrice.ok && salePrice.issues.some((i) => i.code === "looks_like_sale_price" && i.severity === "warning"), "cost == sale price → warning (not hard error)");

const negative = validateLandedCostRecord({ sku: "A", purchase_cost_unit: -1, currency: "USD", effective_from: "2026-01-01" });
check(!negative.ok && negative.issues.some((i) => i.code === "component_negative"), "negative component → error");

// ---- effective-date selection ----
const records = [
  { effective_from: "2025-01-01", effective_to: "2025-12-31" },
  { effective_from: "2026-01-01", effective_to: null },
];
check(selectCostForEventDate(records, "2025-06-15") === records[0], "event in 2025 → first record");
check(selectCostForEventDate(records, "2026-06-15") === records[1], "event in 2026 → open-ended record");
check(selectCostForEventDate(records, "2024-01-01") === null, "event before any window → UNKNOWN (null)");

// ---- CSV template ----
check(COST_CSV_TEMPLATE_COLUMNS.length === 13, "CSV template has 13 columns");
check(requiredCostCsvColumns().join(",") === "purchase_cost_unit,effective_from", "required CSV cols = purchase_cost_unit, effective_from");
check(
  LANDED_COST_COMPONENT_KEYS.every((k) => COST_CSV_TEMPLATE_COLUMNS.some((c) => c.column === k)),
  "every landed component is a CSV column",
);
check(COST_CSV_HEADER_LINE.startsWith("sku,fnsku,asin,purchase_cost_unit"), "CSV header order matches spec");
check(
  COST_CSV_FORBIDDEN_COLUMNS.includes("sale_price") && COST_CSV_FORBIDDEN_COLUMNS.includes("claim_amount"),
  "forbidden CSV columns include sale_price + claim_amount",
);

// ---- source types ----
check(
  PRODUCT_COST_SOURCE_TYPES.join(",") === "manual,csv_import,api,calculated",
  "source_type enum = manual|csv_import|api|calculated",
);

console.log(`\nsmoke-product-cost-landed-cost-hub-v1: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
