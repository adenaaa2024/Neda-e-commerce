/**
 * PHASE-PRODUCT-COST-LANDED-COST-HUB-AUDIT-AND-UI-V1 — canonical landed-cost model + Hub plan.
 *
 * Pure, client-safe contract (no DB, no I/O, no AI). Extends the single-`unit_cost` COGS spine
 * (`product-cost-manual-input-placeholder-contract-v1` / `product-cogs-manual-entry-or-import-plan-v1`)
 * into a full LANDED-COST COMPONENT model so internal profit/loss can use real purchase/landed cost
 * while the Amazon claim amount stays on its own policy lane (latest_sale_net where policy says so).
 *
 * HARD SEPARATION:
 *   - Amazon claim amount  = its own policy lane (latest_sale_net / cogs_recovery per family policy).
 *   - Internal P&L         = landed_cost_unit (sum of approved components) — NEVER an Amazon claim amount
 *                            unless a family policy explicitly says cost is the claim basis.
 *   - Missing cost         = UNKNOWN (never 0, never sale price) and a blocker for INTERNAL P&L ONLY,
 *                            not a filing blocker unless the family policy requires cost.
 */

export const PRODUCT_COST_LANDED_COST_HUB_V1_VERSION =
  "product-cost-landed-cost-hub-v1" as const;

export const ORIGINAL_REF = "kxsvedvpjldygtdbylsy" as const;

// ---------------------------------------------------------------------------
// PART B — canonical cost model
// ---------------------------------------------------------------------------

/** Per-unit landed-cost components that sum into landed_cost_unit. */
export const LANDED_COST_COMPONENT_KEYS = [
  "purchase_cost_unit",
  "freight_to_warehouse_unit",
  "warehouse_handling_unit",
  "prep_labeling_unit",
  "shipping_to_amazon_unit",
  "storage_or_holding_unit",
  "other_cost_unit",
] as const;

export type LandedCostComponentKey = (typeof LANDED_COST_COMPONENT_KEYS)[number];

/** How a cost record was produced. */
export type ProductCostSourceType = "manual" | "csv_import" | "api" | "calculated";
export const PRODUCT_COST_SOURCE_TYPES: ProductCostSourceType[] = [
  "manual",
  "csv_import",
  "api",
  "calculated",
];

/** Operator-attested confidence in the cost figure. */
export type ProductCostConfidence = "high" | "medium" | "low";
export const PRODUCT_COST_CONFIDENCE_VALUES: ProductCostConfidence[] = ["high", "medium", "low"];

/** Canonical cost record — the unit of storage + history. */
export type ProductLandedCostRecord = {
  // identity / linkage (product_id is the resolved target; sku/fnsku/asin are the import keys)
  product_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  // per-unit components (any may be null = not provided; never 0-as-unknown)
  purchase_cost_unit: number | null;
  freight_to_warehouse_unit: number | null;
  warehouse_handling_unit: number | null;
  prep_labeling_unit: number | null;
  shipping_to_amazon_unit: number | null;
  storage_or_holding_unit: number | null;
  other_cost_unit: number | null;
  // derived
  landed_cost_unit: number | null;
  // money + effective-date awareness + provenance
  currency: string;
  effective_from: string; // YYYY-MM-DD (inclusive)
  effective_to: string | null; // null = open-ended (current)
  source_type: ProductCostSourceType;
  confidence: ProductCostConfidence;
  notes: string | null;
  created_by: string | null;
  approved_by: string | null;
};

/** Canonical field catalog (used by the audit output + UI + CSV). */
export const COST_MODEL_FIELDS = {
  identity: ["product_id", "sku", "fnsku", "asin", "supplier_id", "supplier_name"],
  components: [...LANDED_COST_COMPONENT_KEYS],
  derived: ["landed_cost_unit"],
  money_and_provenance: [
    "currency",
    "effective_from",
    "effective_to",
    "source_type",
    "confidence",
    "notes",
    "created_by",
    "approved_by",
  ],
} as const;

