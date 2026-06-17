/**
 * PHASE-PRODUCT-COGS-MANUAL-ENTRY-UI-V1 — pilot COGS admin UI contract (dry-run only).
 * No DB writes; no claim mutation; preview via cogs_overrides path when approved in future execute phase.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { discoverMoneyLaneSourcesV1 } from "@/lib/claims/submission/claim-money-lane-source-discovery-v1";
import { extractCogsOverrideUnitCost } from "@/lib/claims/submission/cogs-override-value-v1";
import { loadCogsOverridesForOrg } from "@/lib/claims/submission/product-cogs-audit-v1";
import {
  FORMULA_CONTRACT,
  RECOMMENDED_SOURCE_OF_TRUTH,
} from "@/lib/products/contracts/product-cogs-manual-entry-or-import-plan-v1";
import {
  COGS_SOURCE_BUILD_MANIFEST,
  readCogsBuildApprovalStatus,
  type CogsBuildApprovalStatus,
} from "@/lib/products/contracts/product-cogs-source-build-v1";
import {
  CSV_UPLOAD_COLUMNS,
  MANUAL_FIELDS,
} from "@/lib/products/contracts/product-cost-manual-input-placeholder-contract-v1";

export const PRODUCT_COGS_MANUAL_ENTRY_UI_V1 = {
  phase: "PHASE-PRODUCT-COGS-MANUAL-ENTRY-UI-V1",
  pilotCaseRunId: "pilot-20260615T190000Z",
  intakeRunId: "a8a892fe-37d5-4d74-9ea2-02af8fd095ce",
  dryRunOnly: true,
  noDbWrite: true,
  noClaimMutation: true,
  safetyBanner:
    "This only previews approved COGS. It does not update claims yet.",
} as const;

export const PILOT_FNSKUS_V1 = [
  "X004D9AMWV",
  "X003VSWH37",
  "X004TRQBB3",
  "X004LLJMN1",
  "X004WJ8OE5",
  "X004N992LN",
] as const;

export type CogsIdentifierTypeV1 = "FNSKU" | "SKU" | "ASIN" | "resolved_product_id";

export type CogsSourceTypeV1 =
  | "manual_override"
  | "csv_import"
  | "supplier_invoice"
  | "manual_operator"
  | "other";

export type PilotSubmissionCogsPreviewV1 = {
  claimSubmissionId: string;
  claimCaseId: string;
  cleanQuantity: number;
  recoveryPreview: number | null;
  recoveryPreviewLabel: string;
};

export type PilotProductCogsRowV1 = {
  fnsku: string;
  sku: string | null;
  asin: string | null;
  productTitle: string | null;
  resolvedProductId: string | null;
  affectedClaimCount: number;
  cleanQuantityTotal: number;
  latestSoldPrice: number | null;
  settlementNet: number | null;
  currency: string | null;
  cogsStatus: "missing" | "override_present";
  approvedUnitCost: number | null;
  recoveryPreview: number | null;
  recoveryPreviewLabel: string;
  affectedSubmissions: PilotSubmissionCogsPreviewV1[];
};

export type ManualCogsEntryInputV1 = {
  fnsku: string;
  unitCost: number;
  currency: string;
  effectiveDate: string;
  sourceNote: string;
  approvedBy: string;
  sourceType: CogsSourceTypeV1;
  salePriceReviewConfirmed?: boolean;
};

export type ManualCogsValidationIssueV1 = {
  field: string;
  code: string;
  message: string;
  severity: "error" | "warning";
};

export type ManualCogsDryRunResultV1 = {
  ok: boolean;
  dryRun: true;
  noDbWrite: true;
  fnsku: string;
  issues: ManualCogsValidationIssueV1[];
  preview: {
    cleanQuantityTotal: number;
    unitCost: number | null;
    recoveryValue: number | null;
    recoveryLabel: string;
    currency: string;
    perSubmission: PilotSubmissionCogsPreviewV1[];
  } | null;
  wouldWriteTo: "cogs_overrides (execute phase only)";
};

export type ImportRowInputV1 = {
  identifier_type: string;
  identifier_value: string;
  unit_cost: string | number;
  currency: string;
  effective_date: string;
  source_note: string;
  approved_by?: string;
  source_type?: string;
  sale_price_review_confirmed?: string | boolean;
};

export type ImportDryRunRowResultV1 = {
  rowIndex: number;
  identifierType: string;
  identifierValue: string;
  ok: boolean;
  matchedFnsku: string | null;
  issues: ManualCogsValidationIssueV1[];
  preview: ManualCogsDryRunResultV1["preview"];
};

export type ImportDryRunResultV1 = {
  ok: boolean;
  dryRun: true;
  noDbWrite: true;
  rowCount: number;
  validCount: number;
  errorCount: number;
  rows: ImportDryRunRowResultV1[];
};

export type ProductCogsManualEntryUiPayloadV1 = {
  phase: string;
  buildPhase: string;
  dryRunOnly: boolean;
  noDbWrite: boolean;
  safetyBanner: string;
  pilotCaseRunId: string;
  intakeRunId: string;
  pilotProducts: PilotProductCogsRowV1[];
  pilotProductsLoadedCount: number;
  approvalStatus: CogsBuildApprovalStatus;
  rejectedSourceFields: readonly string[];
  manualFields: typeof MANUAL_FIELDS;
  importColumns: typeof CSV_UPLOAD_COLUMNS;
  importColumnsSimple: readonly string[];
  plan: {
    recommendedOption: string;
    recoveryFormula: string;
    salePriceNotCogs: string;
  };
};

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

function recoveryLabel(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "Unknown";
  return `$${value.toFixed(2)}`;
}

export function validateManualCogsEntryV1(
  input: ManualCogsEntryInputV1,
  context: {
    latestSoldPrice: number | null;
    cleanQuantityTotal: number;
  },
): ManualCogsValidationIssueV1[] {
  const issues: ManualCogsValidationIssueV1[] = [];

  if (!input.fnsku?.trim()) {
    issues.push({ field: "fnsku", code: "required", message: "FNSKU is required.", severity: "error" });
  }

  if (!Number.isFinite(input.unitCost) || input.unitCost <= 0) {
    issues.push({
      field: "unit_cost",
      code: "positive_required",
      message: "Unit cost must be a positive number.",
      severity: "error",
    });
  }

  if (!input.currency?.trim()) {
    issues.push({ field: "currency", code: "required", message: "Currency is required.", severity: "error" });
  }

  if (!input.effectiveDate?.trim()) {
    issues.push({
      field: "effective_date",
      code: "required",
      message: "Effective date is required.",
      severity: "error",
    });
  }

  if (!input.sourceNote?.trim()) {
    issues.push({
      field: "source_note",
      code: "required",
      message: "Source note is required (supplier invoice, operator estimate, etc.).",
      severity: "error",
    });
  }

  if (!input.approvedBy?.trim()) {
    issues.push({
      field: "approved_by",
      code: "required",
      message: "Approved by is required.",
      severity: "error",
    });
  }

  if (
    context.latestSoldPrice != null &&
    Number.isFinite(context.latestSoldPrice) &&
    Number.isFinite(input.unitCost) &&
    roundMoney(input.unitCost) === roundMoney(context.latestSoldPrice)
  ) {
    if (!input.salePriceReviewConfirmed) {
      issues.push({
        field: "unit_cost",
        code: "matches_sale_price",
        message:
          "Unit cost equals latest sold price. Sale price must not be used as COGS — confirm you reviewed this is not sale price.",
        severity: "error",
      });
    } else {
      issues.push({
        field: "unit_cost",
        code: "sale_price_review_confirmed",
        message: "Operator confirmed unit cost was reviewed and is not sale price.",
        severity: "warning",
      });
    }
  }

  return issues;
}

export function buildManualCogsDryRunResultV1(
  input: ManualCogsEntryInputV1,
  context: {
    latestSoldPrice: number | null;
    cleanQuantityTotal: number;
    perSubmission?: Array<{ claimSubmissionId: string; claimCaseId: string; cleanQuantity: number }>;
  },
): ManualCogsDryRunResultV1 {
  const issues = validateManualCogsEntryV1(input, context);
  const hasErrors = issues.some((i) => i.severity === "error");

  const unitCost = hasErrors ? null : roundMoney(input.unitCost);
  const recoveryValue =
    unitCost != null && context.cleanQuantityTotal > 0
      ? roundMoney(context.cleanQuantityTotal * unitCost)
      : null;

  const perSubmission =
    unitCost != null && context.perSubmission
      ? context.perSubmission.map((s) => {
          const rv =
            s.cleanQuantity > 0 ? roundMoney(s.cleanQuantity * unitCost) : null;
          return {
            claimSubmissionId: s.claimSubmissionId,
            claimCaseId: s.claimCaseId,
            cleanQuantity: s.cleanQuantity,
            recoveryPreview: rv,
            recoveryPreviewLabel: recoveryLabel(rv),
          };
        })
      : [];

  return {
    ok: !hasErrors,
    dryRun: true,
    noDbWrite: true,
    fnsku: input.fnsku,
    issues,
    preview: hasErrors
      ? null
      : {
          cleanQuantityTotal: context.cleanQuantityTotal,
          unitCost,
          recoveryValue,
          recoveryLabel: recoveryLabel(recoveryValue),
          currency: input.currency.trim().toUpperCase(),
          perSubmission,
        },
    wouldWriteTo: "cogs_overrides (execute phase only)",
  };
}

const ALLOWED_IDENTIFIER_TYPES: CogsIdentifierTypeV1[] = [
  "FNSKU",
  "SKU",
  "ASIN",
  "resolved_product_id",
];

export function resolveImportIdentifierToFnskuV1(
  row: ImportRowInputV1,
  pilotRows: PilotProductCogsRowV1[],
): { fnsku: string | null; issues: ManualCogsValidationIssueV1[] } {
  const issues: ManualCogsValidationIssueV1[] = [];
  const type = (row.identifier_type ?? "").trim().toUpperCase() as CogsIdentifierTypeV1;
  const value = (row.identifier_value ?? "").trim();

  if (!type || !ALLOWED_IDENTIFIER_TYPES.includes(type)) {
    issues.push({
      field: "identifier_type",
      code: "invalid_type",
      message: `identifier_type must be one of: ${ALLOWED_IDENTIFIER_TYPES.join(", ")}.`,
      severity: "error",
    });
    return { fnsku: null, issues };
  }

  if (!value) {
    issues.push({
      field: "identifier_value",
      code: "required",
      message: "identifier_value is required.",
      severity: "error",
    });
    return { fnsku: null, issues };
  }

  const matches: PilotProductCogsRowV1[] = [];
  for (const p of pilotRows) {
    if (type === "FNSKU" && p.fnsku.toUpperCase() === value.toUpperCase()) matches.push(p);
    if (type === "SKU" && p.sku?.toUpperCase() === value.toUpperCase()) matches.push(p);
    if (type === "ASIN" && p.asin?.toUpperCase() === value.toUpperCase()) matches.push(p);
    if (type === "resolved_product_id" && p.resolvedProductId === value) matches.push(p);
  }

  if (matches.length === 0) {
    issues.push({
      field: "identifier_value",
      code: "no_match",
      message: "No pilot product matched this identifier.",
      severity: "error",
    });
    return { fnsku: null, issues };
  }

  if (matches.length > 1) {
    issues.push({
      field: "identifier_value",
      code: "ambiguous_match",
      message: `Ambiguous match: ${matches.length} pilot products matched.`,
      severity: "error",
    });
    return { fnsku: null, issues };
  }

  return { fnsku: matches[0]!.fnsku, issues };
}

export function runImportDryRunV1(
  rows: ImportRowInputV1[],
  pilotRows: PilotProductCogsRowV1[],
  defaultApprovedBy: string,
): ImportDryRunResultV1 {
  const results: ImportDryRunRowResultV1[] = [];

  rows.forEach((row, rowIndex) => {
    const { fnsku, issues: idIssues } = resolveImportIdentifierToFnskuV1(row, pilotRows);
    const pilot = fnsku ? pilotRows.find((p) => p.fnsku === fnsku) : null;

    const unitCostRaw = row.unit_cost;
    const unitCost =
      typeof unitCostRaw === "number" ? unitCostRaw : parseFloat(String(unitCostRaw ?? "").trim());

    const saleConfirmed =
      row.sale_price_review_confirmed === true ||
      row.sale_price_review_confirmed === "true" ||
      row.sale_price_review_confirmed === "yes" ||
      row.sale_price_review_confirmed === "1";

    const manualInput: ManualCogsEntryInputV1 = {
      fnsku: fnsku ?? "",
      unitCost,
      currency: String(row.currency ?? "USD").trim(),
      effectiveDate: String(row.effective_date ?? "").trim(),
      sourceNote: String(row.source_note ?? "").trim(),
      approvedBy: String(row.approved_by ?? defaultApprovedBy).trim(),
      sourceType: (row.source_type as CogsSourceTypeV1) ?? "manual_override",
      salePriceReviewConfirmed: saleConfirmed,
    };

    const validationIssues = pilot
      ? validateManualCogsEntryV1(manualInput, {
          latestSoldPrice: pilot.latestSoldPrice,
          cleanQuantityTotal: pilot.cleanQuantityTotal,
        })
      : [
          {
            field: "identifier_value",
            code: "unresolved",
            message: "Could not resolve row to a pilot product.",
            severity: "error" as const,
          },
        ];

    const issues = [...idIssues, ...validationIssues];
    const hasErrors = issues.some((i) => i.severity === "error");
    const dryRun = pilot
      ? buildManualCogsDryRunResultV1(manualInput, {
          latestSoldPrice: pilot.latestSoldPrice,
          cleanQuantityTotal: pilot.cleanQuantityTotal,
          perSubmission: pilot.affectedSubmissions.map((s) => ({
            claimSubmissionId: s.claimSubmissionId,
            claimCaseId: s.claimCaseId,
            cleanQuantity: s.cleanQuantity,
          })),
        })
      : null;

    results.push({
      rowIndex,
      identifierType: row.identifier_type ?? "",
      identifierValue: row.identifier_value ?? "",
      ok: !hasErrors,
      matchedFnsku: fnsku,
      issues,
      preview: dryRun?.preview ?? null,
    });
  });

  const validCount = results.filter((r) => r.ok).length;
  return {
    ok: validCount === results.length && results.length > 0,
    dryRun: true,
    noDbWrite: true,
    rowCount: results.length,
    validCount,
    errorCount: results.length - validCount,
    rows: results,
  };
}

/** Parse simple CSV text (comma-separated, optional header). */
export function parseCogsImportCsvV1(text: string): ImportRowInputV1[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const required = [
    "identifier_type",
    "identifier_value",
    "unit_cost",
    "currency",
    "effective_date",
    "source_note",
  ];
  const hasHeader = required.every((col) => header.includes(col));
  const dataLines = hasHeader ? lines.slice(1) : lines;
  const colIndex = (name: string) => (hasHeader ? header.indexOf(name) : -1);

  return dataLines.map((line) => {
    const cells = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    if (hasHeader) {
      return {
        identifier_type: cells[colIndex("identifier_type")] ?? "",
        identifier_value: cells[colIndex("identifier_value")] ?? "",
        unit_cost: cells[colIndex("unit_cost")] ?? "",
        currency: cells[colIndex("currency")] ?? "USD",
        effective_date: cells[colIndex("effective_date")] ?? "",
        source_note: cells[colIndex("source_note")] ?? "",
        approved_by: cells[header.indexOf("approved_by")] ?? undefined,
        source_type: cells[header.indexOf("source_type")] ?? undefined,
      };
    }
    return {
      identifier_type: cells[0] ?? "",
      identifier_value: cells[1] ?? "",
      unit_cost: cells[2] ?? "",
      currency: cells[3] ?? "USD",
      effective_date: cells[4] ?? "",
      source_note: cells[5] ?? "",
    };
  });
}

