/**
 * PHASE-PRODUCT-COST-MANUAL-INPUT-PLACEHOLDER-CONTRACT-V1
 * Read-only contract — temporary manual/upload cost lane until Purchase/Product Cost module.
 * No DB writes. No schema. No UI. No product/claim mutations.
 */

import { CLAIM_CALCULATION_HARD_RULES } from "@/lib/claims/contracts/claim-family-quantity-money-formula-contract-v2";
import { FEE_ADJUSTED_REIMBURSEMENT_FORMULA } from "@/lib/fees/amazon-fee-adjusted-reimbursement-estimate-model-v1";

/** Canonical cost source codes for unit_cost_basis resolution. */
export type ProductCostSourceCode =
  | "purchase_module_unit_cost"
  | "purchase_module_landed_cost"
  | "sellersnap_cogs"
  | "manual_override"
  | "upload_batch_fallback"
  | "return_items_operational_estimate"
  | "unavailable";

export type ProductCostScope = {
  organization_id: string;
  store_id: string;
  product_id: string;
};

/** High-level contract summary. */
export const COST_INPUT_CONTRACT = {
  phase: "PHASE-PRODUCT-COST-MANUAL-INPUT-PLACEHOLDER-CONTRACT-V1",
  mode: "read_only_contract",
  purpose:
    "Placeholder lane for unit cost input (manual, upload, SellerSnap) until Purchase/Product Cost module is built. Amazon fee-adjusted payout proceeds without cost; internal_cost_loss stays NULL when cost unknown.",
  scope: "organization_id + store_id + product_id (resolved via product_identifier_map)",
  optional: true,
  missing_cost_behavior: "internal_cost_loss = NULL — never 0, never sale price",
  interim_storage:
    "workspace_settings.module_configs.claim_intake.cogs_overrides (existing JSONB map) until product_cost_snapshots approved",
  schema_status: "NOT_CREATED — awaits Maysam approval (see phase-product-financial-spine-v1-approval.md)",
  hard_rules: [
    ...CLAIM_CALCULATION_HARD_RULES.filter((r) => r.includes("cost") || r.includes("sale price") || r.includes("NULL")),
    "Manual/upload cost is optional — fee-adjusted payout lane does not require cost.",
    "Cost input never mutates products or product_identifier_map.",
    "Future Purchase module becomes priority source when built.",
  ],
  internal_cost_loss_formula: FEE_ADJUSTED_REIMBURSEMENT_FORMULA.internal_cost_loss,
  separation:
    "unit_cost_basis feeds Lane B (internal_cost_loss) only — never estimated_amazon_payout or observed_reimbursement",
} as const;

/** Operator manual entry fields (UI scaffold — not built in this phase). */
export const MANUAL_FIELDS = {
  section_label: "Unit cost (optional)",
  fields: [
    {
      key: "unit_cost",
      label: "Unit cost",
      type: "currency",
      required_on_save: true,
      help: "Per-unit purchase/landed cost basis — NOT sale price",
    },
    {
      key: "currency",
      label: "Currency",
      type: "select",
      default: "USD",
      required_on_save: true,
    },
    {
      key: "effective_date",
      label: "Effective from",
      type: "date",
      required_on_save: false,
      help: "When blank, uses save timestamp for precedence tie-break",
    },
    {
      key: "reason",
      label: "Reason / note",
      type: "textarea",
      required_on_save: false,
      max_length: 500,
      help: "Auditable operator note — e.g. vendor quote, interim estimate",
    },
    {
      key: "source_code",
      label: "Source",
      type: "readonly",
      fixed_value: "manual_override",
    },
  ],
  scope_display: ["organization", "store", "product"],
  read_only_context: [
    "current_winning_source_code",
    "current_unit_cost_basis",
    "precedence_lineage (all sources with dates, greyed losers)",
    "internal_cost_loss_preview (clean_qty × unit_cost or NULL)",
  ],
  save_behavior:
    "Writes to interim cogs_overrides OR future product_cost_snapshots row with source_code=manual_override; triggers audit log",
  disable_when:
    "Purchase module unit cost present for same product+store — show read-only with higher-source badge",
} as const;