export const COST_MODEL_RULES = [
  "landed_cost_unit = SUM(approved non-null components) — null only when ALL components are null",
  "Never use cost as the Amazon claim amount unless the family policy explicitly says cost is the claim basis",
  "Cost feeds internal profit/loss only; Amazon claim amount stays on latest_sale_net / family-policy lane",
  "Cost is effective-date aware: pick the record whose [effective_from, effective_to] contains the claim event date",
  "If no valid cost exists for the claim event date: landed_cost_unit = UNKNOWN (never 0, never sale price)",
  "Missing cost is an INTERNAL P&L blocker only — not a filing blocker unless family policy requires cost",
  "Never derive cost from product_prices.amount, sale price, settlement net, or reimbursement",
  "Never infer cost from SKU/title; never auto-create products from a cost import",
] as const;

/**
 * Sum the approved per-unit components into landed_cost_unit.
 * Returns null only when every component is null (fully unknown). Rounded to 4dp.
 */
export function computeLandedCostUnit(
  components: Partial<Record<LandedCostComponentKey, number | null>>,
): number | null {
  let sum = 0;
  let any = false;
  for (const key of LANDED_COST_COMPONENT_KEYS) {
    const v = components[key];
    if (v == null) continue;
    if (!Number.isFinite(v) || v < 0) continue; // ignore invalid; validation reports it separately
    sum += v;
    any = true;
  }
  if (!any) return null;
  return Math.round(sum * 10000) / 10000;
}

export type CostValidationIssue = {
  field: string;
  code:
    | "component_negative"
    | "component_not_finite"
    | "all_components_missing"
    | "currency_missing"
    | "effective_from_missing"
    | "effective_range_inverted"
    | "no_identifier"
    | "looks_like_sale_price";
  severity: "error" | "warning";
  message: string;
};

/** Pure validation for a single cost record (manual entry or one CSV row). */
export function validateLandedCostRecord(
  rec: Partial<ProductLandedCostRecord> & { latest_sale_price?: number | null },
): { ok: boolean; issues: CostValidationIssue[]; landed_cost_unit: number | null } {
  const issues: CostValidationIssue[] = [];

  for (const key of LANDED_COST_COMPONENT_KEYS) {
    const v = rec[key];
    if (v == null) continue;
    if (!Number.isFinite(v)) {
      issues.push({ field: key, code: "component_not_finite", severity: "error", message: `${key} must be a finite number` });
    } else if (v < 0) {
      issues.push({ field: key, code: "component_negative", severity: "error", message: `${key} cannot be negative (use blank for unknown, never 0)` });
    }
  }

  const landed = computeLandedCostUnit(rec);
  if (landed == null) {
    issues.push({ field: "components", code: "all_components_missing", severity: "error", message: "At least one cost component is required; blank = UNKNOWN, never 0" });
  }
  if (!rec.currency) {
    issues.push({ field: "currency", code: "currency_missing", severity: "error", message: "currency is required (default USD)" });
  }
  if (!rec.effective_from) {
    issues.push({ field: "effective_from", code: "effective_from_missing", severity: "error", message: "effective_from (YYYY-MM-DD) is required" });
  }
  if (rec.effective_from && rec.effective_to && rec.effective_to < rec.effective_from) {
    issues.push({ field: "effective_to", code: "effective_range_inverted", severity: "error", message: "effective_to must be on/after effective_from" });
  }
  if (!rec.product_id && !rec.sku && !rec.fnsku && !rec.asin) {
    issues.push({ field: "identifier", code: "no_identifier", severity: "error", message: "At least one of product_id/sku/fnsku/asin is required to resolve the product" });
  }
  if (
    landed != null &&
    rec.latest_sale_price != null &&
    Math.round(landed * 100) === Math.round(rec.latest_sale_price * 100)
  ) {
    issues.push({ field: "landed_cost_unit", code: "looks_like_sale_price", severity: "warning", message: "Landed cost equals latest sale price — confirm this is cost, not sale price" });
  }

  return { ok: issues.every((i) => i.severity !== "error"), issues, landed_cost_unit: landed };
}

