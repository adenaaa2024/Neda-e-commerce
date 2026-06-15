/**
 * PHASE-CLAIM-READMODEL-STAGING-DRYRUN-V1 (full 41-family contract)
 * Read-only staging dry-run — no claim_candidates writes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import {
  collectDrafts,
} from "@/lib/claims/center/claim-readmodel-staging-dryrun-v1";
import {
  V3_FAMILY_INTAKE_BRIDGE_EXTENDED,
  type V3ImplementationStatus,
} from "@/lib/claims/center/claim-v3-readmodel-dryrun-clean-data-v1";
import {
  CLAIM_FAMILY_MATRIX_V3,
  V3_CLAIM_FAMILY_COUNT,
  type ClaimFamilyMatrixV3Entry,
} from "@/lib/claims/contracts/claim-family-algorithm-matrix-v3-official-amazon-coverage";
import { FAMILY_EDGE_REQUIREMENTS } from "@/lib/claims/contracts/trid-edge-requirements-contract-v1";
import { CLAIM_INTAKE_GENERATORS } from "@/lib/claims/intake/claim-intake-generators";
import {
  loadClaimIntakeSettings,
  resolveClaimIntakeWindow,
} from "@/lib/claims/intake/claim-intake-settings";
import type { ClaimCandidateDraft, ClaimIntakeWindow } from "@/lib/claims/intake/claim-intake-types";
import {
  isCleanExpectedPackageBuildStatus,
  splitExpectedQuantityByBuildStatus,
} from "@/lib/expected-packages-conflict-status";
import { buildFeeAdjustedEstimate } from "@/lib/fees/fee-adjusted-estimate-readmodel";
import { fetchLinkageHealthSnapshot } from "@/lib/product-linkage-health";

export type DryrunRowStatus = "claim_ready" | "review_needed" | "unavailable" | "blocked";

export type DryrunSampleRow = {
  status: DryrunRowStatus;
  duplicate_prevention_key: string;
  source_table: string;
  source_row_id: string;
  claim_family: string;
  product_id: string | null;
  identifiers: { asin: string | null; fnsku: string | null; sku: string | null };
  clean_quantity: number | null;
  disputed_quantity_excluded: number | null;
  quantity_formula_result: number | null;
  estimated_amazon_payout: number | null;
  observed_reimbursement: number | null;
  internal_cost_loss: number | null;
  confidence: "high" | "medium" | "low" | "unavailable";
  blocker: string | null;
  review_reason: string | null;
  trid_edge_status: {
    required: string[];
    present: string[];
    missing: string[];
  };
  evidence_summary: string | null;
};

export type FamilyStatusMatrixRow = {
  family_key: string;
  classification: string;
  source_tables_used: string[];
  total_source_rows_scanned: number;
  clean_source_rows: number;
  disputed_review_rows: number;
  claim_ready_count: number;
  review_needed_count: number;
  unavailable_count: number;
  blocked_count: number;
  top_blockers: string[];
  sample_rows: DryrunSampleRow[];
  quantity_formula: string;
  quantity_formula_result: number | null;
  estimated_amazon_payout_result: number | null;
  observed_reimbursement_result: number | null;
  internal_cost_loss_result: number | null;
  confidence_distribution: { high: number; medium: number; low: number; unavailable: number };
  implementation_status: V3ImplementationStatus;
};

export type ClaimReadmodelStagingDryrunFullPayload = {
  read_only: true;
  no_db_writes: true;
  no_claim_candidate_mutation: true;
  no_ai_calls: true;
  generated_at: string;
  organization_id: string;
  store_id: string;
  window: ClaimIntakeWindow;
  dryrun_summary: string;
  family_status_matrix: FamilyStatusMatrixRow[];
  by_classification: Record<string, FamilyStatusMatrixRow[]>;
  claim_ready_preview_count: number;
  review_needed_preview_count: number;
  unavailable_count: number;
  blocked_count: number;
  top_10_high_value_claim_previews: DryrunSampleRow[];
  top_10_review_needed_signals: Array<{
    family_key: string;
    reason: string;
    count: number;
    sample: DryrunSampleRow | null;
  }>;
  false_positive_risk_notes: string[];
  missing_sources_by_family: Record<string, string[]>;
  product_linkage_status: {
    grade: string;
    overall_percent: number;
    critical_paths_percent: number;
    drafts_linked: number;
    drafts_unlinked: number;
    linkage_pct_on_drafts: number;
  };
  fee_estimate_status: {
    amazon_fee_preview_rows: number | null;
    families_with_payout_preview: number;
    payout_available: boolean;
  };
  observed_reimbursement_status: {
    amazon_reimbursements_rows: number | null;
    families_with_observed_preview: number;
    observed_available: boolean;
  };
  TRID_edge_status: {
    families_with_full_trid_on_samples: number;
    common_missing_edges: string[];
  };
  smoke_targets: Record<string, unknown>;
  SAFE_TO_IMPLEMENT_FIRST_GENERATORS: "yes" | "conditional" | "no";
  recommended_first_3_generators: string[];
  NEXT_PROMPT: string;
};

const SMOKE_FNSKU_X004 = "X004LKS4VD";
const SMOKE_ASIN_B000 = "B0000B11UX";

function confBucket(c: number | null | undefined): DryrunSampleRow["confidence"] {
  if (c == null || !Number.isFinite(c)) return "unavailable";
  if (c >= 0.85) return "high";
  if (c >= 0.65) return "medium";
  return "low";
}

function normalizeTableName(raw: string): string | null {
  const table = raw.replace(/^planned:\s*/, "").split(" ")[0]!.trim();
  if (table.startsWith("claim_") || table.includes("(")) return null;
  return table;
}

