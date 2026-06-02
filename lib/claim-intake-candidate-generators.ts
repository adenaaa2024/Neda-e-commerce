/**
 * Claim intake candidate generators — source rows → claim_candidate_drafts (lineage + idempotency).
 * No marketplace submit. No return_items writes. Dry-run by default.
 */
import * as crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const CLAIM_INTAKE_GENERATOR_VERSION = "0.2.0-phase1-intake-wire";

export type ClaimIntakeGeneratorSourceTable =
  | "amazon_returns"
  | "amazon_removals"
  | "amazon_removal_shipments"
  | "amazon_reimbursements"
  | "amazon_settlements";

export const CLAIM_INTAKE_GENERATOR_SOURCE_TABLES: ClaimIntakeGeneratorSourceTable[] = [
  "amazon_returns",
  "amazon_removals",
  "amazon_removal_shipments",
  "amazon_reimbursements",
  "amazon_settlements",
];

export type ClaimIntakeCandidateDraft = {
  organization_id: string;
  store_id: string | null;
  source_table: string;
  source_row_id: string;
  claim_family: string;
  claim_reason: string;
  evidence_status: "missing" | "partial" | "complete";
  confidence_score: number;
  sku: string | null;
  asin: string | null;
  fnsku: string | null;
  product_id: string | null;
  resolved_product_id: string | null;
  generator_version: string;
  source_run_id: string | null;
  upload_id: string | null;
  idempotency_key: string;
  generated_by: string;
  blocker_reasons: string[];
  recommended_action: string;
  candidate_payload: Record<string, unknown>;
  lifecycle_status: "draft" | "blocked" | "needs_evidence";
};