/**
 * Effective-date-aware selection: pick the cost record whose [effective_from, effective_to]
 * window contains eventDate (YYYY-MM-DD). Ties broken by latest effective_from. Returns null
 * (UNKNOWN) when no record covers the date.
 */
export function selectCostForEventDate<T extends { effective_from: string; effective_to: string | null }>(
  records: T[],
  eventDate: string,
): T | null {
  const covering = records.filter(
    (r) => r.effective_from <= eventDate && (r.effective_to == null || r.effective_to >= eventDate),
  );
  if (covering.length === 0) return null;
  return covering.reduce((best, r) => (r.effective_from > best.effective_from ? r : best));
}

// ---------------------------------------------------------------------------
// PART C — reuse-first schema recommendation (no execution)
// ---------------------------------------------------------------------------

export const SCHEMA_REUSE_ASSESSMENT = {
  reuse_possible: "partial",
  reuse_now: [
    "products.vendor_id + products.vendor_name + vendors (117 rows) → supplier/vendor linkage (no new vendor table)",
    "product_identifier_map (16,849) → resolve sku/fnsku/asin → product_id (no title match, no auto-create)",
    "claim_candidates.cogs_unit → keep as point-in-time intake snapshot (never retro-mutated by cost edits)",
    "Existing precedence + profit/loss + COGS UI route (/claim-center/reimbursement-tracking/cogs) → extend, do not replace",
    "Interim workspace_settings.module_configs.claim_intake.cogs_overrides → immediate manual entry with NO migration",
  ],
  cannot_reuse: [
    "products.metadata.product_attributes.{case_cost,selling_unit_cost,*_without_freight} — ungoverned, no effective date, no source_type, mixed with selling price (read-only re-parse to PROPOSE costs only)",
    "product_prices (29,571, 100% product_master_import) — sale/list cache lane, never cost",
    "product_cost_snapshots — single unit_cost only, and NOT applied to live (migration is gated DRAFT)",
  ],
  missing_entirely: [
    "Landed-cost component storage (purchase/freight/handling/prep/shipping/storage/other)",
    "Effective-date history (effective_from/effective_to)",
    "source_type / confidence / approval columns on a governed cost spine",
  ],
} as const;

/**
 * Recommended PROPOSED migration — EXTEND the existing (unapplied) product_cost_snapshots draft
 * into a landed-cost spine. Single denormalized row per product+store+effective_from with all
 * component columns + derived landed_cost_unit + history + provenance. DO NOT EXECUTE.
 */
export const PROPOSED_MIGRATION = {
  execute: false,
  approval_required: true,
  approval_token: "APPROVED_PRODUCT_LANDED_COST_HUB_SCHEMA_V1=yes",
  approval_file: ".cursor/operator-approvals/product-landed-cost-hub-schema-v1-approval.md",
  strategy:
    "Extend the gated product_cost_snapshots draft (20260618120000_*.sql) into a landed-cost spine BEFORE it is ever applied — net-new table, additive to a draft, zero impact on live data.",
  table: "product_cost_snapshots",
  additive_columns_over_draft: [
    "purchase_cost_unit       NUMERIC(14,4)",
    "freight_to_warehouse_unit NUMERIC(14,4)",
    "warehouse_handling_unit  NUMERIC(14,4)",
    "prep_labeling_unit       NUMERIC(14,4)",
    "shipping_to_amazon_unit  NUMERIC(14,4)",
    "storage_or_holding_unit  NUMERIC(14,4)",
    "other_cost_unit          NUMERIC(14,4)",
    "landed_cost_unit         NUMERIC(14,4)  -- derived = SUM(approved components); kept for query/index",
    "supplier_id              UUID REFERENCES public.vendors(id) ON DELETE SET NULL",
    "effective_from           DATE NOT NULL",
    "effective_to             DATE            -- null = current/open-ended",
    "source_type              TEXT NOT NULL DEFAULT 'manual'  -- manual|csv_import|api|calculated",
    "confidence               TEXT NOT NULL DEFAULT 'medium'  -- high|medium|low",
    "created_by               UUID REFERENCES public.profiles(id) ON DELETE SET NULL",
    "-- existing draft already has: unit_cost, currency, effective_at, source_code, source_note, approved_by, approved_at, identifier_type, identifier_value, import_session_id, created_at, updated_at, deleted_at",
  ],
  compatibility_note:
    "Keep legacy unit_cost on the table for back-compat (= landed_cost_unit when only one cost was entered). New readers prefer landed_cost_unit.",
  indexes: [
    "(organization_id, product_id, effective_from DESC) WHERE deleted_at IS NULL",
    "(organization_id, store_id, effective_from DESC) WHERE deleted_at IS NULL",
  ],
  rls: "organization_id scoped — mirror products / product_prices RLS pattern",
  soft_delete: "deleted_at + audit_logs trigger; never hard-delete cost rows",
  alternative_normalized: {
    note: "If components must be independently audited/sourced, add a child product_cost_components(snapshot_id, component_key, amount, source_type) table. Denormalized single-row is recommended for v1 simplicity.",
  },
} as const;