function cogsOverrideUnitCost(
  cogsOverrides: Record<string, unknown>,
  fnsku: string,
  sku: string | null,
  asin: string | null,
): number | null {
  for (const key of [fnsku, sku, asin].filter(Boolean) as string[]) {
    const v = extractCogsOverrideUnitCost(cogsOverrides[key]);
    if (v != null) return v;
  }
  return null;
}

async function hydrateProductTitlesByFnsku(
  supabase: SupabaseClient,
  organizationId: string,
  fnskus: string[],
): Promise<Map<string, { sku: string | null; asin: string | null; title: string | null; productId: string | null }>> {
  const map = new Map<
    string,
    { sku: string | null; asin: string | null; title: string | null; productId: string | null }
  >();
  if (fnskus.length === 0) return map;

  const { data: products } = await supabase
    .from("products")
    .select("id, sku, asin, title, fnsku")
    .eq("organization_id", organizationId)
    .in("fnsku", fnskus);

  for (const p of products ?? []) {
    const fnsku = String(p.fnsku ?? "").trim();
    if (!fnsku) continue;
    map.set(fnsku, {
      sku: p.sku ? String(p.sku) : null,
      asin: p.asin ? String(p.asin) : null,
      title: p.title ? String(p.title) : null,
      productId: p.id ? String(p.id) : null,
    });
  }
  return map;
}

