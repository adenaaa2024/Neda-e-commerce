/**
 * PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-PLAN-V1
 * Read-only planning contract — safest approved COGS path for pilot FNSKUs.
 * No DB writes. No migrations applied. No imports executed.
 */
import {
  AUDIT_RULES,
  CONFLICT_RULES,
  COST_INPUT_CONTRACT,
  CSV_UPLOAD_COLUMNS,
  FUTURE_DATA_MODEL_OPTIONS,
  MANUAL_FIELDS,
  PRECEDENCE_RULES,
  VALIDATION_RULES,
} from "./product-cost-manual-input-placeholder-contract-v1";

export const PRODUCT_COGS_MANUAL_ENTRY_OR_IMPORT_PLAN_V1_VERSION =
  "product-cogs-manual-entry-or-import-plan-v1" as const;

export const PILOT_SCOPE = {
  original_ref: "kxsvedvpjldygtdbylsy",
  pilot_case_run_id: "pilot-20260615T190000Z",
  intake_run_id: "a8a892fe-37d5-4d74-9ea2-02af8fd095ce",
  pilot_submission_count: 10,
  unique_product_count: 6,
  organization_id: "00000000-0000-0000-0000-000000000001",
  store_id: "509ee1f6-622c-46a5-8110-7b889ba46c2c",
  families: ["removal_shipment_missing", "removal_order_discrepancy"] as const,
} as const;

/** Prerequisite audit gates (must remain true before any execute phase). */
export const PREREQUISITE_GATES = {
  money_lane_source_discovery: "PASS",
  product_cogs_audit: "PASS",
  latest_sold_price_coverage: "10/10",
  fee_deductions_coverage: "10/10",
  net_settlement_coverage: "10/10",
  approved_cogs_coverage: "0/10",
  recovery_value_preview: "0/10 (COGS_MISSING)",
} as const;

/** Canonical recovery formula for current pilot families. */
export const FORMULA_CONTRACT = {
  recovery_value:
    "recovery_value = clean_quantity × approved_cogs_unit (NULL when approved_cogs_unit IS NULL)",
  approved_cogs_unit:
    "Winning unit cost from governed precedence chain only — never sale price, settlement net, or reimbursement",
  fee_subtraction_rule:
    "Do NOT subtract Amazon selling fees from recovery_value for removal_shipment_missing or removal_order_discrepancy unless Maysam explicitly approves revenue-loss recovery policy for that family",
  pilot_family_basis:
    "Default recovery basis = item cost / COGS only (inventory loss), not latest_sold_price or net_settlement_amount",
  informational_lanes_separate:
    "latest_sold_price, fee_deductions, net_settlement_amount remain display/context lanes — they do not substitute for COGS",
  hard_rules: [
    "Never use product_prices.amount as COGS even when PIM Product Master column is named cost",
    "Never infer COGS from SKU/product name",
    "Never write 0 for unknown cost — keep NULL",
    "Do not retroactively mutate claim_candidates on cost entry — recompute preview/read-model only until explicit emit refresh approved",
  ],
} as const;

export const PLAN_OPTIONS = {
  A_manual_entry: {
    label: "Manual COGS entry (recommended pilot unblock)",
    status: "recommended_first",
    storage_interim: "workspace_settings.module_configs.claim_intake.cogs_overrides[fnsku|sku|asin]",
    storage_preferred: "product_cost_snapshots (source_code=manual_override) after migration approved",
    required_fields: [
      "unit_cost (approved_cogs_unit)",
      "currency",
      "effective_date",
      "source_note (reason)",
      "approved_by (operator user id + display name)",
      "source_code fixed manual_override",
    ],
    audit_event: {
      table: "platform_automation_audit_log",
      action: "cogs_manual_override_save",
      must_capture: [
        "organization_id",
        "store_id",
        "product_id",
        "identifier_key",
        "prior_unit_cost",
        "new_unit_cost",
        "currency",
        "effective_date",
        "source_note",
        "approved_by",
      ],
    },
    scope: "One entry per resolved product_id; key override map by FNSKU (pilot has FNSKU on all rows)",
    no_product_mutation: true,
    note: "Fastest path for 6 FNSKUs — operator supplies vendor/purchase cost from external records; system never invents values",
  },
  B_cogs_import: {
    label: "COGS CSV/XLSX import",
    status: "recommended_after_manual_pilot_or_bulk",
    file_formats: ["CSV", "XLSX (single sheet)"],
    columns: CSV_UPLOAD_COLUMNS,
    validation: VALIDATION_RULES,
    workflow: ["upload", "dry-run preview", "linkage resolution report", "operator confirm", "apply batch", "audit log"],
    reject_rules: [
      "identifier resolves to 0 products",
      "identifier resolves to >1 products without explicit product_id",
      "unit_cost equals latest_valid_sale_price for same product (review gate)",
      "forbidden columns present (sale_price, list_price, …)",
    ],
    storage: "product_cost_snapshots.source_code=upload_batch_fallback (preferred) or interim cogs_overrides batch",
    audit_event: {
      action: "cogs_upload_apply",
      import_session_id: "uuid linking all rows for rollback",
    },
  },
  C_pim_product_master_wiring: {
    label: "Existing Product Master cost wiring",
    status: "not_recommended_as_cogs_spine",
    finding:
      "PIM Product Master import already maps cost-like columns to product_prices (sale/list cache lane) via backend-python _pim_pick_row_unit_price — NOT approved COGS",
    allowed_future_use:
      "Read-only re-parse of raw pim_product_master upload files to PROPOSE candidate unit costs for operator review, then write only to product_cost_snapshots or cogs_overrides after explicit column classification (purchase cost vs selling price)",
    rejected_paths: [
      "product_prices.amount → recovery_value",
      "products.metadata.product_attributes cost keys without source_code and effective_date",
      "Automatic inference from PIM import without operator approval per row",
    ],
    explicit_cost_headers_in_pim_pipeline: [
      "selling_unit_cost_without_freight",
      "selling_unit_cost",
      "case_cost_without_freight",
      "case_cost",
      "cost",
      "unit_cost",
      "last_cost",
    ],
    sale_like_headers_rejected: ["list_price", "msrp", "price (when mapped to product_prices sale lane)"],
    prerequisite_before_use:
      "Per-upload column audit proving header is purchase/landed cost, not Amazon selling price; operator sign-off per pilot SKU",
  },
} as const;