export const INTERIM_NO_MIGRATION_PATH = {
  storage: "workspace_settings.module_configs.claim_intake.cost_overrides[fnsku|sku|asin]",
  supports:
    "Immediate manual landed-cost entry (component map + effective_from + source_type=manual) with audit via settings change log — no new table, no approval needed for interim JSONB",
  limitation: "No first-class history/index; migrate to product_cost_snapshots once approved (< 500 overrides guidance)",
} as const;

// ---------------------------------------------------------------------------
// PART D — Product Cost Hub UI plan
// ---------------------------------------------------------------------------

export const COST_HUB_UI_PLAN = {
  recommended_route: "/claim-center/financial/product-costs",
  rationale:
    "Reuse the existing Claim Center Financial nav + COGS panel (/claim-center/reimbursement-tracking/cogs); promote it to a first-class 'Product Costs' hub under Claim Center / Rules. A mirror entry under Product / Cost Hub can deep-link to the same view.",
  alternate_routes: ["/products/cost-hub", "Claim Center / Rules / Product Costs"],
  capabilities: [
    "Search by SKU / FNSKU / ASIN (resolve via product_identifier_map)",
    "Manual cost entry with the 7 component fields + currency + effective_from + source_type + confidence + notes + approved_by",
    "CSV import with dry-run preview (identifier resolution + landed_cost_unit per row + blockers)",
    "Cost history per product (effective-dated rows, current vs superseded, soft-deleted hidden)",
    "Component breakdown panel (purchase/freight/handling/prep/shipping/storage/other → landed_cost_unit)",
    "Effective dates (effective_from / effective_to) with overlap warnings",
    "Approval status badge (approved_by / source_type / confidence)",
    "Warnings for missing cost (UNKNOWN — internal P&L blocker only)",
  ],
  reuse_components: [
    "ProductCogsManualEntryView (extend single unit_cost → 7-component form)",
    "ClaimCenterFinancialNav",
    "money-lane V2 profit/loss view (cost_recovery_view + profit_loss_view)",
  ],
  permissions: [
    "canEditPlatformProductSettings OR claim intake policy edit role for manual save",
    "separate cost_import_apply permission for CSV apply",
    "read-only viewers see lineage/history but cannot save",
  ],
} as const;

export const READY_TO_FILE_COST_DISPLAY_PLAN = {
  card_title: "Financial breakdown",
  rows: [
    { label: "Amazon Claim Amount", source: "family-policy lane (latest_sale_net where policy says so)", tone: "primary", never: "never the landed cost unless family policy says cost is the claim basis" },
    { label: "Internal Cost / Landed Cost", source: "landed_cost_unit × clean_quantity (effective-date matched)", tone: "info", unknown_behavior: "show UNKNOWN when no cost covers the event date" },
    { label: "Profit / Loss impact", source: "(latest_sold_price − amazon_fees_per_unit − landed_cost_unit) × clean_quantity", tone: "neutral", unknown_behavior: "UNKNOWN when any input UNKNOWN — never coerced to 0" },
  ],
  separation_rule:
    "Amazon Claim Amount and Internal Cost/Profit-Loss are always rendered as distinct rows with distinct sources; the cost rows are explicitly labeled 'internal — not the claim amount'.",
} as const;