/** Bulk CSV upload contract (importer scaffold — not built in this phase). */
export const CSV_UPLOAD_COLUMNS = {
  required: [
    { column: "organization_id", type: "uuid", notes: "Tenant scope — must match session org" },
    { column: "store_id", type: "uuid", notes: "Sales channel scope" },
    {
      column: "identifier_type",
      type: "enum",
      allowed: ["product_id", "fnsku", "asin", "sku"],
      notes: "Exactly one identifier column populated per row",
    },
    {
      column: "identifier_value",
      type: "string",
      notes: "Must resolve via product_identifier_map — no title match, no auto-create",
    },
    { column: "unit_cost", type: "decimal", notes: "Positive number; NULL/blank row skipped with warning" },
  ],
  optional: [
    { column: "currency", type: "string", default: "USD" },
    { column: "effective_date", type: "date", format: "YYYY-MM-DD" },
    { column: "vendor_name", type: "string", notes: "Display only until Purchase module" },
    { column: "notes", type: "string", max_length: 500 },
    { column: "source_code", type: "enum", default: "upload_batch_fallback", allowed: ["upload_batch_fallback"] },
  ],
  forbidden_columns: [
    "sale_price",
    "list_price",
    "amazon_price",
    "product_prices.amount",
    "unit_sale_price",
    "recovery_value",
  ],
  batch_metadata: {
    import_session_id: "uuid — links all rows in one upload for audit rollback",
    uploaded_by: "user uuid",
    uploaded_at: "timestamptz",
    file_name: "original CSV filename",
    row_count: "integer",
  },
  preview_step:
    "Dry-run: resolve identifiers, flag unresolved, show precedence impact per row before apply",
  apply_step:
    "Insert cost rows with source_code=upload_batch_fallback; never overwrite manual_override without operator confirm",
} as const;

export const VALIDATION_RULES = {
  unit_cost: {
    min_exclusive: 0,
    max: 999_999.99,
    null_means: "skip row (upload) or block save (manual)",
    zero_forbidden: "0 is invalid — use NULL/absent for unknown cost",
  },
  currency: {
    allowed: ["USD"],
    future: ["CAD", "EUR", "GBP"],
  },
  effective_date: {
    max_future_days: 0,
    max_past_years: 10,
    null_fallback: "created_at of cost record",
  },
  identifier_resolution: {
    rule: "exact match on product_identifier_map within organization_id",
    fnsku_case: "normalize uppercase for lookup",
    on_unresolved: "reject row with error code identifier_not_mapped — no product auto-create",
  },
  tenancy: {
    rule: "organization_id required on every cost record and CSV row",
    store_id: "required — cost is store-scoped (multi-store tenants may differ)",
    product_id: "resolved target — never write cost without resolved product_id",
  },
  sale_price_guard: {
    rule: "Reject any input where unit_cost equals latest_valid_sale_price for same product (likely data entry error)",
    action: "review_signal — operator must confirm with reason",
  },
  trusted_money_gate: {
    high: "unit_cost from purchase_module_* or sellersnap_cogs with linkage resolved",
    medium: "manual_override or upload_batch_fallback with linkage resolved",
    low: "return_items_operational_estimate only — never trusted money without policy flag",
    unavailable: "unit_cost_basis NULL",
  },
} as const;

/** Precedence — highest wins per org+store+product. */
export const PRECEDENCE_RULES = {
  chain: [
    {
      rank: 1,
      source_code: "purchase_module_unit_cost" as const,
      label: "Purchase module unit cost",
      status: "planned",
      storage: "supplier_product_costs / product_cost_layers (future module)",
    },
    {
      rank: 2,
      source_code: "purchase_module_landed_cost" as const,
      label: "Purchase module landed cost",
      status: "planned",
      storage: "product_cost_layers.landed_unit_cost (freight+duty+vendor)",
    },
    {
      rank: 3,
      source_code: "sellersnap_cogs" as const,
      label: "SellerSnap COGS",
      status: "planned_importer",
      storage: "product_cost_snapshots.source_code=sellersnap_cogs",
    },
    {
      rank: 4,
      source_code: "manual_override" as const,
      label: "Manual operator override",
      status: "interim_available",
      storage:
        "workspace_settings.module_configs.claim_intake.cogs_overrides[fnsku|sku|asin] OR product_cost_snapshots.source_code=manual_override",
    },
    {
      rank: 5,
      source_code: "upload_batch_fallback" as const,
      label: "Uploaded CSV batch fallback",
      status: "planned_importer",
      storage: "product_cost_snapshots.source_code=upload_batch_fallback",
    },
    {
      rank: 6,
      source_code: "unavailable" as const,
      label: "NULL — unknown cost",
      status: "always",
      storage: "no row — internal_cost_loss NULL",
    },
  ],
  tie_break_same_rank: "most recent effective_date wins; if tied, most recent updated_at wins",
  legacy_v2_chain_note:
    "Supersedes COST_SOURCE_PRIORITY_CHAIN in claim-family-quantity-money-formula-contract-v2 when cost UI/importers ship",
  operational_fallback_outside_chain: {
    source_code: "return_items_operational_estimate" as const,
    rank: null,
    rule: "Existing fee-adjusted readmodel fallback — low confidence only; never overrides manual/upload/SellerSnap/purchase",
    display: "Show as warning badge — not a cost input source",
  },
} as const;