export async function loadPilotProductsNeedingCogsV1(args: {
  organizationId: string;
  storeId: string;
  supabase: SupabaseClient;
}): Promise<PilotProductCogsRowV1[]> {
  const supabase = args.supabase;

  const [moneyLane, cogsOverrides, productMeta] = await Promise.all([
    discoverMoneyLaneSourcesV1(supabase, args.organizationId, args.storeId, {
      pilot_case_run_id: PRODUCT_COGS_MANUAL_ENTRY_UI_V1.pilotCaseRunId,
      intake_run_id: PRODUCT_COGS_MANUAL_ENTRY_UI_V1.intakeRunId,
    }),
    loadCogsOverridesForOrg(supabase, args.organizationId),
    hydrateProductTitlesByFnsku(supabase, args.organizationId, [...PILOT_FNSKUS_V1]),
  ]);

  const byFnsku = new Map<
    string,
    {
      affectedClaimIds: Set<string>;
      cleanQuantityTotal: number;
      latestSoldPrice: number | null;
      settlementNet: number | null;
      sku: string | null;
      asin: string | null;
      resolvedProductId: string | null;
      submissions: Array<{ claimSubmissionId: string; claimCaseId: string; cleanQuantity: number }>;
    }
  >();

  for (const sub of moneyLane.per_submission) {
    const fnsku = String(sub.product_identifiers.fnsku ?? "").trim();
    if (!fnsku || !(PILOT_FNSKUS_V1 as readonly string[]).includes(fnsku)) continue;

    let bucket = byFnsku.get(fnsku);
    if (!bucket) {
      bucket = {
        affectedClaimIds: new Set(),
        cleanQuantityTotal: 0,
        latestSoldPrice: null,
        settlementNet: null,
        sku: sub.product_identifiers.sku,
        asin: sub.product_identifiers.asin,
        resolvedProductId: sub.product_identifiers.resolved_product_id,
        submissions: [],
      };
      byFnsku.set(fnsku, bucket);
    }

    if (sub.claim_case_id) bucket.affectedClaimIds.add(sub.claim_case_id);

    const qty = Number(sub.quantity ?? 0);
    if (Number.isFinite(qty) && qty > 0) bucket.cleanQuantityTotal += qty;

    bucket.submissions.push({
      claimSubmissionId: sub.claim_submission_id,
      claimCaseId: sub.claim_case_id,
      cleanQuantity: Number.isFinite(qty) && qty > 0 ? qty : 0,
    });

    if (sub.latest_sold_price_value != null) {
      bucket.latestSoldPrice = sub.latest_sold_price_value;
    }
    if (sub.settlement_amount != null) {
      bucket.settlementNet = sub.settlement_amount;
    }
    if (sub.product_identifiers.sku && !bucket.sku) bucket.sku = sub.product_identifiers.sku;
    if (sub.product_identifiers.asin && !bucket.asin) bucket.asin = sub.product_identifiers.asin;
    if (sub.product_identifiers.resolved_product_id && !bucket.resolvedProductId) {
      bucket.resolvedProductId = sub.product_identifiers.resolved_product_id;
    }
  }

  const rows: PilotProductCogsRowV1[] = [];
  for (const fnsku of PILOT_FNSKUS_V1) {
    const bucket = byFnsku.get(fnsku);
    const meta = productMeta.get(fnsku);
    const sku = bucket?.sku ?? meta?.sku ?? null;
    const asin = bucket?.asin ?? meta?.asin ?? null;
    const approvedUnitCost = cogsOverrideUnitCost(cogsOverrides, fnsku, sku, asin);
    const cogsStatus = approvedUnitCost != null ? "override_present" : "missing";
    const cleanQty = bucket?.cleanQuantityTotal ?? 0;
    const recoveryPreview =
      approvedUnitCost != null && cleanQty > 0
        ? roundMoney(cleanQty * approvedUnitCost)
        : null;

    rows.push({
      fnsku,
      sku,
      asin,
      productTitle: meta?.title ?? null,
      resolvedProductId: bucket?.resolvedProductId ?? meta?.productId ?? null,
      affectedClaimCount: bucket?.affectedClaimIds.size ?? 0,
      cleanQuantityTotal: cleanQty,
      latestSoldPrice: bucket?.latestSoldPrice ?? null,
      settlementNet: bucket?.settlementNet ?? null,
      currency: "USD",
      cogsStatus,
      approvedUnitCost,
      recoveryPreview,
      recoveryPreviewLabel: recoveryLabel(recoveryPreview),
      affectedSubmissions: (bucket?.submissions ?? []).map((s) => ({
        claimSubmissionId: s.claimSubmissionId,
        claimCaseId: s.claimCaseId,
        cleanQuantity: s.cleanQuantity,
        recoveryPreview: null,
        recoveryPreviewLabel: "Unknown",
      })),
    });
  }

  return rows;
}