export const PRODUCT_STORY_COST_TIMELINE_PLAN = {
  section_title: "Cost timeline",
  shows: [
    "Effective-dated landed-cost records (effective_from → effective_to) with component breakdown on expand",
    "Source type + confidence + approved_by per record",
    "Which record was effective on each claim event date (the one selectCostForEventDate picks)",
    "Gaps: dates with NO covering cost → UNKNOWN marker (internal P&L only)",
  ],
  separation_rule: "Cost timeline is an internal P&L lane; it never alters the Amazon claim amount lane.",
} as const;

export const NEEDS_DATA_COST_BLOCKER_PLAN = {
  group: "missing_cost_internal_pnl",
  behavior:
    "Missing cost surfaces as an INTERNAL P&L blocker (cannot compute profit/loss) — it does NOT block filing unless the family policy lists cost as the claim basis (families_using_cogs).",
  filing_blocker_only_when: "family policy amount_basis = cogs_recovery (cost-based claim families)",
} as const;

// ---------------------------------------------------------------------------
// PART E — CSV import template
// ---------------------------------------------------------------------------

export const COST_CSV_TEMPLATE_COLUMNS = [
  { column: "sku", required: false, type: "string", notes: "One of sku/fnsku/asin required; resolved via product_identifier_map" },
  { column: "fnsku", required: false, type: "string", notes: "Preferred identifier; normalized uppercase" },
  { column: "asin", required: false, type: "string", notes: "Optional identifier" },
  { column: "purchase_cost_unit", required: true, type: "decimal", notes: "Per-unit purchase cost (blank = unknown, never 0)" },
  { column: "freight_to_warehouse_unit", required: false, type: "decimal" },
  { column: "warehouse_handling_unit", required: false, type: "decimal" },
  { column: "prep_labeling_unit", required: false, type: "decimal" },
  { column: "shipping_to_amazon_unit", required: false, type: "decimal" },
  { column: "storage_or_holding_unit", required: false, type: "decimal" },
  { column: "other_cost_unit", required: false, type: "decimal" },
  { column: "currency", required: false, type: "string", notes: "Default USD" },
  { column: "effective_from", required: true, type: "date", notes: "YYYY-MM-DD" },
  { column: "notes", required: false, type: "string", notes: "Vendor invoice #, source note (max 500)" },
] as const;

export const COST_CSV_OPTIONAL_EXTRA_COLUMNS = [
  { column: "supplier_name", notes: "Display/link to vendors.name; never auto-creates a vendor" },
  { column: "effective_to", notes: "Optional explicit window end; otherwise open-ended until next record" },
] as const;

export const COST_CSV_FORBIDDEN_COLUMNS = [
  "sale_price",
  "list_price",
  "amazon_price",
  "product_prices.amount",
  "unit_sale_price",
  "recovery_value",
  "claim_amount",
] as const;

export const COST_CSV_HEADER_LINE = COST_CSV_TEMPLATE_COLUMNS.map((c) => c.column).join(",");

export function requiredCostCsvColumns(): string[] {
  return COST_CSV_TEMPLATE_COLUMNS.filter((c) => c.required).map((c) => c.column);
}

// ---------------------------------------------------------------------------
// Output flag helpers (consumed by the audit script)
// ---------------------------------------------------------------------------

export const COST_HUB_SAFE_FLAGS = {
  cost_model_reuse_possible: "partial",
  additive_migration_needed: "yes",
  new_table_needed: "yes_gated", // product_cost_snapshots not yet applied; landed components need columns
  manual_entry_supported: "yes_interim_via_cost_overrides_then_snapshots",
  csv_import_supported: "yes_dry_run_now_apply_after_approval",
  approval_required: "yes",
  SAFE_PRODUCT_COST_HUB_ARCHITECTURE_READY: "yes",
  SAFE_TO_IMPLEMENT_PRODUCT_COST_HUB: "conditional_yes_interim_no_migration_or_after_APPROVED_PRODUCT_LANDED_COST_HUB_SCHEMA_V1",
} as const;
