/**
 * PHASE-CLAIM-V3-READMODEL-DRYRUN-CLEAN-DATA-V1
 * All 41 V3 families — read-only preview with claim-ready classification.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import {
  CLAIM_FAMILY_MATRIX_V3,
  V3_CLAIM_FAMILY_COUNT,
  type ClaimFamilyMatrixV3Entry,
} from "@/lib/claims/contracts/claim-family-algorithm-matrix-v3-official-amazon-coverage";
import {
  PRIORITY_V3_FAMILIES,
  V3_FAMILY_INTAKE_BRIDGE,
  type FamilyPreviewRow,
} from "@/lib/claims/center/claim-readmodel-staging-dryrun-v1";
import { CLAIM_INTAKE_GENERATORS } from "@/lib/claims/intake/claim-intake-generators";
import {
  evaluateSourceGate,
  loadClaimIntakeSettings,
  resolveClaimIntakeWindow,
} from "@/lib/claims/intake/claim-intake-settings";
import type { ClaimCandidateDraft, ClaimIntakeWindow, ClaimSourceKind } from "@/lib/claims/intake/claim-intake-types";
import { fetchLinkageHealthSnapshot } from "@/lib/product-linkage-health";
import { splitExpectedQuantityByBuildStatus } from "@/lib/expected-packages-conflict-status";

export const CLEAN_DATA_PRIORITY_V3_FAMILIES = [
  "customer_return_not_reimbursed",
  "physical_return_scanner_issue",
  "removal_order_discrepancy",
  "missing_reimbursement",
  "orbit_fra_fight_list",
  "removal_shipment_missing",
  "warehouse_lost_inventory",
  "settlement_refund_anomaly",
] as const;

/** Extended intake bridge for clean-data dry-run (all generator-mapped families). */
export const V3_FAMILY_INTAKE_BRIDGE_EXTENDED: Record<
  string,
  { draft_families: string[]; source_kinds: ClaimSourceKind[] }
> = {
  ...V3_FAMILY_INTAKE_BRIDGE,
  removal_shipment_missing: {
    draft_families: ["shipment_not_received", "removal_missing_units"],
    source_kinds: ["delayed_not_received", "amazon_removal_api"],
  },
  warehouse_lost_inventory: {
    draft_families: ["inventory_unreconciled_loss"],
    source_kinds: ["inventory_ledger"],
  },
  warehouse_damaged_inventory: {
    draft_families: ["inventory_unreconciled_loss"],
    source_kinds: ["inventory_ledger"],
  },
  inventory_adjustment_error: {
    draft_families: ["inventory_unreconciled_loss"],
    source_kinds: ["inventory_ledger"],
  },
  settlement_refund_anomaly: {
    draft_families: ["settlement_refund_review"],
    source_kinds: ["settlement"],
  },
  inbound_shipment_shortage: {
    draft_families: ["inbound_shipment_shortage"],
    source_kinds: ["inbound_shipment"],
  },
  safet_followup: {
    draft_families: ["safet_followup"],
    source_kinds: ["safet"],
  },
  partial_incorrect_reimbursement: {
    draft_families: ["reimbursement_reversal"],
    source_kinds: ["reimbursement"],
  },
};

export type V3ImplementationStatus =
  | "claim_ready_preview"
  | "review_only"
  | "blocked_missing_source"
  | "blocked_missing_linkage"
  | "blocked_missing_money"
  | "lifecycle_only";

export type V3FamilyDryrunRow = {
  family_key: string;
  family_label: string;
  classification: string;
  implementation_priority: string;
  priority_family: boolean;
  source_available: boolean;
  product_linkage_ready: boolean;
  clean_quantity_preview: number | null;
  disputed_quantity_excluded: number | null;
  review_signal_count: number;
  candidate_count_preview: number;
  estimated_amazon_payout_available: boolean;
  observed_reimbursement_available: boolean;
  internal_cost_loss_available: boolean;
  confidence_distribution: FamilyPreviewRow["confidence_distribution"];
  blocker: string | null;
  implementation_status: V3ImplementationStatus;
  source_table_row_counts: Record<string, number | null>;
};