export async function loadProductCogsManualEntryUiPayloadV1(args: {
  organizationId: string;
  storeId: string;
  supabase: SupabaseClient;
}): Promise<ProductCogsManualEntryUiPayloadV1> {
  const pilotProducts = await loadPilotProductsNeedingCogsV1(args);
  const approvalStatus = readCogsBuildApprovalStatus();

  return {
    phase: PRODUCT_COGS_MANUAL_ENTRY_UI_V1.phase,
    buildPhase: COGS_SOURCE_BUILD_MANIFEST.version,
    dryRunOnly: !approvalStatus.write_enabled,
    noDbWrite: !approvalStatus.write_enabled,
    safetyBanner: approvalStatus.write_enabled
      ? "Write approval active — Apply COGS is enabled for approved pilot FNSKUs only."
      : PRODUCT_COGS_MANUAL_ENTRY_UI_V1.safetyBanner,
    pilotCaseRunId: PRODUCT_COGS_MANUAL_ENTRY_UI_V1.pilotCaseRunId,
    intakeRunId: PRODUCT_COGS_MANUAL_ENTRY_UI_V1.intakeRunId,
    pilotProducts,
    pilotProductsLoadedCount: pilotProducts.length,
    approvalStatus,
    rejectedSourceFields: COGS_SOURCE_BUILD_MANIFEST.rejected_source_fields,
    manualFields: MANUAL_FIELDS,
    importColumns: CSV_UPLOAD_COLUMNS,
    importColumnsSimple: COGS_SOURCE_BUILD_MANIFEST.import_columns_simple,
    plan: {
      recommendedOption: RECOMMENDED_SOURCE_OF_TRUTH.immediate_pilot,
      recoveryFormula: FORMULA_CONTRACT.recovery_value,
      salePriceNotCogs:
        "Sale price must not be used as COGS. Recovery preview = clean_quantity × unit_cost — fees are display-only for removal pilot families.",
    },
  };
}
