/**
 * PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-BUILD-V1
 * Guarded COGS source build — preview by default; writes require explicit approval.
 */
import fs from "node:fs";
import path from "node:path";

import { CSV_UPLOAD_COLUMNS } from "./product-cost-manual-input-placeholder-contract-v1";
import { FORMULA_CONTRACT } from "./product-cogs-manual-entry-or-import-plan-v1";

export const PRODUCT_COGS_SOURCE_BUILD_V1 = {
  phase: "PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-BUILD-V1",
  pilotCaseRunId: "pilot-20260615T190000Z",
  intakeRunId: "a8a892fe-37d5-4d74-9ea2-02af8fd095ce",
  originalDbRef: "kxsvedvpjldygtdbylsy",
  approvalPath: ".cursor/operator-approvals/product-cogs-source-build-v1-approval.md",
  migrationFile:
    "supabase/migrations/20260618120000_phase_product_cogs_source_build_v1_product_cost_snapshots.sql",
} as const;

export const COGS_BUILD_APPROVAL_KEYS = {
  sourceBuild: "APPROVED_PRODUCT_COGS_SOURCE_BUILD_V1",
  schemaMigration: "APPROVED_PRODUCT_COGS_SCHEMA_MIGRATION_V1",
  write: "APPROVED_PRODUCT_COGS_WRITE_V1",
} as const;

/** Columns rejected if present in import header — sale/list price must not be COGS. */
export const REJECTED_SOURCE_FIELDS = [
  "sale_price",
  "list_price",
  "amazon_price",
  "unit_sale_price",
  "selling_price",
  "msrp",
  "product_prices.amount",
  "net_settlement",
  "settlement_net",
  "item_price",
  "latest_sold_price",
] as const;

export const MANUAL_ENTRY_FIELDS_V1 = [
  "resolved_product_id",
  "asin",
  "fnsku",
  "sku",
  "cogs_unit",
  "currency",
  "effective_date",
  "source_note",
  "approved_by",
  "approval_timestamp",
] as const;

export const IMPORT_PREVIEW_COLUMNS_V1 = [
  "SKU",
  "FNSKU",
  "ASIN",
  "cost",
  "currency",
  "effective_date",
  "source",
] as const;

export const PROPOSED_PRODUCT_COST_SNAPSHOTS_MIGRATION = `-- PHASE-PRODUCT-COGS-MANUAL-ENTRY-OR-IMPORT-BUILD-V1
-- PROPOSED ONLY — apply only when APPROVED_PRODUCT_COGS_SCHEMA_MIGRATION_V1=yes

DO $$ BEGIN
  IF to_regclass('public.product_cost_snapshots') IS NULL THEN
    CREATE TABLE public.product_cost_snapshots (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id   UUID NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
      store_id          UUID REFERENCES public.stores (id) ON DELETE SET NULL,
      product_id        UUID NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
      unit_cost         NUMERIC(14, 4) NOT NULL CHECK (unit_cost > 0),
      currency          TEXT NOT NULL DEFAULT 'USD',
      effective_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      source_code       TEXT NOT NULL DEFAULT 'manual_override',
      source_note       TEXT,
      approved_by       UUID REFERENCES public.profiles (id) ON DELETE SET NULL,
      approved_at       TIMESTAMPTZ,
      identifier_type   TEXT,
      identifier_value  TEXT,
      import_session_id UUID,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at        TIMESTAMPTZ
    );

    COMMENT ON TABLE public.product_cost_snapshots IS
      'Governed approved unit cost spine — never sale price or settlement net.';

    CREATE INDEX IF NOT EXISTS idx_product_cost_snapshots_org_product_effective
      ON public.product_cost_snapshots (organization_id, product_id, effective_at DESC)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_product_cost_snapshots_org_store
      ON public.product_cost_snapshots (organization_id, store_id)
      WHERE deleted_at IS NULL;

    ALTER TABLE public.product_cost_snapshots ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;
`;

export type CogsBuildApprovalStatus = {
  source_build: "approved" | "missing" | "denied";
  schema_migration: "approved" | "missing" | "denied";
  write: "approved" | "missing" | "denied";
  default_mode: "dry_run_preview";
  write_enabled: boolean;
  migration_may_apply: boolean;
};

function readApprovalKey(filePath: string, key: string): "approved" | "missing" | "denied" {
  const p = path.join(process.cwd(), filePath);
  if (!fs.existsSync(p)) return "missing";
  const raw = fs.readFileSync(p, "utf8");
  if (new RegExp(`^${key}\\s*=\\s*yes\\s*$`, "im").test(raw)) return "approved";
  return "denied";
}

export function readCogsBuildApprovalStatus(
  approvalPath = PRODUCT_COGS_SOURCE_BUILD_V1.approvalPath,
): CogsBuildApprovalStatus {
  const source_build = readApprovalKey(approvalPath, COGS_BUILD_APPROVAL_KEYS.sourceBuild);
  const schema_migration = readApprovalKey(approvalPath, COGS_BUILD_APPROVAL_KEYS.schemaMigration);
  const write = readApprovalKey(approvalPath, COGS_BUILD_APPROVAL_KEYS.write);

  return {
    source_build,
    schema_migration,
    write,
    default_mode: "dry_run_preview",
    write_enabled: write === "approved",
    migration_may_apply: schema_migration === "approved" && source_build === "approved",
  };
}

export function detectForbiddenImportHeaders(headers: string[]): string[] {
  const normalized = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  return REJECTED_SOURCE_FIELDS.filter((f) =>
    normalized.some((h) => h === f || h.includes(f.replace(".", "_"))),
  );
}

export function verifyFormulaContract(): boolean {
  return (
    FORMULA_CONTRACT.recovery_value.includes("clean_quantity") &&
    FORMULA_CONTRACT.recovery_value.includes("approved_cogs_unit") &&
    FORMULA_CONTRACT.approved_cogs_unit.toLowerCase().includes("sale price")
  );
}

export const COGS_SOURCE_BUILD_MANIFEST = {
  version: "product-cogs-source-build-v1",
  recovery_formula: FORMULA_CONTRACT.recovery_value,
  interim_storage: "workspace_settings.module_configs.claim_intake.cogs_overrides",
  preferred_storage: "product_cost_snapshots",
  import_columns_extended: CSV_UPLOAD_COLUMNS,
  import_columns_simple: IMPORT_PREVIEW_COLUMNS_V1,
  rejected_source_fields: REJECTED_SOURCE_FIELDS,
  manual_fields: MANUAL_ENTRY_FIELDS_V1,
} as const;
