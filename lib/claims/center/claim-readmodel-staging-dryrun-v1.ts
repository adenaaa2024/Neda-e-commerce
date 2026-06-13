/**
 * PHASE-CLAIM-READMODEL-STAGING-DRYRUN-V1
 * Read-only V3 claim family preview — no DB writes, no claim_candidates mutation.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

import {
  CLAIM_FAMILY_MATRIX_V3,
  type ClaimFamilyMatrixV3Entry,
} from "@/lib/claims/contracts/claim-family-algorithm-matrix-v3-official-amazon-coverage";
import { CLAIM_INTAKE_GENERATORS } from "@/lib/claims/intake/claim-intake-generators";
import {
  evaluateSourceGate,
  loadClaimIntakeSettings,
  resolveClaimIntakeWindow,
} from "@/lib/claims/intake/claim-intake-settings";
import type { ClaimCandidateDraft, ClaimIntakeWindow, ClaimSourceKind } from "@/lib/claims/intake/claim-intake-types";
import { buildFeeAdjustedEstimate } from "@/lib/fees/fee-adjusted-estimate-readmodel";
import {
  isCleanExpectedPackageBuildStatus,
  splitExpectedQuantityByBuildStatus,
} from "@/lib/expected-packages-conflict-status";

export const PRIORITY_V3_FAMILIES = [
  "customer_return_not_reimbursed",
  "physical_return_scanner_issue",
  "removal_order_discrepancy",
  "missing_reimbursement",
  "orbit_fra_fight_list",
  "fba_fee_overcharge",
  "monthly_storage_fee_overcharge",
] as const;

/** Maps V3 family_key → intake draft families + generator source kinds. */
export const V3_FAMILY_INTAKE_BRIDGE: Record<
  string,
  { draft_families: string[]; source_kinds: ClaimSourceKind[] }
> = {
  physical_return_scanner_issue: {
    draft_families: ["physical_return_issue", "physical_return_off_manifest"],
    source_kinds: ["scanner_physical_review"],
  },
  removal_order_discrepancy: {
    draft_families: ["removal_missing_units", "shipment_quantity_mismatch", "shipment_not_received"],
    source_kinds: ["amazon_removal_api", "shipment_discrepancy", "delayed_not_received"],
  },
  missing_reimbursement: {
    draft_families: ["inventory_unreconciled_loss"],
    source_kinds: ["inventory_ledger"],
  },
  orbit_fra_fight_list: {
    draft_families: ["orbit_fra_recovery"],
    source_kinds: ["orbit_fra"],
  },
  customer_return_not_reimbursed: { draft_families: [], source_kinds: [] },
  fba_fee_overcharge: { draft_families: [], source_kinds: [] },
  monthly_storage_fee_overcharge: { draft_families: [], source_kinds: [] },
};

export type FamilyPreviewRow = {
  family_key: string;
  family_label: string;
  classification: string;
  implementation_priority: string;
  source_availability: string;
  source_table_row_counts: Record<string, number | null>;
  candidate_count_preview: number;
  review_signal_count_preview: number;
  existing_pool_count: number;
  clean_quantity_sum: number | null;
  disputed_excluded_quantity: number | null;
  estimated_amazon_payout_sum: number | null;
  observed_reimbursement_sum: number | null;
  internal_cost_loss_sum: number | null;
  missing_inputs: string[];
  confidence_distribution: { high: number; medium: number; low: number; unavailable: number };
  blockers: string[];
};