export const MANUAL_ENTRY_CONTRACT = {
  ...MANUAL_FIELDS,
  pilot_additions: {
    approved_by: {
      key: "approved_by",
      label: "Approved by",
      type: "user_ref",
      required_on_save: true,
      help: "Authenticated operator attesting vendor cost is correct — not inferred from sale price",
    },
    source_note: {
      key: "source_note",
      label: "Source note",
      type: "textarea",
      required_on_save: true,
      max_length: 500,
      help: "e.g. vendor invoice #, SellerSnap export date, manual count sheet",
    },
    effective_date: {
      key: "effective_date",
      label: "Effective from",
      type: "date" as const,
      required_on_save: true,
      help: "Cost effective date for precedence tie-break and audit",
    },
  },
  save_targets: {
    phase_1_interim: {
      table: "workspace_settings",
      path: "module_configs.claim_intake.cogs_overrides",
      key_precedence: ["fnsku", "sku", "asin"],
      requires_workspace_row: true,
    },
    phase_2_preferred: {
      table: "product_cost_snapshots",
      source_code: "manual_override",
    },
  },
  audit: AUDIT_RULES,
  conflicts: CONFLICT_RULES,
  precedence: PRECEDENCE_RULES,
} as const;

export const IMPORT_FILE_CONTRACT = {
  ...CSV_UPLOAD_COLUMNS,
  pilot_minimum_rows: 6,
  pilot_identifiers: "Prefer fnsku column matching pilot matrix; product_id optional when unambiguous",
  preview_output: [
    "resolved_product_id",
    "identifier_match_count",
    "proposed_unit_cost",
    "currency",
    "effective_date",
    "would_win_precedence",
    "blockers",
  ],
  apply_guards: [
    "Maysam APPROVED_PRODUCT_COST_SNAPSHOTS=yes OR interim cogs_overrides-only mode explicitly approved",
    "original_ref guard kxsvedvpjldygtdbylsy",
    "dry-run pass with zero ambiguous matches",
  ],
} as const;

export const VALIDATION_RULES_PLAN = {
  ...VALIDATION_RULES,
  pilot_specific: {
    weak_asin: "Pilot rows have ASIN null — require FNSKU or SKU + resolved_product_id match",
    no_invention: "Blank unit_cost → row rejected; never default from sale/settlement/reimbursement",
    quantity_independent: "COGS is per-unit; recovery_value computed at claim line using clean_quantity",
  },
} as const;

export const REQUIRED_COLUMNS = {
  manual: ["unit_cost", "currency", "effective_date", "source_note", "approved_by"],
  import: CSV_UPLOAD_COLUMNS.required.map((c) => c.column),
  import_optional: CSV_UPLOAD_COLUMNS.optional.map((c) => c.column),
} as const;

export const REJECTED_COLUMNS_OR_SOURCES = {
  columns: CSV_UPLOAD_COLUMNS.forbidden_columns,
  sources: [
    "product_prices.amount",
    "latest_sold_price (amazon_reports_repository / settlements / all_orders)",
    "net_settlement_amount",
    "observed_reimbursement",
    "return_items.estimated_value (fallback — not approved for pilot recovery without policy)",
    "SKU name / title inference",
    "PIM Product Master auto-wire to product_prices as COGS",
  ],
  pim_metadata_keys: [
    "list_price",
    "msrp",
    "amazon_price",
    "sale_price",
    "selling_price",
  ],
} as const;