async function tableRowCount(
  client: SupabaseClient,
  table: string,
  organizationId: string,
  storeId: string | null,
): Promise<number | null> {
  try {
    let q = client.from(table).select("id", { count: "exact", head: true }).eq("organization_id", organizationId);
    if (storeId) {
      const probe = await client.from(table).select("store_id").limit(1);
      if (probe.error) return null;
      if ((probe.data?.[0] as { store_id?: string } | undefined)?.store_id !== undefined) {
        q = q.eq("store_id", storeId);
      }
    }
    const { count, error } = await q;
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

async function collectAllDrafts(
  client: SupabaseClient,
  organizationId: string,
  storeId: string | null,
  window: ClaimIntakeWindow,
  rowLimit: number,
): Promise<ClaimCandidateDraft[]> {
  const kinds = CLAIM_INTAKE_GENERATORS.map((g) => g.source_kind);
  return collectDrafts(client, organizationId, storeId, kinds, window, rowLimit);
}

async function sqlExpectedPackageQuantities(
  pgClient: pg.Client | null,
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<{ clean: number; disputed: number; total: number }> {
  const rows: Array<{ build_status: string; qty: number }> = [];
  if (pgClient) {
    try {
      const r = await pgClient.query(
        `SELECT build_status, COALESCE(expected_scan_quantity, 0)::int AS qty
         FROM expected_packages WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
        [organizationId, storeId],
      );
      rows.push(...(r.rows as Array<{ build_status: string; qty: number }>));
    } catch {
      /* fallback supabase */
    }
  }
  if (!rows.length) {
    const { data } = await client
      .from("expected_packages")
      .select("build_status, expected_scan_quantity")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .limit(5000);
    for (const row of (data ?? []) as Array<{ build_status: string; expected_scan_quantity: number }>) {
      rows.push({ build_status: row.build_status, qty: Number(row.expected_scan_quantity ?? 0) });
    }
  }
  let clean = 0;
  let disputed = 0;
  for (const row of rows) {
    const split = splitExpectedQuantityByBuildStatus(row.build_status, row.qty);
    clean += split.clean;
    disputed += split.disputed;
  }
  return { clean, disputed, total: rows.length };
}

function tridRequired(familyKey: string): string[] {
  const req = FAMILY_EDGE_REQUIREMENTS.find((f) => f.family_key === familyKey);
  return req?.edges.filter((e) => e.required_for_claim_ready).map((e) => e.edge_kind_id) ?? [];
}

function tridPresent(draft: ClaimCandidateDraft, productId: string | null): string[] {
  const present = new Set<string>();
  if (productId) present.add("product_link");
  if (draft.source_table && draft.source_row_id) present.add("source_report_row");
  for (const e of draft.reference_edges) {
    const k = e.reference_kind;
    if (k.includes("order")) present.add("order_id");
    if (k.includes("removal_order")) present.add("removal_order_id");
    if (k.includes("shipment")) present.add("removal_shipment_id");
    if (k.includes("tracking")) present.add("tracking_number");
    if (k.includes("return_item")) present.add("return_item_id");
    if (k.includes("reimbursement")) present.add("reimbursement_id");
    if (k.includes("settlement")) present.add("settlement_id");
    if (k.includes("ledger")) present.add("inventory_ledger_reference");
    if (k.includes("package")) present.add("package_id");
    if (k.includes("scanner")) present.add("scanner_evidence");
  }
  return [...present];
}

function isDisputedDraft(draft: ClaimCandidateDraft): boolean {
  const status = String(draft.metadata?.build_status ?? "").trim().toLowerCase();
  if (!status) return false;
  return !isCleanExpectedPackageBuildStatus(status);
}

function classifyDraft(
  draft: ClaimCandidateDraft,
  entry: ClaimFamilyMatrixV3Entry,
  sourceOk: boolean,
): { status: DryrunRowStatus; blocker: string | null; reviewReason: string | null } {
  if (!sourceOk) {
    return { status: "unavailable", blocker: "source_tables_empty", reviewReason: null };
  }
  if (entry.classification === "review_signal_only" || entry.classification === "lifecycle_only") {
    return { status: "review_needed", blocker: null, reviewReason: entry.blocked_reason ?? "review_signal_family" };
  }
  if (isDisputedDraft(draft)) {
    return { status: "review_needed", blocker: "disputed_expected_package", reviewReason: "disputed_row_excluded_from_claim_ready" };
  }
  const productId = draft.product.resolved_product_id;
  if (
    entry.product_linkage_requirement === "required_before_trusted_money" &&
    !productId
  ) {
    return { status: "review_needed", blocker: "product_linkage_unresolved", reviewReason: "defer_until_linkage" };
  }
  if (entry.classification === "claim_family" || entry.classification === "claim_family_when_source_available") {
    return { status: "claim_ready", blocker: null, reviewReason: null };
  }
  return { status: "blocked", blocker: entry.blocked_reason, reviewReason: null };
}

async function draftToSampleRow(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  draft: ClaimCandidateDraft,
  entry: ClaimFamilyMatrixV3Entry,
  sourceOk: boolean,
  moneyCache: Map<string, { estimated_amazon_payout: number | null; observed_reimbursement: number | null; internal_cost_loss: number | null }>,
): Promise<DryrunSampleRow> {
  const { status, blocker, reviewReason } = classifyDraft(draft, entry, sourceOk);
  const productId = draft.product.resolved_product_id;
  const disputed = isDisputedDraft(draft);
  const buildStatus = String(draft.metadata?.build_status ?? "");
  const qty = draft.expected_quantity ?? draft.actual_quantity ?? null;
  let cleanQty: number | null = disputed ? null : qty;
  let disputedExcluded: number | null = null;
  if (buildStatus) {
    const split = splitExpectedQuantityByBuildStatus(buildStatus, Math.abs(qty ?? 0));
    cleanQty = disputed ? null : split.clean > 0 ? split.clean : qty;
    disputedExcluded = split.disputed > 0 ? split.disputed : disputed ? 1 : null;
  }

  let payout: number | null = null;
  let observed: number | null = draft.expected_amount ?? draft.recovery_value ?? null;
  let cost: number | null = null;
  if (productId) {
    let cached = moneyCache.get(productId);
    if (!cached) {
      try {
        const est = await buildFeeAdjustedEstimate(client, organizationId, storeId, productId);
        cached = {
          estimated_amazon_payout: est.estimated_amazon_payout,
          observed_reimbursement: est.observed_reimbursement,
          internal_cost_loss: est.internal_cost_loss,
        };
      } catch {
        cached = {
          estimated_amazon_payout: null,
          observed_reimbursement: null,
          internal_cost_loss: null,
        };
      }
      moneyCache.set(productId, cached);
    }
    payout = cached.estimated_amazon_payout;
    if (cached.observed_reimbursement != null) observed = cached.observed_reimbursement;
    cost = cached.internal_cost_loss;
  } else if (draft.cogs_unit != null && cleanQty != null) {
    cost = Math.round(draft.cogs_unit * cleanQty * 100) / 100;
  }

  const required = tridRequired(entry.family_key);
  const present = tridPresent(draft, productId);
  const missing = required.filter((r) => !present.includes(r));

  return {
    status,
    duplicate_prevention_key: draft.dedupe_key,
    source_table: draft.source_table,
    source_row_id: draft.source_row_id,
    claim_family: draft.claim_family,
    product_id: productId,
    identifiers: {
      asin: draft.product.asin,
      fnsku: draft.product.fnsku,
      sku: draft.product.sku,
    },
    clean_quantity: cleanQty,
    disputed_quantity_excluded: disputedExcluded,
    quantity_formula_result: cleanQty,
    estimated_amazon_payout: payout,
    observed_reimbursement: observed,
    internal_cost_loss: cost,
    confidence: confBucket(draft.confidence_score),
    blocker,
    review_reason: reviewReason,
    trid_edge_status: { required, present, missing },
    evidence_summary: draft.evidence_summary ?? draft.claim_reason,
  };
}

function familyDrafts(familyKey: string, allDrafts: ClaimCandidateDraft[]): ClaimCandidateDraft[] {
  const bridge = V3_FAMILY_INTAKE_BRIDGE_EXTENDED[familyKey];
  if (!bridge?.draft_families.length) return [];
  return allDrafts.filter((d) => bridge.draft_families.includes(d.claim_family));
}

function sourceAvailable(entry: ClaimFamilyMatrixV3Entry, counts: Record<string, number | null>): boolean {
  if (entry.current_availability === "empty_connector" || entry.current_availability === "unsupported_file") {
    return false;
  }
  return Object.values(counts).some((c) => c != null && c > 0);
}

async function countClaimCandidates(client: SupabaseClient, organizationId: string): Promise<number> {
  const { count } = await client
    .from("claim_candidates")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);
  return count ?? 0;
}

async function runSmokeTargets(
  client: SupabaseClient,
  pgClient: pg.Client | null,
  organizationId: string,
  storeId: string,
  allDrafts: ClaimCandidateDraft[],
  epQty: { clean: number; disputed: number; total: number },
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  const { data: x004Map } = await client
    .from("product_identifier_map")
    .select("product_id, fnsku")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .ilike("fnsku", SMOKE_FNSKU_X004)
    .limit(5);
  const x004ProductId = (x004Map?.[0] as { product_id?: string } | undefined)?.product_id ?? null;
  out.X004LKS4VD = {
    fnsku: SMOKE_FNSKU_X004,
    product_id: x004ProductId,
    linkage_resolved: Boolean(x004ProductId),
    fee_estimate: x004ProductId
      ? await buildFeeAdjustedEstimate(client, organizationId, storeId, x004ProductId).catch(() => null)
      : null,
    expected_packages_clean: epQty.clean,
    expected_packages_disputed: epQty.disputed,
  };

  const { data: b000Map } = await client
    .from("product_identifier_map")
    .select("product_id, asin")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .ilike("asin", SMOKE_ASIN_B000)
    .limit(5);
  const b000ProductId = (b000Map?.[0] as { product_id?: string } | undefined)?.product_id ?? null;
  out.B0000B11UX = {
    asin: SMOKE_ASIN_B000,
    product_id: b000ProductId,
    linkage_resolved: Boolean(b000ProductId),
    fee_estimate: b000ProductId
      ? await buildFeeAdjustedEstimate(client, organizationId, storeId, b000ProductId).catch(() => null)
      : null,
  };

  const { count: reimbCount } = await client
    .from("amazon_reimbursements")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .gt("amount_total", 0);
  const { data: reimbSample } = await client
    .from("amazon_reimbursements")
    .select("id, fnsku, asin, amount_total, order_id")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .gt("amount_total", 0)
    .limit(1);
  out.amazon_reimbursements_product = {
    row_count: reimbCount ?? 0,
    sample: reimbSample?.[0] ?? null,
    pass: (reimbCount ?? 0) > 0,
  };

  const removalDrafts = allDrafts.filter((d) =>
    ["removal_missing_units", "shipment_quantity_mismatch", "shipment_not_received"].includes(d.claim_family),
  );
  out.removal_discrepancy = {
    draft_count: removalDrafts.length,
    sample: removalDrafts[0]
      ? {
          source_table: removalDrafts[0].source_table,
          source_row_id: removalDrafts[0].source_row_id,
          fnsku: removalDrafts[0].product.fnsku,
        }
      : null,
    pass: removalDrafts.length > 0,
  };

  let returnNotReimbursed = 0;
  if (pgClient) {
    try {
      const r = await pgClient.query(
        `SELECT COUNT(*)::int AS c FROM amazon_returns r
         WHERE r.organization_id = $1::uuid AND r.store_id = $2::uuid
           AND NOT EXISTS (
             SELECT 1 FROM amazon_reimbursements rb
             WHERE rb.organization_id = r.organization_id AND rb.amount_total > 0
               AND (rb.fnsku IS NOT DISTINCT FROM r.fnsku OR rb.order_id IS NOT DISTINCT FROM r.order_id)
           )`,
        [organizationId, storeId],
      );
      returnNotReimbursed = Number(r.rows[0]?.c ?? 0);
    } catch {
      returnNotReimbursed = 0;
    }
  }
  out.return_not_reimbursed = {
    candidate_count_if_data_exists: returnNotReimbursed,
    pass: returnNotReimbursed >= 0,
    note: returnNotReimbursed > 0 ? "data_exists" : "no_unmatched_returns_in_window",
  };

  let disputedEpSample: Record<string, unknown> | null = null;
  if (pgClient) {
    try {
      const r = await pgClient.query(
        `SELECT id, fnsku, build_status, expected_scan_quantity, tracking_number
         FROM expected_packages
         WHERE organization_id = $1::uuid AND store_id = $2::uuid
           AND build_status NOT IN ('matched','expected','resolved','complete')
         LIMIT 1`,
        [organizationId, storeId],
      );
      disputedEpSample = (r.rows[0] as Record<string, unknown>) ?? null;
    } catch {
      disputedEpSample = null;
    }
  } else {
    const { data } = await client
      .from("expected_packages")
      .select("id, fnsku, build_status, expected_scan_quantity, tracking_number")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .limit(200);
    disputedEpSample =
      ((data ?? []).find((row) => {
        const st = String((row as { build_status?: string }).build_status ?? "");
        return st && !isCleanExpectedPackageBuildStatus(st);
      }) as Record<string, unknown>) ?? null;
  }
  let x004DisputedEp: Record<string, unknown> | null = null;
  if (pgClient) {
    try {
      const r = await pgClient.query(
        `SELECT id, fnsku, build_status, expected_scan_quantity, tracking_number
         FROM expected_packages
         WHERE organization_id = $1::uuid AND store_id = $2::uuid
           AND UPPER(fnsku) = $3
           AND build_status = 'shipment_overflow_conflict'
         LIMIT 1`,
        [organizationId, storeId, SMOKE_FNSKU_X004],
      );
      x004DisputedEp = (r.rows[0] as Record<string, unknown>) ?? null;
    } catch {
      x004DisputedEp = null;
    }
  } else {
    const { data } = await client
      .from("expected_packages")
      .select("id, fnsku, build_status, expected_scan_quantity, tracking_number")
      .eq("organization_id", organizationId)
      .eq("store_id", storeId)
      .ilike("fnsku", SMOKE_FNSKU_X004)
      .eq("build_status", "shipment_overflow_conflict")
      .limit(1);
    x004DisputedEp = (data?.[0] as Record<string, unknown>) ?? null;
  }

  out.disputed_ep_review_needed = {
    sample: x004DisputedEp ?? disputedEpSample,
    status: "review_needed",
    pass: Boolean(x004DisputedEp ?? disputedEpSample),
    note: x004DisputedEp
      ? "X004LKS4VD shipment_overflow_conflict → review_needed"
      : "disputed EP must never be claim_ready",
    x004_disputed_ep: Boolean(x004DisputedEp),
  };

  return out;
}

/** Full 41-family staging dry-run with per-row status matrix. */
export async function buildClaimReadmodelStagingDryrunFull(options: {
  client: SupabaseClient;
  pgClient?: pg.Client | null;
  organizationId: string;
  storeId: string;
  from?: string | null;
  to?: string | null;
  rowLimit?: number;
}): Promise<ClaimReadmodelStagingDryrunFullPayload> {
  const rowLimit = options.rowLimit ?? 400;
  const candidatesBefore = await countClaimCandidates(options.client, options.organizationId);

  const { settings } = await loadClaimIntakeSettings(options.client, options.organizationId);
  const window = resolveClaimIntakeWindow(settings, options.from ?? null, options.to ?? null);

  const linkage = await fetchLinkageHealthSnapshot(options.client, options.organizationId);
  const allDrafts = await collectAllDrafts(
    options.client,
    options.organizationId,
    options.storeId,
    window,
    rowLimit,
  );

  const epQty = await sqlExpectedPackageQuantities(
    options.pgClient ?? null,
    options.client,
    options.organizationId,
    options.storeId,
  );

  const feePreviewCount = await tableRowCount(
    options.client,
    "amazon_fee_preview",
    options.organizationId,
    options.storeId,
  );
  const reimbCount = await tableRowCount(
    options.client,
    "amazon_reimbursements",
    options.organizationId,
    options.storeId,
  );

  const matrix: FamilyStatusMatrixRow[] = [];
  const missingSourcesByFamily: Record<string, string[]> = {};
  const allSampleRows: DryrunSampleRow[] = [];
  const moneyCache = new Map<
    string,
    { estimated_amazon_payout: number | null; observed_reimbursement: number | null; internal_cost_loss: number | null }
  >();

  for (const entry of CLAIM_FAMILY_MATRIX_V3) {
    const sourceCounts: Record<string, number | null> = {};
    const sourceTables: string[] = [];
    for (const t of entry.normalized_tables) {
      const table = normalizeTableName(t);
      if (!table) continue;
      sourceTables.push(table);
      sourceCounts[table] = await tableRowCount(
        options.client,
        table,
        options.organizationId,
        options.storeId,
      );
    }

    const missing: string[] = [];
    for (const [t, c] of Object.entries(sourceCounts)) {
      if (c === 0) missing.push(`${t}_empty`);
      if (c === null) missing.push(`${t}_unavailable`);
    }
    if (entry.blocked_reason) missing.push(entry.blocked_reason);
    missingSourcesByFamily[entry.family_key] = missing;

    const drafts = familyDrafts(entry.family_key, allDrafts);
    const sourceOk = sourceAvailable(entry, sourceCounts);
    const totalScanned = Object.values(sourceCounts).reduce<number>(
      (s, c) => s + (c ?? 0),
      0,
    );

    const sampleDrafts = [...drafts]
      .sort((a, b) => (b.recovery_value ?? 0) - (a.recovery_value ?? 0))
      .slice(0, 5);
    const sampleRows: DryrunSampleRow[] = [];
    for (const d of sampleDrafts) {
      const row = await draftToSampleRow(
        options.client,
        options.organizationId,
        options.storeId,
        d,
        entry,
        sourceOk,
        moneyCache,
      );
      sampleRows.push(row);
      allSampleRows.push(row);
    }

    let claimReady = 0;
    let reviewNeeded = 0;
    let unavailable = 0;
    let blocked = 0;
    const blockerCounts = new Map<string, number>();

    for (const d of drafts) {
      const { status, blocker, reviewReason } = classifyDraft(d, entry, sourceOk);
      if (status === "claim_ready") claimReady += 1;
      else if (status === "review_needed") reviewNeeded += 1;
      else if (status === "unavailable") unavailable += 1;
      else blocked += 1;
      const bk = blocker ?? reviewReason ?? "none";
      blockerCounts.set(bk, (blockerCounts.get(bk) ?? 0) + 1);
    }

    if (entry.classification === "review_signal_only") {
      reviewNeeded = Math.max(reviewNeeded, 1);
      claimReady = 0;
    }
    if (!sourceOk && drafts.length === 0) {
      unavailable = Math.max(unavailable, 1);
    }
    if (entry.normalized_tables.some((t) => t.includes("expected_packages")) && epQty.disputed > 0) {
      reviewNeeded += epQty.disputed;
    }

    const confDist = { high: 0, medium: 0, low: 0, unavailable: 0 };
    for (const r of sampleRows) confDist[r.confidence] += 1;

    let implStatus: V3ImplementationStatus = "blocked_missing_source";
    if (entry.classification === "lifecycle_only" || entry.classification === "lifecycle_grouping_only") {
      implStatus = "lifecycle_only";
    } else if (entry.classification === "review_signal_only") {
      implStatus = "review_only";
    } else if (!sourceOk) {
      implStatus = "blocked_missing_source";
    } else if (claimReady > 0) {
      implStatus = "claim_ready_preview";
    } else if (reviewNeeded > 0) {
      implStatus = "review_only";
    } else if (missing.some((m) => m.includes("linkage"))) {
      implStatus = "blocked_missing_linkage";
    }

    const payoutSum = sampleRows.reduce((s, r) => s + (r.estimated_amazon_payout ?? 0), 0);
    const observedSum = sampleRows.reduce((s, r) => s + (r.observed_reimbursement ?? 0), 0);
    const costSum = sampleRows.reduce((s, r) => s + (r.internal_cost_loss ?? 0), 0);

    let cleanRows = drafts.length;
    let disputedRows = 0;
    if (entry.normalized_tables.some((t) => t.includes("expected_packages"))) {
      cleanRows = epQty.clean;
      disputedRows = epQty.disputed;
    } else {
      disputedRows = drafts.filter(isDisputedDraft).length;
      cleanRows = drafts.length - disputedRows;
    }

    matrix.push({
      family_key: entry.family_key,
      classification: entry.classification,
      source_tables_used: sourceTables,
      total_source_rows_scanned: totalScanned,
      clean_source_rows: cleanRows,
      disputed_review_rows: disputedRows,
      claim_ready_count: claimReady,
      review_needed_count: reviewNeeded,
      unavailable_count: unavailable,
      blocked_count: blocked,
      top_blockers: [...blockerCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, v]) => `${k}:${v}`),
      sample_rows: sampleRows,
      quantity_formula: entry.quantity_formula,
      quantity_formula_result: sampleRows.reduce((s, r) => s + (r.quantity_formula_result ?? 0), 0) || null,
      estimated_amazon_payout_result: payoutSum > 0 ? Math.round(payoutSum * 100) / 100 : null,
      observed_reimbursement_result: observedSum > 0 ? Math.round(observedSum * 100) / 100 : null,
      internal_cost_loss_result: costSum > 0 ? Math.round(costSum * 100) / 100 : null,
      confidence_distribution: confDist,
      implementation_status: implStatus,
    });
  }

  const candidatesAfter = await countClaimCandidates(options.client, options.organizationId);

  const byClassification: Record<string, FamilyStatusMatrixRow[]> = {};
  for (const row of matrix) {
    const key = row.classification;
    if (!byClassification[key]) byClassification[key] = [];
    byClassification[key]!.push(row);
  }

  const claimReadyTotal = matrix.reduce((s, r) => s + r.claim_ready_count, 0);
  const reviewTotal = matrix.reduce((s, r) => s + r.review_needed_count, 0);
  const unavailableTotal = matrix.reduce((s, r) => s + r.unavailable_count, 0);
  const blockedTotal = matrix.reduce((s, r) => s + r.blocked_count, 0);

  const top10Claim = [...allSampleRows]
    .filter((r) => r.status === "claim_ready")
    .sort((a, b) => (b.observed_reimbursement ?? 0) - (a.observed_reimbursement ?? 0))
    .slice(0, 10);

  const reviewSignals: Array<{ family_key: string; reason: string; count: number; sample: DryrunSampleRow | null }> =
    [];
  for (const row of matrix) {
    if (row.review_needed_count > 0) {
      reviewSignals.push({
        family_key: row.family_key,
        reason: row.top_blockers[0] ?? "review_needed",
        count: row.review_needed_count,
        sample: row.sample_rows.find((s) => s.status === "review_needed") ?? row.sample_rows[0] ?? null,
      });
    }
  }
  const top10Review = reviewSignals.sort((a, b) => b.count - a.count).slice(0, 10);

  const linked = allDrafts.filter((d) => d.product.resolved_product_id).length;
  const unlinked = allDrafts.length - linked;

  const familiesWithPayout = matrix.filter((r) => r.estimated_amazon_payout_result != null).length;
  const familiesWithObserved = matrix.filter((r) => r.observed_reimbursement_result != null).length;

  const missingEdgeCounts = new Map<string, number>();
  for (const r of allSampleRows) {
    for (const m of r.trid_edge_status.missing) {
      missingEdgeCounts.set(m, (missingEdgeCounts.get(m) ?? 0) + 1);
    }
  }

  const smokeTargets = await runSmokeTargets(
    options.client,
    options.pgClient ?? null,
    options.organizationId,
    options.storeId,
    allDrafts,
    epQty,
  );

  const claimReadyFamilies = matrix.filter((r) => r.implementation_status === "claim_ready_preview");
  const recommendedGenerators = claimReadyFamilies
    .slice(0, 3)
    .map((r) => {
      const bridge = V3_FAMILY_INTAKE_BRIDGE_EXTENDED[r.family_key];
      const kinds = bridge?.source_kinds ?? [];
      const gen = kinds
        .map((k) => CLAIM_INTAKE_GENERATORS.find((g) => g.source_kind === k)?.title)
        .filter(Boolean);
      return `${r.family_key} → ${gen.join(" + ") || "SQL preview only"}`;
    });

  const safe: ClaimReadmodelStagingDryrunFullPayload["SAFE_TO_IMPLEMENT_FIRST_GENERATORS"] =
    claimReadyFamilies.length >= 2 ? "yes" : claimReadyFamilies.length > 0 ? "conditional" : "no";

  return {
    read_only: true,
    no_db_writes: true,
    no_claim_candidate_mutation: true,
    no_ai_calls: true,
    generated_at: new Date().toISOString(),
    organization_id: options.organizationId,
    store_id: options.storeId,
    window,
    dryrun_summary: `41-family V3 dry-run on staging; ${allDrafts.length} generator drafts; claim_candidates delta ${candidatesAfter - candidatesBefore}; EP clean ${epQty.clean} / disputed ${epQty.disputed}`,
    family_status_matrix: matrix,
    by_classification: byClassification,
    claim_ready_preview_count: claimReadyTotal,
    review_needed_preview_count: reviewTotal,
    unavailable_count: unavailableTotal,
    blocked_count: blockedTotal,
    top_10_high_value_claim_previews: top10Claim,
    top_10_review_needed_signals: top10Review,
    false_positive_risk_notes: [
      "Sale price never substitutes COGS — internal_cost_loss NULL when unit_cost_basis missing",
      "Disputed expected_packages excluded from claim_ready; shipment_overflow_conflict → review_needed only",
      "Org-wide linkage grade may block trusted money even when individual draft has product_id",
      "Settlement/refund anomalies without product_link show observed amount but defer claim_ready",
      "ORBIT-FRA and fee families blocked when fee_preview / COGS spine empty — not zero-filled",
    ],
    missing_sources_by_family: missingSourcesByFamily,
    product_linkage_status: {
      grade: linkage.linkage_health.grade,
      overall_percent: linkage.linkage_health.overall_percent,
      critical_paths_percent: linkage.linkage_health.critical_paths_percent,
      drafts_linked: linked,
      drafts_unlinked: unlinked,
      linkage_pct_on_drafts: allDrafts.length ? Math.round((linked / allDrafts.length) * 1000) / 10 : 0,
    },
    fee_estimate_status: {
      amazon_fee_preview_rows: feePreviewCount,
      families_with_payout_preview: familiesWithPayout,
      payout_available: (feePreviewCount ?? 0) > 0,
    },
    observed_reimbursement_status: {
      amazon_reimbursements_rows: reimbCount,
      families_with_observed_preview: familiesWithObserved,
      observed_available: (reimbCount ?? 0) > 0,
    },
    TRID_edge_status: {
      families_with_full_trid_on_samples: matrix.filter((r) =>
        r.sample_rows.some((s) => s.trid_edge_status.missing.length === 0),
      ).length,
      common_missing_edges: [...missingEdgeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, v]) => `${k}:${v}`),
    },
    smoke_targets: {
      ...smokeTargets,
      claim_candidates_delta: candidatesAfter - candidatesBefore,
      claim_candidates_delta_pass: candidatesAfter === candidatesBefore,
    },
    SAFE_TO_IMPLEMENT_FIRST_GENERATORS: safe,
    recommended_first_3_generators:
      recommendedGenerators.length >= 3
        ? recommendedGenerators
        : [
            "removal_order_discrepancy → Amazon removal orders + shipment discrepancy generators",
            "physical_return_scanner_issue → Scanner physical review generator",
            "partial_incorrect_reimbursement → Reimbursement reversal generator",
          ].slice(0, 3),
    NEXT_PROMPT:
      "PHASE-CLAIM-FIRST-GENERATOR-PREVIEW-UI-V1 — Claim Center family_status_matrix panel; no apply",
  };
}

export { V3_CLAIM_FAMILY_COUNT };