export const CONFLICT_RULES = {
  higher_source_wins:
    "When purchase_module_* row exists, manual_override and upload_batch_fallback are ignored for unit_cost_basis (still visible in lineage)",
  manual_vs_upload:
    "manual_override always beats upload_batch_fallback for same product+store",
  upload_vs_upload:
    "Newer effective_date wins; operator may bulk-replace via new import_session with explicit replace_mode",
  sellersnap_refresh:
    "Nightly SellerSnap import may update sellersnap_cogs row but never overwrites manual_override",
  purchase_module_activation:
    "When Purchase module ships, existing manual/upload rows remain in DB for audit but drop out of winning precedence",
  multi_identifier_override:
    "cogs_overrides keyed by fnsku|sku|asin — resolver checks fnsku first, then sku, then asin (matches fee-adjusted readmodel)",
  cross_store:
    "Cost rows are store-scoped — no implicit org-wide cost inheritance unless store_id null policy added later (deferred)",
} as const;

export const AUDIT_RULES = {
  required_fields_per_cost_row: [
    "organization_id",
    "store_id",
    "product_id",
    "unit_cost",
    "currency",
    "source_code",
    "effective_date",
    "created_by",
    "created_at",
    "updated_by",
    "updated_at",
    "deleted_at",
  ],
  soft_delete: "Never hard-delete cost rows — deleted_at + audit_logs trigger",
  audit_log_payload: {
    action_types: ["cost_manual_save", "cost_upload_apply", "cost_upload_rollback", "cost_source_superseded"],
    must_capture: ["prior_unit_cost", "new_unit_cost", "prior_source_code", "new_source_code", "reason", "import_session_id"],
  },
  operator_accountability:
    "Every manual_override save requires authenticated user; CSV apply requires imports permission + session id",
  immutability_claim_candidates:
    "Cost changes do not retroactively mutate claim_candidates.cogs_unit — intake snapshots remain point-in-time",
  read_model_lineage:
    "fee-adjusted-estimate and claim money APIs expose unit_cost_source string + winning source_code for transparency",
} as const;

/** Future schema options — documentation only; no DDL in this phase. */
export const FUTURE_DATA_MODEL_OPTIONS = {
  option_a_product_cost_snapshots: {
    recommendation: "preferred",
    table: "product_cost_snapshots",
    columns_sketch: [
      "id uuid PK",
      "organization_id uuid NOT NULL",
      "store_id uuid NOT NULL",
      "product_id uuid NOT NULL",
      "unit_cost numeric(12,4) NOT NULL",
      "currency text NOT NULL DEFAULT 'USD'",
      "source_code text NOT NULL",
      "effective_date date",
      "vendor_name text",
      "notes text",
      "import_session_id uuid",
      "created_by uuid",
      "updated_by uuid",
      "created_at timestamptz",
      "updated_at timestamptz",
      "deleted_at timestamptz",
    ],
    indexes: [
      "(organization_id, store_id, product_id, source_code, effective_date DESC)",
      "GIN on notes optional",
    ],
    approval_gate: "APPROVED_PRODUCT_COST_SNAPSHOTS in phase-product-financial-spine-v1-approval.md",
  },
  option_b_interim_cogs_overrides_only: {
    recommendation: "interim_until_approval",
    storage: "workspace_settings.module_configs.claim_intake.cogs_overrides",
    pros: ["No migration", "Already wired in fee-adjusted readmodel + ORBIT generator"],
    cons: ["No per-row audit", "No effective_date", "JSONB map not ideal at scale"],
    max_rows_guidance: "< 500 overrides before migrating to option_a",
  },
  option_c_purchase_module_tables: {
    recommendation: "future_primary",
    tables: ["supplier_product_costs", "product_cost_layers", "purchase_orders (module boundary)"],
    note: "Purchase module owns ranks 1–2 in precedence when built",
  },
} as const;