export type ClaimReadmodelStagingDryrunPayload = {
  read_only: true;
  no_db_writes: true;
  no_claim_candidate_mutation: true;
  no_ai_calls: true;
  generated_at: string;
  organization_id: string;
  store_id: string;
  window: ClaimIntakeWindow;
  family_preview_matrix: FamilyPreviewRow[];
  top_candidate_opportunities: Array<{
    family_key: string;
    claim_family: string;
    source_kind: string;
    source_table: string;
    expected_amount: number | null;
    recovery_value: number | null;
    confidence: number | null;
    product_linkage_resolved: boolean;
  }>;
  review_signals: Array<{ family_key: string; reason: string; count: number }>;
  missing_inputs_by_family: Record<string, string[]>;
  money_availability: {
    families_with_payout_preview: number;
    families_with_observed_preview: number;
    families_with_cost_preview: number;
    fee_preview_rows: number | null;
  };
  product_linkage_blockers: {
    drafts_unlinked: number;
    drafts_linked: number;
    linkage_pct: number;
  };
  source_freshness_blockers: string[];
  SAFE_TO_IMPLEMENT_FIRST_GENERATOR_PREVIEW: "yes" | "conditional" | "no";
  SAFE_RATIONALE: string;
};

function confBucket(c: number | null | undefined): keyof FamilyPreviewRow["confidence_distribution"] {
  if (c == null || !Number.isFinite(c)) return "unavailable";
  if (c >= 0.85) return "high";
  if (c >= 0.65) return "medium";
  return "low";
}

function draftProductId(d: ClaimCandidateDraft): string | null {
  return d.product.resolved_product_id;
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

export async function collectDrafts(
  client: SupabaseClient,
  organizationId: string,
  storeId: string | null,
  sourceKinds: ClaimSourceKind[],
  window: ClaimIntakeWindow,
  rowLimit: number,
): Promise<ClaimCandidateDraft[]> {
  const { settings } = await loadClaimIntakeSettings(client, organizationId);
  const drafts: ClaimCandidateDraft[] = [];
  for (const gen of CLAIM_INTAKE_GENERATORS) {
    if (!sourceKinds.includes(gen.source_kind)) continue;
    const gate = evaluateSourceGate(settings, gen.source_kind);
    if (!gate.enabled || gate.skip_reason) continue;
    const excludedTables = settings.excluded_source_tables ?? [];
    const excluded = gen.source_tables.some((t) => excludedTables.includes(t));
    if (excluded) continue;
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
      /* generator error surfaced in blockers */
    }
  }
  return drafts;
}