function nv(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export function claimIntakeIdempotencyKey(
  org: string,
  sourceTable: string,
  sourceRowId: string,
  claimReason: string,
): string {
  const h = crypto.createHash("sha256");
  h.update(`${org}|${sourceTable}|${sourceRowId}|${claimReason}`);
  return `cl:intake:${h.digest("hex").slice(0, 32)}`;
}

function dispositionClaimReason(disposition: string | null, detailed: string | null): string {
  const d = `${disposition ?? ""} ${detailed ?? ""}`.toLowerCase();
  if (d.includes("damage") || d.includes("damaged")) return "DISPOSITION_DAMAGE_OR_DAMAGED";
  if (d.includes("customer")) return "DISPOSITION_CUSTOMER_RELATED";
  if (d.includes("defect")) return "DISPOSITION_DEFECTIVE";
  if (d.includes("carrier") || d.includes("lost")) return "DISPOSITION_CARRIER_OR_LOST";
  if (d.includes("sellable") || d.includes("unsellable")) return "DISPOSITION_SELLABILITY_REVIEW";
  return "DISPOSITION_LINE_REVIEW";
}

function returnsClaimReason(row: Record<string, unknown>): string {
  return dispositionClaimReason(nv(row.disposition), nv(row.detailed_disposition) ?? nv(row.return_reason));
}

function removalsClaimReason(row: Record<string, unknown>): string {
  return dispositionClaimReason(nv(row.disposition) ?? nv(row.removal_disposition), nv(row.detailed_disposition));
}

function shipmentsClaimReason(row: Record<string, unknown>): string {
  const rq = row.requested_quantity;
  const sq = row.shipped_quantity;
  const nums = [rq, sq].map((x) => (typeof x === "number" ? x : Number(x))).filter((x) => Number.isFinite(x));
  if (nums.length >= 2 && nums[0] !== nums[1]) return "SHIPMENT_QUANTITY_MISMATCH";
  return dispositionClaimReason(nv(row.disposition), null);
}

function lineagePayload(args: {
  source_table: string;
  source_row_id: string;
  upload_id: string | null;
  external_reference: string | null;
  sku: string | null;
  asin: string | null;
  fnsku: string | null;
  amount: number | null;
  quantity: number | null;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    source_type: args.source_table,
    source_report_id: args.upload_id,
    import_id: args.upload_id,
    source_row_id: args.source_row_id,
    external_reference: args.external_reference,
    product_identifiers: {
      sku: args.sku,
      asin: args.asin,
      fnsku: args.fnsku,
    },
    amount: args.amount,
    quantity: args.quantity,
    ...args.extra,
  };
}

/** Settlement rows eligible for claim intake (conservative — fee-only / transfer excluded). */
export function isSettlementRowClaimableIntake(row: Record<string, unknown>): boolean {
  const tx = `${nv(row.transaction_type) ?? ""} ${nv(row.description) ?? ""}`.toLowerCase();
  if (/service fee|transfer|subscription|loan|debt|successful charge|failed charge/.test(tx)) return false;
  if (/reimbursement|adjustment|claim|refund|chargeback|dispute|recovery|fee reversal|fba inventory|missing from/.test(tx)) {
    return true;
  }
  const amt = Number(row.amount_total ?? row.other_amount);
  if (Number.isFinite(amt) && amt < 0 && (nv(row.order_id) || nv(row.sku))) return true;
  return false;
}

export function buildIntakeCandidateFromSourceRow(
  sourceTable: ClaimIntakeGeneratorSourceTable,
  row: Record<string, unknown>,
  generatedBy: string,
): ClaimIntakeCandidateDraft | null {
  const org = nv(row.organization_id);
  const id = nv(row.id);
  if (!org || !id) return null;

  const storeId = nv(row.store_id);
  const sku = nv(row.sku) ?? nv(row.merchant_sku) ?? nv(row.seller_sku);
  const asin = nv(row.asin);
  const fnsku = nv(row.fnsku);
  const uploadId = nv(row.upload_id);

  if (sourceTable === "amazon_settlements" && !isSettlementRowClaimableIntake(row)) return null;

  let claimFamily = "IMPORT_SOURCE";
  let claimReason = "IMPORT_LINE_REVIEW";
  let evidence: ClaimIntakeCandidateDraft["evidence_status"] = "partial";
  let confidence = 0.4;
  const blockers: string[] = ["product_identity_unresolved"];
  let recommended = "triage_before_review";
  let externalRef: string | null = null;
  let amount: number | null = null;
  let quantity: number | null = null;

  switch (sourceTable) {
    case "amazon_returns": {
      claimFamily = "AMAZON_RETURNS_FBA";
      claimReason = returnsClaimReason(row);
      externalRef = nv(row.order_id);
      evidence = nv(row.return_id) ?? nv(row.returns_id) ? "partial" : "missing";
      confidence = evidence === "partial" ? 0.52 : 0.28;
      if (!sku && !asin && !fnsku) blockers.push("missing_sku_asin_fnsku");
      recommended = "triage_package_slip_photos_before_submit";
      break;
    }
    case "amazon_removals": {
      claimFamily = "AMAZON_REMOVALS";
      claimReason = removalsClaimReason(row);
      externalRef = nv(row.order_id);
      quantity = Number(row.shipped_quantity ?? row.requested_quantity) || null;
      evidence = sku || fnsku || asin ? "partial" : "missing";
      confidence = 0.45;
      blockers.push("removal_evidence_spine_weak");
      recommended = "verify_removal_disposition_and_shipment_bridge";
      break;
    }
    case "amazon_removal_shipments": {
      claimFamily = "AMAZON_REMOVAL_SHIPMENTS";
      claimReason = shipmentsClaimReason(row);
      externalRef = nv(row.order_id) ?? nv(row.tracking_number);
      quantity = Number(row.shipped_quantity) || null;
      evidence = sku || fnsku || asin || nv(row.tracking_number) ? "partial" : "missing";
      confidence = 0.42;
      blockers.push("shipment_row_requires_typed_columns_or_raw_parse");
      recommended = "enrich_shipment_line_then_reassess_evidence";
      break;
    }
    case "amazon_reimbursements": {
      claimFamily = "AMAZON_REIMBURSEMENTS";
      claimReason = "REIMBURSEMENT_LINE_REVIEW";
      externalRef = nv(row.reimbursement_id) ?? nv(row.order_id);
      amount = Number(row.amount_reimbursed) || null;
      evidence = amount != null && amount !== 0 ? "partial" : "missing";
      confidence = 0.55;
      recommended = "match_to_operational_return_or_removal";
      break;
    }
    case "amazon_settlements": {
      claimFamily = "AMAZON_SETTLEMENTS";
      claimReason = `SETTLEMENT_${String(nv(row.transaction_type) ?? "LINE").toUpperCase().replace(/\s+/g, "_")}`.slice(0, 80);
      externalRef = nv(row.settlement_id) ?? nv(row.amazon_line_key);
      amount = Number(row.amount_total ?? row.other_amount) || null;
      quantity = Number(row.quantity) || null;
      evidence = amount != null ? "partial" : "missing";
      confidence = 0.48;
      recommended = "verify_settlement_claimable_and_link_order";
      break;
    }
    default:
      return null;
  }

  if (!storeId) blockers.push("nullable_store_policy_review");

  const payload = lineagePayload({
    source_table: sourceTable,
    source_row_id: id,
    upload_id: uploadId,
    external_reference: externalRef,
    sku,
    asin,
    fnsku,
    amount,
    quantity,
  });

  return {
    organization_id: org,
    store_id: storeId,
    source_table: sourceTable,
    source_row_id: id,
    claim_family: claimFamily,
    claim_reason: claimReason,
    evidence_status: evidence,
    confidence_score: confidence,
    sku,
    asin,
    fnsku,
    product_id: null,
    resolved_product_id: nv(row.resolved_product_id),
    generator_version: CLAIM_INTAKE_GENERATOR_VERSION,
    source_run_id: null,
    upload_id: uploadId,
    idempotency_key: claimIntakeIdempotencyKey(org, sourceTable, id, claimReason),
    generated_by: generatedBy,
    blocker_reasons: blockers,
    recommended_action: recommended,
    candidate_payload: payload,
    lifecycle_status: blockers.includes("missing_sku_asin_fnsku") ? "needs_evidence" : "draft",
  };
}

export function intakeDraftToInsertRow(c: ClaimIntakeCandidateDraft): Record<string, unknown> {
  return {
    organization_id: c.organization_id,
    store_id: c.store_id,
    source_table: c.source_table,
    source_row_id: c.source_row_id,
    claim_family: c.claim_family,
    claim_reason: c.claim_reason,
    evidence_status: c.evidence_status,
    confidence_score: c.confidence_score,
    sku: c.sku,
    asin: c.asin,
    fnsku: c.fnsku,
    product_id: c.product_id,
    resolved_product_id: c.resolved_product_id,
    generator_version: c.generator_version,
    source_run_id: c.source_run_id,
    upload_id: c.upload_id,
    idempotency_key: c.idempotency_key,
    generated_by: c.generated_by,
    blocker_reasons: c.blocker_reasons,
    recommended_action: c.recommended_action,
    candidate_payload: c.candidate_payload,
    lifecycle_status: c.lifecycle_status,
  };
}

export type ClaimIntakeGeneratorBatchResult = {
  source_table: ClaimIntakeGeneratorSourceTable;
  scanned: number;
  built: number;
  skipped_not_claimable: number;
  upserted: number;
  dry_run: boolean;
};

export async function runClaimIntakeGeneratorForTable(args: {
  client: SupabaseClient;
  organizationId: string;
  storeId: string | null;
  sourceTable: ClaimIntakeGeneratorSourceTable;
  limit: number;
  offset: number;
  dryRun: boolean;
  generatedBy: string;
}): Promise<ClaimIntakeGeneratorBatchResult> {
  let q = args.client
    .from(args.sourceTable)
    .select("*")
    .eq("organization_id", args.organizationId)
    .order("id", { ascending: true })
    .range(args.offset, args.offset + args.limit - 1);

  if (args.storeId && args.sourceTable !== "amazon_reimbursements") {
    q = q.eq("store_id", args.storeId);
  } else if (args.storeId && args.sourceTable === "amazon_reimbursements") {
    q = q.eq("store_id", args.storeId);
  }

  const { data, error } = await q;
  if (error) throw new Error(`${args.sourceTable}: ${error.message}`);

  const rows = (data ?? []) as Record<string, unknown>[];
  let built = 0;
  let skipped = 0;
  const inserts: Record<string, unknown>[] = [];

  for (const row of rows) {
    const c = buildIntakeCandidateFromSourceRow(args.sourceTable, row, args.generatedBy);
    if (!c) {
      skipped++;
      continue;
    }
    built++;
    inserts.push(intakeDraftToInsertRow(c));
  }

  let upserted = 0;
  if (!args.dryRun && inserts.length) {
    const { error: upErr } = await args.client.from("claim_candidate_drafts").upsert(inserts, {
      onConflict: "idempotency_key",
      ignoreDuplicates: true,
    });
    if (upErr) throw new Error(`claim_candidate_drafts upsert: ${upErr.message}`);
    upserted = inserts.length;
  } else if (args.dryRun) {
    upserted = 0;
  }

  return {
    source_table: args.sourceTable,
    scanned: rows.length,
    built,
    skipped_not_claimable: skipped,
    upserted: args.dryRun ? 0 : upserted,
    dry_run: args.dryRun,
  };
}

export const CLAIM_INTAKE_IDEMPOTENCY_STRATEGY = {
  key: "claim_candidate_drafts.idempotency_key UNIQUE",
  formula: "sha256(org|source_table|source_row_id|claim_reason) → cl:intake:<hex32>",
  upsert: "ON CONFLICT (idempotency_key) DO NOTHING via ignoreDuplicates",
  no_marketplace_submit: true,
  no_return_items_writes: true,
  no_synthetic_rows: true,
} as const;