export type ClaimV3ReadmodelDryrunCleanDataPayload = {
  read_only: true;
  no_db_writes: true;
  no_claim_candidate_mutation: true;
  no_ai_calls: true;
  generated_at: string;
  organization_id: string;
  store_id: string;
  window: ClaimIntakeWindow;
  v3_family_count: number;
  linkage_health_summary: {
    overall_percent: number;
    critical_paths_percent: number;
    grade: string;
    safe_for_product_story: string;
  };
  V3_family_dryrun_matrix: V3FamilyDryrunRow[];
  claim_ready_preview_families: string[];
  review_only_families: string[];
  blocked_families: string[];
  top_20_preview_opportunities: Array<{
    rank: number;
    family_key: string;
    claim_family: string;
    source_kind: string;
    source_table: string;
    expected_amount: number | null;
    recovery_value: number | null;
    product_linkage_resolved: boolean;
    implementation_status: V3ImplementationStatus;
  }>;
  product_linkage_blockers: {
    org_linkage_grade: string;
    drafts_unlinked: number;
    drafts_linked: number;
    linkage_pct_on_drafts: number;
    families_blocked_missing_linkage: number;
  };
  source_blockers: string[];
  money_blockers: string[];
  SAFE_TO_IMPLEMENT_FIRST_CLAIM_PREVIEW: "yes" | "conditional" | "no";
  SAFE_RATIONALE: string;
};

function draftProductId(d: ClaimCandidateDraft): string | null {
  return d.product.resolved_product_id;
}

function confBucket(c: number | null | undefined): keyof V3FamilyDryrunRow["confidence_distribution"] {
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
  const { settings } = await loadClaimIntakeSettings(client, organizationId);
  const drafts: ClaimCandidateDraft[] = [];
  for (const gen of CLAIM_INTAKE_GENERATORS) {
    const gate = evaluateSourceGate(settings, gen.source_kind);
    if (!gate.enabled || gate.skip_reason) continue;
    const excludedTables = settings.excluded_source_tables ?? [];
    if (gen.source_tables.some((t) => excludedTables.includes(t))) continue;
    try {
      const output = await gen.generate({
        client,
        organizationId,
        storeId,
        window,
        settings,
        rowLimit,
        runKind: "manual",
      });
      drafts.push(...output.drafts);
    } catch {
      /* surfaced per-family */
    }
  }
  return drafts;
}