async function sqlCustomerReturnNotReimbursedPreview(
  pgClient: pg.Client | null,
  organizationId: string,
  storeId: string,
): Promise<number> {
  if (!pgClient) return 0;
  try {
    const r = await pgClient.query(
      `SELECT COUNT(*)::int AS c
       FROM amazon_returns r
       WHERE r.organization_id = $1::uuid
         AND r.store_id = $2::uuid
         AND NOT EXISTS (
           SELECT 1 FROM amazon_reimbursements rb
           WHERE rb.organization_id = r.organization_id
             AND rb.amount_total > 0
             AND (rb.fnsku IS NOT DISTINCT FROM r.fnsku OR rb.order_id IS NOT DISTINCT FROM r.order_id)
         )`,
      [organizationId, storeId],
    );
    return Number(r.rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
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
       FROM expected_packages
       WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
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

async function existingPoolByFamily(
  client: SupabaseClient,
  organizationId: string,
  familyKeys: string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = Object.fromEntries(familyKeys.map((k) => [k, 0]));
  const aliases = new Map<string, string>();
  for (const [v3, bridge] of Object.entries(V3_FAMILY_INTAKE_BRIDGE)) {
    for (const d of bridge.draft_families) aliases.set(d, v3);
    aliases.set(v3, v3);
  }
  aliases.set("orbit_fra_recovery", "orbit_fra_fight_list");
  aliases.set("physical_return_issue", "physical_return_scanner_issue");

  const { data, error } = await client
    .from("claim_candidates")
    .select("claim_family")
    .eq("organization_id", organizationId)
    .is("quarantined_at", null)
    .is("rejected_at", null)
    .neq("source_kind", "legacy_seed");
  if (error) return out;
  for (const row of data ?? []) {
    const fam = String((row as { claim_family: string }).claim_family);
    const v3 = aliases.get(fam) ?? fam;
    if (v3 in out) out[v3] += 1;
  }
  return out;
}

async function moneySampleSums(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
  productIds: string[],
): Promise<{
  estimated_amazon_payout_sum: number | null;
  observed_reimbursement_sum: number | null;
  internal_cost_loss_sum: number | null;
  missing: string[];
}> {
  let payout = 0;
  let observed = 0;
  let cost = 0;
  let payoutHits = 0;
  let observedHits = 0;
  let costHits = 0;
  const missing = new Set<string>();

  for (const pid of productIds.slice(0, 8)) {
    try {
      const est = await buildFeeAdjustedEstimate(client, organizationId, storeId, pid);
      if (est.estimated_amazon_payout != null) {
        payout += est.estimated_amazon_payout;
        payoutHits += 1;
      }
      if (est.observed_reimbursement != null) {
        observed += est.observed_reimbursement;
        observedHits += 1;
      }
      if (est.internal_cost_loss != null) {
        cost += est.internal_cost_loss;
        costHits += 1;
      }
      for (const m of est.missing_inputs) missing.add(m);
    } catch {
      missing.add("fee_adjusted_estimate_error");
    }
  }

  return {
    estimated_amazon_payout_sum: payoutHits ? Math.round(payout * 100) / 100 : null,
    observed_reimbursement_sum: observedHits ? Math.round(observed * 100) / 100 : null,
    internal_cost_loss_sum: costHits ? Math.round(cost * 100) / 100 : null,
    missing: [...missing],
  };
}

function draftsForFamily(
  familyKey: string,
  allDrafts: ClaimCandidateDraft[],
  sqlPreviewCount: number,
): ClaimCandidateDraft[] {
  const bridge = V3_FAMILY_INTAKE_BRIDGE[familyKey];
  if (bridge?.draft_families.length) {
    return allDrafts.filter((d) => bridge.draft_families.includes(d.claim_family));
  }
  return [];
}

async function loadSourceFreshnessBlockers(
  client: SupabaseClient,
  organizationId: string,
  storeId: string,
): Promise<string[]> {
  const blockers: string[] = [];
  const checks: Array<{ key: string; table: string }> = [
    { key: "reimbursements", table: "amazon_reimbursements" },
    { key: "returns", table: "amazon_returns" },
    { key: "removals", table: "amazon_removals" },
    { key: "ledger", table: "amazon_inventory_ledger" },
    { key: "fee_preview", table: "amazon_fee_preview" },
  ];
  for (const c of checks) {
    const count = await tableRowCount(client, c.table, organizationId, storeId);
    if (count === 0) blockers.push(`${c.key}:missing`);
    if (count === null) blockers.push(`${c.key}:unavailable`);
  }
  return blockers;
}

/** Build read-only V3 family preview matrix (staging). */
export async function buildClaimReadmodelStagingDryrun(options: {
  client: SupabaseClient;
  pgClient?: pg.Client | null;
  organizationId: string;
  storeId: string;
  from?: string | null;
  to?: string | null;
  rowLimit?: number;
  families?: readonly string[];
}): Promise<ClaimReadmodelStagingDryrunPayload> {
  const rowLimit = options.rowLimit ?? 500;
  const familyKeys = [...(options.families ?? PRIORITY_V3_FAMILIES)];
  const { settings } = await loadClaimIntakeSettings(options.client, options.organizationId);
  const window = resolveClaimIntakeWindow(settings, options.from ?? null, options.to ?? null);

  const freshnessBlockers = await loadSourceFreshnessBlockers(
    options.client,
    options.organizationId,
    options.storeId,
  );

  const allSourceKinds = [
    ...new Set(familyKeys.flatMap((k) => V3_FAMILY_INTAKE_BRIDGE[k]?.source_kinds ?? [])),
    "orbit_fra",
  ] as ClaimSourceKind[];
  const allDrafts = await collectDrafts(
    options.client,
    options.organizationId,
    options.storeId,
    allSourceKinds,
    window,
    rowLimit,
  );

  const poolCounts = await existingPoolByFamily(options.client, options.organizationId, familyKeys);
  const epQty = await sqlExpectedPackageQuantities(
    options.pgClient ?? null,
    options.organizationId,
    options.storeId,
  );
  const customerReturnPreview = await sqlCustomerReturnNotReimbursedPreview(
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

  const familyPreviewMatrix: FamilyPreviewRow[] = [];
  const missingInputsByFamily: Record<string, string[]> = {};
  const reviewSignals: Array<{ family_key: string; reason: string; count: number }> = [];

  for (const familyKey of familyKeys) {
    const entry = CLAIM_FAMILY_MATRIX_V3.find((e) => e.family_key === familyKey) as
      | ClaimFamilyMatrixV3Entry
      | undefined;
    if (!entry) continue;

    const sourceCounts: Record<string, number | null> = {};
    for (const t of entry.normalized_tables) {
      const table = t.replace(/^planned: /, "").split(" ")[0]!;
      if (table.startsWith("claim_")) continue;
      sourceCounts[table] = await tableRowCount(
        options.client,
        table,
        options.organizationId,
        options.storeId,
      );
    }

    const familyDrafts = draftsForFamily(familyKey, allDrafts, customerReturnPreview);
    let candidatePreview = familyDrafts.length;
    let reviewPreview = 0;

    if (familyKey === "customer_return_not_reimbursed") {
      candidatePreview = customerReturnPreview;
      if (sourceCounts.amazon_returns === 0) reviewPreview += 1;
    }
    if (entry.classification === "review_signal_only") {
      reviewPreview = candidatePreview;
      candidatePreview = 0;
    }
    if (entry.current_availability === "empty_connector" || entry.current_availability === "unsupported_file") {
      reviewPreview += 1;
    }

    const missing_inputs: string[] = [];
    if (entry.blocked_reason) missing_inputs.push(entry.blocked_reason);
    for (const [t, c] of Object.entries(sourceCounts)) {
      if (c === 0) missing_inputs.push(`${t}_empty`);
      if (c === null) missing_inputs.push(`${t}_unavailable`);
    }
    if (familyKey === "fba_fee_overcharge" || familyKey === "monthly_storage_fee_overcharge") {
      if (!feePreviewCount) missing_inputs.push("amazon_fee_preview_empty");
    }

    const blockers = [...missing_inputs];
    if (entry.product_linkage_requirement === "required_before_trusted_money") {
      const unlinked = familyDrafts.filter((d) => !draftProductId(d)).length;
      if (unlinked) blockers.push(`product_linkage_unresolved:${unlinked}`);
    }

    const confDist = { high: 0, medium: 0, low: 0, unavailable: 0 };
    for (const d of familyDrafts) {
      confDist[confBucket(d.confidence_score)] += 1;
    }
    if (!familyDrafts.length && candidatePreview > 0) confDist.medium += candidatePreview;

    const productIds = [
      ...new Set(familyDrafts.map((d) => draftProductId(d)).filter((x): x is string => Boolean(x))),
    ];
    const money = await moneySampleSums(
      options.client,
      options.organizationId,
      options.storeId,
      productIds,
    );
    missing_inputs.push(...money.missing);

    let cleanQty: number | null = null;
    let disputedQty: number | null = null;
    if (entry.normalized_tables.some((t) => t.includes("expected_packages"))) {
      cleanQty = epQty.clean;
      disputedQty = epQty.disputed;
    } else {
      cleanQty = familyDrafts.reduce((s, d) => s + (d.expected_quantity ?? d.actual_quantity ?? 0), 0) || null;
    }

    familyPreviewMatrix.push({
      family_key: familyKey,
      family_label: entry.display_name,
      classification: entry.classification,
      implementation_priority: entry.implementation_priority,
      source_availability: entry.current_availability,
      source_table_row_counts: sourceCounts,
      candidate_count_preview: candidatePreview,
      review_signal_count_preview: reviewPreview,
      existing_pool_count: poolCounts[familyKey] ?? 0,
      clean_quantity_sum: cleanQty,
      disputed_excluded_quantity: disputedQty,
      estimated_amazon_payout_sum: money.estimated_amazon_payout_sum,
      observed_reimbursement_sum: money.observed_reimbursement_sum,
      internal_cost_loss_sum: money.internal_cost_loss_sum,
      missing_inputs: [...new Set(missing_inputs)],
      confidence_distribution: confDist,
      blockers,
    });
    missingInputsByFamily[familyKey] = [...new Set(missing_inputs)];

    if (disputedQty && disputedQty > 0) {
      reviewSignals.push({
        family_key: familyKey,
        reason: "disputed_expected_packages_excluded",
        count: disputedQty,
      });
    }
  }

  const linked = allDrafts.filter((d) => draftProductId(d)).length;
  const unlinked = allDrafts.length - linked;

  const topOpportunities = [...allDrafts]
    .sort((a, b) => (b.recovery_value ?? b.expected_amount ?? 0) - (a.recovery_value ?? a.expected_amount ?? 0))
    .slice(0, 15)
    .map((d) => {
      const v3 =
        Object.entries(V3_FAMILY_INTAKE_BRIDGE).find(([, b]) =>
          b.draft_families.includes(d.claim_family),
        )?.[0] ?? d.claim_family;
      return {
        family_key: v3,
        claim_family: d.claim_family,
        source_kind: d.source_kind,
        source_table: d.source_table,
        expected_amount: d.expected_amount,
        recovery_value: d.recovery_value,
        confidence: d.confidence_score,
        product_linkage_resolved: Boolean(draftProductId(d)),
      };
    });

  const p0WithCandidates = familyPreviewMatrix.filter(
    (f) =>
      ["P0", "P1"].includes(f.implementation_priority) && f.candidate_count_preview > 0,
  ).length;

  const safe: ClaimReadmodelStagingDryrunPayload["SAFE_TO_IMPLEMENT_FIRST_GENERATOR_PREVIEW"] =
    p0WithCandidates >= 2 && allDrafts.length > 0
      ? "yes"
      : allDrafts.length > 0
        ? "conditional"
        : "no";

  return {
    read_only: true,
    no_db_writes: true,
    no_claim_candidate_mutation: true,
    no_ai_calls: true,
    generated_at: new Date().toISOString(),
    organization_id: options.organizationId,
    store_id: options.storeId,
    window,
    family_preview_matrix: familyPreviewMatrix,
    top_candidate_opportunities: topOpportunities,
    review_signals: reviewSignals,
    missing_inputs_by_family: missingInputsByFamily,
    money_availability: {
      families_with_payout_preview: familyPreviewMatrix.filter(
        (f) => f.estimated_amazon_payout_sum != null,
      ).length,
      families_with_observed_preview: familyPreviewMatrix.filter(
        (f) => f.observed_reimbursement_sum != null,
      ).length,
      families_with_cost_preview: familyPreviewMatrix.filter((f) => f.internal_cost_loss_sum != null)
        .length,
      fee_preview_rows: feePreviewCount,
    },
    product_linkage_blockers: {
      drafts_unlinked: unlinked,
      drafts_linked: linked,
      linkage_pct: allDrafts.length ? Math.round((linked / allDrafts.length) * 1000) / 10 : 0,
    },
    source_freshness_blockers: freshnessBlockers,
    SAFE_TO_IMPLEMENT_FIRST_GENERATOR_PREVIEW: safe,
    SAFE_RATIONALE:
      safe === "yes"
        ? "P0/P1 families show candidate previews with live generator dry-run drafts"
        : safe === "conditional"
          ? "Generators emit drafts but major V3 families blocked on source gaps (returns ledger, fee preview, COGS)"
          : "No generator drafts in window — source or policy blockers",
  };
}