export const RECOMMENDED_SOURCE_OF_TRUTH = {
  immediate_pilot:
    "Option A — manual COGS entry into cogs_overrides keyed by FNSKU for 6 pilot products (operator-supplied vendor cost only)",
  medium_term:
    "Option B — governed CSV import → product_cost_snapshots after additive migration + Maysam APPROVED_PRODUCT_COST_SNAPSHOTS=yes",
  not_now: "Option C — do not wire existing PIM product_prices path to recovery_value; optional future re-parse of uploads for operator-reviewed COGS candidates only",
  winning_precedence: [
    "manual_override",
    "upload_batch_fallback",
    "sellersnap_cogs",
    "purchase_module_unit_cost",
    "purchase_module_landed_cost",
  ],
} as const;

export const PROPOSED_MIGRATION_IF_NEEDED = {
  migration_needed: true,
  reason: "product_cost_snapshots does not exist on original/live DB (per COGS audit 20260616T231548Z)",
  approval_gate: "APPROVED_PRODUCT_COST_SNAPSHOTS=yes in phase-product-financial-spine-v1-approval.md",
  target_env_first: "original kxsvedvpjldygtdbylsy (pilot) — staging parity after pilot verify",
  ddl_sketch: FUTURE_DATA_MODEL_OPTIONS.option_a_product_cost_snapshots,
  additive_only: true,
  rls: "organization_id scoped — mirror product_prices RLS pattern",
  does_not_replace: "cogs_overrides remains valid interim until all readers prefer snapshots",
  apply_in_phase: "PHASE-PRODUCT-COGS-SNAPSHOTS-MIGRATION-APPLY-V1 (future — not this phase)",
} as const;

export const UI_AND_PERMISSIONS = {
  ui_needed: true,
  surfaces: [
    "Claim Center money lane panel — COGS missing blocker with link to cost entry",
    "Platform Settings → Claim intake → COGS overrides (interim) OR Product cost admin (post-migration)",
    "Bulk import wizard with dry-run preview (Option B)",
  ],
  admin_permission_needed: true,
  permission_model: [
    "canEditPlatformProductSettings OR claim intake policy edit role",
    "Separate cogs_import_apply permission for bulk CSV apply",
    "Read-only viewers see lineage but cannot save",
  ],
  rbac_note: "Do not change Platform Access/RBAC in this plan phase — document required gates only",
} as const;

export const ROLLBACK_PLAN = {
  cogs_overrides: {
    method: "Restore prior workspace_settings.module_configs.claim_intake.cogs_overrides JSON snapshot",
    audit: "platform_automation_audit_log entry cogs_manual_override_rollback with before/after",
    scope: "Per FNSKU/SKU/ASIN key or full map restore from undo snapshot",
  },
  product_cost_snapshots: {
    method: "Soft delete via deleted_at on affected rows OR import_session_id batch rollback",
    hard_delete: "Forbidden — audit trail must remain",
  },
  import_batch: {
    method: "Rollback SQL scoped by import_session_id; revert winning precedence to prior snapshot row",
  },
  claim_data: {
    rule: "Rollback cost writes only — never delete claim_submissions / claim_cases / claim_candidates",
    recovery_recompute: "Re-run money lane preview read-model after rollback — expect recovery_value NULL again",
  },
} as const;

export const SAFE_FLAGS = {
  SAFE_TO_BUILD_COGS_IMPORT_OR_MANUAL_ENTRY:
    "yes — plan complete; execute requires operator-supplied costs and approval gate for migration if using snapshots",
  SAFE_TO_BUILD_MONEY_LANE_PREVIEW:
    "conditional_yes — sale/fees/settlement lanes ready; recovery_value preview stays blocked until approved COGS entered",
  NEXT_PROMPT: "PHASE-PRODUCT-COGS-MANUAL-ENTRY-UI-V1",
} as const;

export const PLAN_SUMMARY = {
  version: PRODUCT_COGS_MANUAL_ENTRY_OR_IMPORT_PLAN_V1_VERSION,
  mode: "read_only_planning_contract",
  inherits: COST_INPUT_CONTRACT.phase,
  pilot_scope: PILOT_SCOPE,
  prerequisites: PREREQUISITE_GATES,
  options: PLAN_OPTIONS,
  formula: FORMULA_CONTRACT,
  recommended: RECOMMENDED_SOURCE_OF_TRUTH,
  migration: PROPOSED_MIGRATION_IF_NEEDED,
  ui: UI_AND_PERMISSIONS,
  rollback: ROLLBACK_PLAN,
  safe: SAFE_FLAGS,
} as const;