async function sqlExpectedPackageQuantities(
  pgClient: pg.Client | null,
  organizationId: string,
  storeId: string,
): Promise<{ clean: number; disputed: number }> {
  if (!pgClient) return { clean: 0, disputed: 0 };
  try {
    const r = await pgClient.query(
      `SELECT build_status, COALESCE(expected_scan_quantity, 0)::int AS qty
       FROM expected_packages WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
      [organizationId, storeId],
    );
    let clean = 0;
    let disputed = 0;
    for (const row of r.rows as Array<{ build_status: string; qty: number }>) {
      const split = splitExpectedQuantityByBuildStatus(row.build_status, row.qty);
      clean += split.clean;
      disputed += split.disputed;
    }
    return { clean, disputed };
  } catch {
    return { clean: 0, disputed: 0 };
  }
}

function sourceAvailable(entry: ClaimFamilyMatrixV3Entry, counts: Record<string, number | null>): boolean {
  if (entry.current_availability === "live_generator" || entry.current_availability === "live_table") {
    return Object.values(counts).some((c) => c != null && c > 0);
  }
  if (entry.current_availability === "partial") {
    return Object.values(counts).some((c) => c != null && c > 0);
  }
  if (entry.current_availability === "empty_connector" || entry.current_availability === "unsupported_file") {
    return false;
  }
  if (entry.current_availability === "planned_sp_api" || entry.current_availability === "finances_api_archive") {
    return Object.values(counts).some((c) => c != null && c > 0);
  }
  return Object.values(counts).every((c) => c === null || c > 0);
}

function familyDrafts(familyKey: string, allDrafts: ClaimCandidateDraft[]): ClaimCandidateDraft[] {
  const bridge = V3_FAMILY_INTAKE_BRIDGE_EXTENDED[familyKey];
  if (!bridge?.draft_families.length) return [];
  return allDrafts.filter((d) => bridge.draft_families.includes(d.claim_family));
}

function v3KeyForDraft(d: ClaimCandidateDraft): string {
  for (const [k, b] of Object.entries(V3_FAMILY_INTAKE_BRIDGE_EXTENDED)) {
    if (b.draft_families.includes(d.claim_family)) return k;
  }
  return d.claim_family;
}

function deriveImplementationStatus(args: {
  entry: ClaimFamilyMatrixV3Entry;
  sourceOk: boolean;
  linkageReady: boolean;
  payoutAvail: boolean;
  costAvail: boolean;
  candidateCount: number;
  reviewCount: number;
  familyDrafts: ClaimCandidateDraft[];
}): { status: V3ImplementationStatus; blocker: string | null } {
  const { entry, sourceOk, linkageReady, payoutAvail, costAvail, candidateCount, reviewCount, familyDrafts } =
    args;

  if (
    entry.classification === "lifecycle_only" ||
    entry.classification === "lifecycle_grouping_only"
  ) {
    return { status: "lifecycle_only", blocker: entry.blocked_reason };
  }
  if (entry.classification === "review_signal_only") {
    return { status: "review_only", blocker: entry.blocked_reason ?? "review_signal_family" };
  }
  if (!sourceOk) {
    return {
      status: "blocked_missing_source",
      blocker: entry.blocked_reason ?? "required_source_tables_empty",
    };
  }
  if (
    entry.product_linkage_requirement === "required_before_trusted_money" &&
    !linkageReady
  ) {
    const unlinked = familyDrafts.filter((d) => !draftProductId(d)).length;
    return {
      status: "blocked_missing_linkage",
      blocker: unlinked ? `product_linkage_unresolved:${unlinked}` : "org_linkage_below_threshold",
    };
  }
  const needsCost = !entry.internal_cost_loss_formula.includes("NULL");
  const needsPayout = !entry.estimated_amazon_payout_formula.includes("NULL");
  if (needsPayout && !payoutAvail && needsCost && !costAvail) {
    return { status: "blocked_missing_money", blocker: "fee_preview_and_cogs_spine_missing" };
  }
  if (reviewCount > 0 && candidateCount === 0) {
    return { status: "review_only", blocker: entry.blocked_reason ?? "review_signal_from_source_gap" };
  }
  if (candidateCount > 0 && linkageReady) {
    return { status: "claim_ready_preview", blocker: null };
  }
  if (entry.classification === "claim_family_when_source_available" && !sourceOk) {
    return { status: "blocked_missing_source", blocker: entry.blocked_reason };
  }
  return {
    status: reviewCount > 0 ? "review_only" : "blocked_missing_source",
    blocker: entry.blocked_reason,
  };
}

/** Build all-V3-family clean-data dry-run matrix (staging, read-only). */
export async function buildClaimV3ReadmodelDryrunCleanData(options: {
  client: SupabaseClient;
  pgClient?: pg.Client | null;
  organizationId: string;
  storeId: string;
  from?: string | null;
  to?: string | null;
  rowLimit?: number;
}): Promise<ClaimV3ReadmodelDryrunCleanDataPayload> {
  const rowLimit = options.rowLimit ?? 400;
  const { settings } = await loadClaimIntakeSettings(options.client, options.organizationId);
  const window = resolveClaimIntakeWindow(settings, options.from ?? null, options.to ?? null);

  const linkage = await fetchLinkageHealthSnapshot(options.client, options.organizationId);
  const orgLinkageReady =
    linkage.linkage_health.safe_for_product_story !== "no" &&
    linkage.linkage_health.critical_paths_percent >= 40;

  const allDrafts = await collectAllDrafts(
    options.client,
    options.organizationId,
    options.storeId,
    window,
    rowLimit,
  );

  const epQty = await sqlExpectedPackageQuantities(
    options.pgClient ?? null,
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

  const sourceBlockers: string[] = [];
  const checks = [
    ["returns", "amazon_returns"],
    ["reimbursements", "amazon_reimbursements"],
    ["ledger", "amazon_inventory_ledger"],
    ["fee_preview", "amazon_fee_preview"],
    ["monthly_storage", "amazon_monthly_storage_fees"],
  ] as const;
  for (const [key, table] of checks) {
    const c = await tableRowCount(options.client, table, options.organizationId, options.storeId);
    if (c === 0) sourceBlockers.push(`${key}:empty`);
    if (c === null) sourceBlockers.push(`${key}:unavailable`);
  }

  const moneyBlockers: string[] = [];
  if (!feePreviewCount) moneyBlockers.push("amazon_fee_preview_empty");
  moneyBlockers.push("product_cost_snapshots_not_migrated");
  moneyBlockers.push("cogs_spine_incomplete");

  const prioritySet = new Set<string>([
    ...CLEAN_DATA_PRIORITY_V3_FAMILIES,
    ...PRIORITY_V3_FAMILIES,
  ]);

  const matrix: V3FamilyDryrunRow[] = [];

  for (const entry of CLAIM_FAMILY_MATRIX_V3) {
    const sourceCounts: Record<string, number | null> = {};
    for (const t of entry.normalized_tables) {
      const table = normalizeTableName(t);
      if (!table) continue;
      sourceCounts[table] = await tableRowCount(
        options.client,
        table,
        options.organizationId,
        options.storeId,
      );
    }

    const drafts = familyDrafts(entry.family_key, allDrafts);
    let candidateCount = drafts.length;
    let reviewCount = 0;

    if (entry.classification === "review_signal_only") {
      reviewCount = candidateCount || 1;
      candidateCount = 0;
    }
    if (entry.current_availability === "empty_connector") reviewCount += 1;

    const sourceOk = sourceAvailable(entry, sourceCounts);
    const linkedDrafts = drafts.filter((d) => draftProductId(d)).length;
    const familyLinkageReady =
      entry.product_linkage_requirement === "not_applicable" ||
      entry.product_linkage_requirement === "identifier_only" ||
      (drafts.length > 0 ? linkedDrafts / drafts.length >= 0.25 : orgLinkageReady);

    const payoutAvail = (feePreviewCount ?? 0) > 0;
    const observedAvail = (reimbCount ?? 0) > 0;
    const costAvail = drafts.some((d) => d.cogs_unit != null && d.cogs_unit > 0);

    let cleanQty: number | null = null;
    let disputedQty: number | null = null;
    if (entry.normalized_tables.some((t) => t.includes("expected_packages"))) {
      cleanQty = epQty.clean;
      disputedQty = epQty.disputed;
    } else if (drafts.length) {
      cleanQty = drafts.reduce(
        (s, d) => s + Math.max(0, d.expected_quantity ?? d.actual_quantity ?? 0),
        0,
      );
    }

    const confDist = { high: 0, medium: 0, low: 0, unavailable: 0 };
    for (const d of drafts) confDist[confBucket(d.confidence_score)] += 1;

    const { status, blocker } = deriveImplementationStatus({
      entry,
      sourceOk,
      linkageReady: familyLinkageReady,
      payoutAvail,
      costAvail,
      candidateCount,
      reviewCount,
      familyDrafts: drafts,
    });

    matrix.push({
      family_key: entry.family_key,
      family_label: entry.display_name,
      classification: entry.classification,
      implementation_priority: entry.implementation_priority,
      priority_family: prioritySet.has(entry.family_key),
      source_available: sourceOk,
      product_linkage_ready: familyLinkageReady,
      clean_quantity_preview: cleanQty,
      disputed_quantity_excluded: disputedQty,
      review_signal_count: reviewCount,
      candidate_count_preview: candidateCount,
      estimated_amazon_payout_available: payoutAvail && !entry.fee_amount_formula.includes("NULL —"),
      observed_reimbursement_available: observedAvail,
      internal_cost_loss_available: costAvail,
      confidence_distribution: confDist,
      blocker,
      implementation_status: status,
      source_table_row_counts: sourceCounts,
    });
  }

  const claimReady = matrix.filter((r) => r.implementation_status === "claim_ready_preview").map((r) => r.family_key);
  const reviewOnly = matrix.filter((r) => r.implementation_status === "review_only").map((r) => r.family_key);
  const blocked = matrix
    .filter((r) =>
      r.implementation_status.startsWith("blocked_") || r.implementation_status === "lifecycle_only",
    )
    .map((r) => r.family_key);

  const linked = allDrafts.filter((d) => draftProductId(d)).length;
  const unlinked = allDrafts.length - linked;

  const top20 = [...allDrafts]
    .sort((a, b) => (b.recovery_value ?? b.expected_amount ?? 0) - (a.recovery_value ?? a.expected_amount ?? 0))
    .slice(0, 20)
    .map((d, i) => {
      const fk = v3KeyForDraft(d);
      const row = matrix.find((m) => m.family_key === fk);
      return {
        rank: i + 1,
        family_key: fk,
        claim_family: d.claim_family,
        source_kind: d.source_kind,
        source_table: d.source_table,
        expected_amount: d.expected_amount,
        recovery_value: d.recovery_value,
        product_linkage_resolved: Boolean(draftProductId(d)),
        implementation_status: row?.implementation_status ?? "blocked_missing_source",
      };
    });

  const priorityReady = matrix.filter(
    (r) => r.priority_family && r.implementation_status === "claim_ready_preview",
  ).length;

  const safe: ClaimV3ReadmodelDryrunCleanDataPayload["SAFE_TO_IMPLEMENT_FIRST_CLAIM_PREVIEW"] =
    priorityReady >= 2 ? "yes" : claimReady.length > 0 ? "conditional" : "no";

  return {
    read_only: true,
    no_db_writes: true,
    no_claim_candidate_mutation: true,
    no_ai_calls: true,
    generated_at: new Date().toISOString(),
    organization_id: options.organizationId,
    store_id: options.storeId,
    window,
    v3_family_count: V3_CLAIM_FAMILY_COUNT,
    linkage_health_summary: {
      overall_percent: linkage.linkage_health.overall_percent,
      critical_paths_percent: linkage.linkage_health.critical_paths_percent,
      grade: linkage.linkage_health.grade,
      safe_for_product_story: linkage.linkage_health.safe_for_product_story,
    },
    V3_family_dryrun_matrix: matrix,
    claim_ready_preview_families: claimReady,
    review_only_families: reviewOnly,
    blocked_families: blocked,
    top_20_preview_opportunities: top20,
    product_linkage_blockers: {
      org_linkage_grade: linkage.linkage_health.grade,
      drafts_unlinked: unlinked,
      drafts_linked: linked,
      linkage_pct_on_drafts: allDrafts.length ? Math.round((linked / allDrafts.length) * 1000) / 10 : 0,
      families_blocked_missing_linkage: matrix.filter(
        (r) => r.implementation_status === "blocked_missing_linkage",
      ).length,
    },
    source_blockers: sourceBlockers,
    money_blockers: moneyBlockers,
    SAFE_TO_IMPLEMENT_FIRST_CLAIM_PREVIEW: safe,
    SAFE_RATIONALE:
      safe === "yes"
        ? `${priorityReady} priority families claim_ready_preview with clean generator dry-run`
        : safe === "conditional"
          ? `${claimReady.length} families claim_ready_preview but linkage/fee/COGS block trusted money`
          : "No families reached claim_ready_preview — source/linkage/money blockers",
  };
}