export const FUTURE_PURCHASE_MODULE_INTEGRATION = {
  boundary:
    "Purchase/Product Cost module is system-of-record for ranks 1–2; Claim Center and fee-adjusted readmodel consume read-only snapshots",
  handoff_events: [
    "purchase_receipt_posted → refresh product_cost_layers for affected product_id",
    "landed_cost_adjusted → new product_cost_layers row with source_code=purchase_module_landed_cost",
  ],
  claim_center_display:
    "Show 'Purchase cost' badge when winning source; manual/upload shown as superseded in lineage panel",
  deprecation_path: {
    cogs_overrides: "Migrate to product_cost_snapshots with source_code=manual_override; keep read shim 1 release",
    sellersnap_file: "Maps to product_cost_snapshots.source_code=sellersnap_cogs — same precedence rank 3",
  },
  maysam_approval_required: [
    "APPROVED_PURCHASE_MODULE_BOUNDARY",
    "APPROVED_PRODUCT_COST_SNAPSHOTS",
    "APPROVED_CLAIM_MONEY_BOUNDARY",
  ],
} as const;

export const FEE_ADJUSTED_READMODEL_INTEGRATION = {
  endpoint: "GET /api/products/[id]/fee-adjusted-estimate",
  current_resolution_order: [
    "1. claim_intake.cogs_overrides (interim manual_override)",
    "2. product_cost_snapshots — not wired (table missing)",
    "3. return_items.estimated_value — low-confidence fallback",
  ],
  target_resolution_order: PRECEDENCE_RULES.chain.map((c) => c.source_code),
  output_fields: {
    unit_cost_basis: "winning unit cost or NULL",
    unit_cost_source: "human-readable source_code + identifier key",
    internal_cost_loss: "clean_qty × unit_cost_basis or NULL",
    missing_inputs: "includes unit_cost_basis when NULL",
  },
  no_blocking:
    "estimated_amazon_payout computes independently — missing cost does not block payout estimate",
  implement_hook: "resolveUnitCostBasis(scope, identifiers) → { value, source_code, confidence }",
} as const;

export const CLAIM_MONEY_INTEGRATION = {
  formula_lane: "actual_loss / internal_cost_loss = claim_quantity × unit_cost_basis",
  families_using_cogs: [
    "customer_return_not_reimbursed",
    "warehouse_lost_inventory",
    "removal_order_discrepancy",
    "orbit_fra_fight_list",
    "missing_reimbursement",
  ],
  intake_snapshot_rule:
    "claim_candidates.cogs_unit captured at generator intake from winning source — later cost edits do not rewrite candidates",
  trusted_money:
    "Families requiring actual_cost_basis use same PRECEDENCE_RULES; NULL → review_signal or money_unavailable",
  orbit_anti_pattern_guard:
    "Never unit_sale_price or product_prices.amount as COGS — ORBIT generator must use resolveUnitCostBasis",
} as const;

export const NO_SCHEMA_CHANGE_VERIFICATION = {
  migrations_created: false,
  tables_created: false,
  columns_added: false,
  products_mutated: false,
  product_identifier_map_mutated: false,
  claim_candidates_mutated: false,
  scanner_changed: false,
  rbac_changed: false,
  contract_only: true,
} as const;

export const SAFE_TO_IMPLEMENT_COST_INPUT_UI_LATER =
  "yes_with_conditions" as const;

export const SAFE_TO_IMPLEMENT_COST_INPUT_UI_CONDITIONS = [
  "Interim UI may write claim_intake.cogs_overrides only (no new tables) — immediate, auditable via settings change log",
  "Persistent cost UI + CSV importer requires Maysam APPROVED_PRODUCT_COST_SNAPSHOTS=yes",
  "SellerSnap importer requires product_cost_snapshots + source_code=sellersnap_cogs",
  "Purchase module integration deferred until APPROVED_PURCHASE_MODULE_BOUNDARY=yes",
] as const;

export const NEXT_PROMPT = `PHASE-PRODUCT-COST-MANUAL-INPUT-UI-SCAFFOLD-V1

Mode: UI scaffold only — Product detail or Claim Center cost panel using MANUAL_FIELDS contract.
Interim persistence: claim_intake.cogs_overrides JSONB (no new tables until Maysam approves product_cost_snapshots).
Wire resolveUnitCostBasis into fee-adjusted readmodel display lineage.
No claim_candidates mutation. No scanner changes.

Prerequisite: Maysam approves interim cogs_overrides UI OR product_cost_snapshots schema.` as const;

/** Resolve winning source from precedence (pure, no I/O). */
export function resolveUnitCostBasisFromSources(
  sources: Partial<Record<ProductCostSourceCode, { unit_cost: number; effective_date?: string | null }>>,
): { unit_cost_basis: number | null; source_code: ProductCostSourceCode } {
  for (const step of PRECEDENCE_RULES.chain) {
    if (step.source_code === "unavailable") continue;
    const hit = sources[step.source_code];
    if (hit != null && hit.unit_cost > 0) {
      return { unit_cost_basis: hit.unit_cost, source_code: step.source_code };
    }
  }
  return { unit_cost_basis: null, source_code: "unavailable" };
}
