/**
 * Phase 7C — the 10 registered trusted claim generators.
 * Each reads ONLY source-of-truth tables (never claim_candidates / legacy_seed),
 * normalizes rows into in-memory ClaimCandidateDraft objects, and reports the
 * full matched count alongside a capped draft batch.
 */
import { shouldExcludeReturnItemFromScannerCounts } from "../../scanner/return-items-test-data-guard";
import { returnItemNotesMarkOffSlip } from "../../scanner/item-scan-off-slip";
import {
  candidateTriggerAllowsRun,
  isPhysicalEventClaimable,
  loadClaimCandidateIntakePolicy,
  physicalEventFromScannerSignals,
} from "../../claim-candidate-intake-policy";
import {
  buildClaimDedupeKey,
  isClaimSourceKind,
  type ClaimCandidateDraft,
  type ClaimGeneratorContext,
  type ClaimGeneratorDefinition,
  type ClaimGeneratorOutput,
  type ClaimProductGrain,
  type ClaimReferenceEdge,
  type ClaimSourceKind,
} from "./claim-intake-types";

type Row = Record<string, unknown>;

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

function num(v: unknown): number | null {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) ? n : null;
}

function intOrZero(v: unknown): number {
  const n = Math.floor(Number(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}

function grain(row: Row): ClaimProductGrain {
  return {
    sku: str(row.sku),
    fnsku: str(row.fnsku),
    asin: str(row.asin),
    resolved_product_id: str(row.resolved_product_id ?? row.product_id),
  };
}

export function edges(pairs: Array<[string, unknown]>): ClaimReferenceEdge[] {
  const out: ClaimReferenceEdge[] = [];
  const seen = new Set<string>();
  for (const [kind, value] of pairs) {
    const v = str(value);
    if (!v) continue;
    const key = `${kind}\u0000${v}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ reference_kind: kind, reference_value: v });
  }
  return out;
}

export function makeDraft(input: {
  ctx: ClaimGeneratorContext;
  source_kind: ClaimSourceKind;
  claim_family: string;
  claim_reason: string;
  source_table: string;
  row: Row;
  reference_key: string | null;
  source_event_key: string | null;
  expected_quantity?: number | null;
  actual_quantity?: number | null;
  expected_amount?: number | null;
  currency?: string | null;
  event_date?: string | null;
  confidence?: number;
  reference_edges?: ClaimReferenceEdge[];
  extra_metadata?: Record<string, unknown>;
  reference_type?: string | null;
  dispute_deadline?: string | null;
  days_remaining?: number | null;
  recovery_value?: number | null;
  cogs_unit?: number | null;
  evidence_summary?: string | null;
}): ClaimCandidateDraft {
  const sourceRowId = String(input.row.id);
  const expected = input.expected_quantity ?? null;
  const actual = input.actual_quantity ?? null;
  const delta = expected != null && actual != null ? actual - expected : null;
  const refEdges = input.reference_edges ?? [];
  const inferredRefType =
    input.reference_key != null
      ? (refEdges.find((e) => e.reference_value === input.reference_key)?.reference_kind ?? null)
      : null;
  return {
    source_kind: input.source_kind,
    claim_family: input.claim_family,
    dedupe_key: buildClaimDedupeKey({
      source_kind: input.source_kind,
      organization_id: input.ctx.organizationId,
      store_id: str(input.row.store_id),
      source_table: input.source_table,
      source_row_id: sourceRowId,
      claim_family: input.claim_family,
    }),
    source_event_key: input.source_event_key,
    source_table: input.source_table,
    source_row_id: sourceRowId,
    organization_id: input.ctx.organizationId,
    store_id: str(input.row.store_id),
    product: grain(input.row),
    reference_key: input.reference_key,
    reference_type: input.reference_type ?? inferredRefType,
    expected_quantity: expected,
    actual_quantity: actual,
    delta_quantity: delta,
    expected_amount: input.expected_amount ?? null,
    currency: input.currency ?? str(input.row.currency),
    event_date: input.event_date ?? null,
    dispute_deadline: input.dispute_deadline ?? null,
    days_remaining: input.days_remaining ?? null,
    recovery_value: input.recovery_value ?? input.expected_amount ?? null,
    cogs_unit: input.cogs_unit ?? null,
    evidence_summary: input.evidence_summary ?? null,
    claim_reason: input.claim_reason,
    confidence_score: input.confidence ?? 0.8,
    evidence_pointers: [{ table: input.source_table, id: sourceRowId }],
    reference_edges: refEdges,
    metadata: {
      intake_version: "7c-v1",
      window: { from: input.ctx.window.from, to: input.ctx.window.to },
      ...input.extra_metadata,
    },
  };
}

/* ── 1) scanner_physical_review ──────────────────────────────────────────── */
const scannerPhysicalReview: ClaimGeneratorDefinition = {
  source_kind: "scanner_physical_review",
  title: "Scanner physical review (operator-confirmed discrepancies)",
  source_tables: ["return_items"],
  default_claim_family: "physical_return_issue",
  async generate(ctx): Promise<ClaimGeneratorOutput> {
    const policy = await loadClaimCandidateIntakePolicy(ctx.client, ctx.organizationId);
    if (!candidateTriggerAllowsRun(policy.claim_candidate_trigger, ctx.runKind)) {
      return {
        matched_count: 0,
        drafts: [],
        notes: [`skipped_by_candidate_trigger: ${policy.claim_candidate_trigger} disallows ${ctx.runKind} runs`],
      };
    }

    const { data, error } = await ctx.client
      .from("return_items")
      .select(
        "id, organization_id, store_id, package_id, pallet_id, order_id, sku, fnsku, asin, product_identifier, item_name, notes, conditions, status, scanned_quantity, resolved_product_id, created_at, raw_return_data",
      )
      .eq("organization_id", ctx.organizationId)
      .is("deleted_at", null)
      .gte("created_at", ctx.window.from)
      .lte("created_at", `${ctx.window.to}T23:59:59.999Z`)
      .limit(ctx.rowLimit);
    if (error) throw new Error(error.message);

    type ScanRow = { row: Row; event: ReturnType<typeof physicalEventFromScannerSignals> };
    let suppressedByPolicy = 0;
    const rows: ScanRow[] = [];
    for (const row of (data ?? []) as Row[]) {
      if (
        shouldExcludeReturnItemFromScannerCounts({
          item_name: str(row.item_name),
          sku: str(row.sku),
          fnsku: str(row.fnsku),
          product_identifier: str(row.product_identifier),
          notes: str(row.notes),
        })
      ) {
        continue;
      }
      const event = physicalEventFromScannerSignals({
        conditionTags: Array.isArray(row.conditions)
          ? row.conditions.map((c) => String(c ?? ""))
          : [],
        offSlip: returnItemNotesMarkOffSlip(str(row.notes)),
      });
      if (!event) continue;
      if (!isPhysicalEventClaimable(policy, event)) {
        suppressedByPolicy += 1;
        continue;
      }
      rows.push({ row, event });
    }

    const drafts = rows.map(({ row, event }) =>
      makeDraft({
        ctx,
        source_kind: "scanner_physical_review",
        claim_family: "physical_return_issue",
        claim_reason:
          event === "unexpected_item" ? "scanned_off_manifest_unit" : `operator_flagged_${event}`,
        source_table: "return_items",
        row,
        reference_key: str(row.order_id) ?? str(row.package_id),
        source_event_key: str(row.id),
        actual_quantity: intOrZero(row.scanned_quantity) || 1,
        event_date: str(row.created_at),
        confidence: 0.9,
        reference_edges: edges([
          ["order_id", row.order_id],
          ["package_id", row.package_id],
          ["pallet_id", row.pallet_id],
        ]),
        extra_metadata: {
          package_id: str(row.package_id),
          pallet_id: str(row.pallet_id),
          return_item_id: str(row.id),
          conditions: row.conditions ?? null,
          physical_event: event,
          candidate_creation_trigger: policy.claim_candidate_trigger,
        },
      }),
    );
    const notes = ["matched_count limited to fetched window cap (in-memory discrepancy filter)"];
    if (suppressedByPolicy > 0) {
      notes.push(`suppressed_by_claimable_events_policy: ${suppressedByPolicy}`);
    }
    return { matched_count: drafts.length, drafts, notes };
  },
};

/* ── 2) amazon_removal_api ───────────────────────────────────────────────── */
const amazonRemovalApi: ClaimGeneratorDefinition = {
  source_kind: "amazon_removal_api",
  title: "Amazon removal orders — missing / short-shipped units",
  source_tables: ["amazon_removals"],
  default_claim_family: "removal_missing_units",
  async generate(ctx): Promise<ClaimGeneratorOutput> {
    const base = () =>
      ctx.client
        .from("amazon_removals")
        .select(
          "id, organization_id, store_id, order_id, sku, fnsku, disposition, requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity, in_process_quantity, status, tracking_number, order_date, last_updated_date, currency, resolved_product_id",
          { count: "exact" },
        )
        .eq("organization_id", ctx.organizationId)
        .gte("order_date", ctx.window.from)
        .lte("order_date", ctx.window.to)
        .gt("requested_quantity", 0);

    const { data, error, count } = await base().limit(ctx.rowLimit * 4);
    if (error) throw new Error(error.message);

    const rows = ((data ?? []) as Row[]).filter((row) => {
      const requested = intOrZero(row.requested_quantity);
      const accounted =
        intOrZero(row.shipped_quantity) +
        intOrZero(row.disposed_quantity) +
        intOrZero(row.cancelled_quantity) +
        intOrZero(row.in_process_quantity);
      return requested - accounted > 0;
    });

    const drafts = rows.slice(0, ctx.rowLimit).map((row) => {
      const requested = intOrZero(row.requested_quantity);
      const accounted =
        intOrZero(row.shipped_quantity) +
        intOrZero(row.disposed_quantity) +
        intOrZero(row.cancelled_quantity) +
        intOrZero(row.in_process_quantity);
      return makeDraft({
        ctx,
        source_kind: "amazon_removal_api",
        claim_family: "removal_missing_units",
        claim_reason: "removal_units_unaccounted",
        source_table: "amazon_removals",
        row,
        reference_key: str(row.order_id),
        source_event_key: str(row.order_id),
        expected_quantity: requested,
        actual_quantity: accounted,
        event_date: str(row.order_date),
        confidence: 0.85,
        reference_edges: edges([
          ["removal_order_id", row.order_id],
          ["tracking_number", row.tracking_number],
        ]),
        extra_metadata: { disposition: str(row.disposition), removal_status: str(row.status) },
      });
    });
    return {
      matched_count: rows.length,
      drafts,
      notes: [`source rows in window: ${count ?? 0}; unaccounted-unit filter applied in memory`],
    };
  },
};

/* ── 3) reimbursement ────────────────────────────────────────────────────── */
const reimbursement: ClaimGeneratorDefinition = {
  source_kind: "reimbursement",
  title: "Amazon reimbursements — clawbacks / reversals",
  source_tables: ["amazon_reimbursements"],
  default_claim_family: "reimbursement_reversal",
  async generate(ctx): Promise<ClaimGeneratorOutput> {
    const filters = () =>
      ctx.client
        .from("amazon_reimbursements")
        .select(
          "id, organization_id, store_id, order_id, reimbursement_id, original_reimbursement_id, reason, case_id, sku, fnsku, asin, amount_total, currency_unit, quantity_reimbursed_total, approval_date, resolved_product_id:product_id",
          { count: "exact" },
        )
        .eq("organization_id", ctx.organizationId)
        .lt("amount_total", 0)
        .gte("approval_date", ctx.window.from)
        .lte("approval_date", `${ctx.window.to}T23:59:59.999Z`);

    const { data, error, count } = await filters().limit(ctx.rowLimit);
    if (error) throw new Error(error.message);

    const drafts = ((data ?? []) as Row[]).map((row) =>
      makeDraft({
        ctx,
        source_kind: "reimbursement",
        claim_family: "reimbursement_reversal",
        claim_reason: str(row.reason) ?? "reimbursement_clawback",
        source_table: "amazon_reimbursements",
        row,
        reference_key: str(row.reimbursement_id) ?? str(row.order_id),
        source_event_key: str(row.reimbursement_id),
        actual_quantity: intOrZero(row.quantity_reimbursed_total) || null,
        expected_amount: Math.abs(num(row.amount_total) ?? 0),
        currency: str(row.currency_unit),
        event_date: str(row.approval_date),
        confidence: 0.9,
        reference_edges: edges([
          ["reimbursement_id", row.reimbursement_id],
          ["original_reimbursement_id", row.original_reimbursement_id],
          ["order_id", row.order_id],
          ["case_id", row.case_id],
        ]),
      }),
    );
    return { matched_count: count ?? drafts.length, drafts, notes: [] };
  },
};

/* ── 4) settlement ───────────────────────────────────────────────────────── */
const settlement: ClaimGeneratorDefinition = {
  source_kind: "settlement",
  title: "Amazon settlements — refund / chargeback lines for review",
  source_tables: ["amazon_settlements"],
  default_claim_family: "settlement_refund_review",
  async generate(ctx): Promise<ClaimGeneratorOutput> {
    const filters = () =>
      ctx.client
        .from("amazon_settlements")
        .select(
          "id, organization_id, store_id, order_id, settlement_id, amazon_line_key, sku, transaction_type, amount_total, total_amount, currency, quantity, posted_date, resolved_product_id",
          { count: "exact" },
        )
        .eq("organization_id", ctx.organizationId)
        .in("transaction_type", ["Refund", "Chargeback Refund", "A-to-z Guarantee Refund"])
        .lt("amount_total", 0)
        .gte("posted_date", ctx.window.from)
        .lte("posted_date", `${ctx.window.to}T23:59:59.999Z`);

    const { data, error, count } = await filters().limit(ctx.rowLimit);
    if (error) throw new Error(error.message);

    const drafts = ((data ?? []) as Row[]).map((row) =>
      makeDraft({
        ctx,
        source_kind: "settlement",
        claim_family: "settlement_refund_review",
        claim_reason: `settlement_${String(row.transaction_type ?? "refund").toLowerCase().replace(/\W+/g, "_")}`,
        source_table: "amazon_settlements",
        row,
        reference_key: str(row.order_id) ?? str(row.settlement_id),
        source_event_key: str(row.amazon_line_key) ?? str(row.id),
        actual_quantity: intOrZero(row.quantity) || null,
        expected_amount: Math.abs(num(row.amount_total) ?? 0),
        event_date: str(row.posted_date),
        confidence: 0.7,
        reference_edges: edges([
          ["order_id", row.order_id],
          ["settlement_id", row.settlement_id],
        ]),
      }),
    );
    return { matched_count: count ?? drafts.length, drafts, notes: [] };
  },
};

/* ── 5) transaction ──────────────────────────────────────────────────────── */
const transaction: ClaimGeneratorDefinition = {
  source_kind: "transaction",
  title: "Amazon transactions — negative non-order adjustments",
  source_tables: ["amazon_transactions"],
  default_claim_family: "transaction_negative_adjustment",
  async generate(ctx): Promise<ClaimGeneratorOutput> {
    const filters = () =>
      ctx.client
        .from("amazon_transactions")
        .select(
          "id, organization_id, store_id, order_id, settlement_id, transaction_type, amount, sku, posted_date, resolved_product_id",
          { count: "exact" },
        )
        .eq("organization_id", ctx.organizationId)
        .lt("amount", 0)
        .neq("transaction_type", "Order")
        .gte("posted_date", ctx.window.from)
        .lte("posted_date", `${ctx.window.to}T23:59:59.999Z`);

    const { data, error, count } = await filters().limit(ctx.rowLimit);
    if (error) throw new Error(error.message);

    const drafts = ((data ?? []) as Row[]).map((row) =>
      makeDraft({
        ctx,
        source_kind: "transaction",
        claim_family: "transaction_negative_adjustment",
        claim_reason: `transaction_${String(row.transaction_type ?? "adjustment").toLowerCase().replace(/\W+/g, "_")}`,
        source_table: "amazon_transactions",
        row,
        reference_key: str(row.order_id) ?? str(row.settlement_id),
        source_event_key: str(row.id),
        expected_amount: Math.abs(num(row.amount) ?? 0),
        event_date: str(row.posted_date),
        confidence: 0.6,
        reference_edges: edges([
          ["order_id", row.order_id],
          ["settlement_id", row.settlement_id],
        ]),
      }),
    );
    return { matched_count: count ?? drafts.length, drafts, notes: [] };
  },
};

/* ── 6) inventory_ledger ─────────────────────────────────────────────────── */
const inventoryLedger: ClaimGeneratorDefinition = {
  source_kind: "inventory_ledger",
  title: "Inventory ledger — unreconciled negative adjustments",
  source_tables: ["amazon_inventory_ledger"],
  default_claim_family: "inventory_unreconciled_loss",
  async generate(ctx): Promise<ClaimGeneratorOutput> {
    const filters = () =>
      ctx.client
        .from("amazon_inventory_ledger")
        .select(
          "id, organization_id, store_id, fnsku, asin, sku, quantity, disposition, event_type, event_date, reference_id, reason_code, reconciled_quantity, unreconciled_quantity, resolved_product_id",
          { count: "exact" },
        )
        .eq("organization_id", ctx.organizationId)
        .lt("quantity", 0)
        .gt("unreconciled_quantity", 0)
        .gte("event_date", ctx.window.from)
        .lte("event_date", ctx.window.to);

    const { data, error, count } = await filters().limit(ctx.rowLimit);
    if (error) throw new Error(error.message);

    const drafts = ((data ?? []) as Row[]).map((row) =>
      makeDraft({
        ctx,
        source_kind: "inventory_ledger",
        claim_family: "inventory_unreconciled_loss",
        claim_reason: str(row.reason_code) ?? `ledger_${String(row.event_type ?? "adjustment").toLowerCase().replace(/\W+/g, "_")}`,
        source_table: "amazon_inventory_ledger",
        row,
        reference_key: str(row.reference_id),
        source_event_key: str(row.reference_id) ?? str(row.id),
        expected_quantity: 0,
        actual_quantity: intOrZero(row.quantity),
        event_date: str(row.event_date),
        confidence: 0.8,
        reference_edges: edges([["ledger_reference_id", row.reference_id]]),
        extra_metadata: {
          unreconciled_quantity: intOrZero(row.unreconciled_quantity),
          event_type: str(row.event_type),
        },
      }),
    );
    return { matched_count: count ?? drafts.length, drafts, notes: [] };
  },
};

/* ── 7) safet ────────────────────────────────────────────────────────────── */
const safet: ClaimGeneratorDefinition = {
  source_kind: "safet",
  title: "SAFE-T claims — open / unreimbursed follow-ups",
  source_tables: ["amazon_safet_claims"],
  default_claim_family: "safet_followup",
  async generate(ctx): Promise<ClaimGeneratorOutput> {
    const filters = () =>
      ctx.client
        .from("amazon_safet_claims")
        .select(
          "id, organization_id, store_id, safet_claim_id, order_id, asin, item_name, claim_reason, claim_status, claim_amount, total_reimbursement_amount, claim_date, resolved_product_id:product_id",
          { count: "exact" },
        )
        .eq("organization_id", ctx.organizationId)
        .gte("claim_date", ctx.window.from)
        .lte("claim_date", `${ctx.window.to}T23:59:59.999Z`);

    const { data, error, count } = await filters().limit(ctx.rowLimit * 2);
    if (error) throw new Error(error.message);

    const rows = ((data ?? []) as Row[]).filter((row) => {
      const status = String(row.claim_status ?? "").toLowerCase();
      const amount = num(row.claim_amount) ?? 0;
      const reimbursed = num(row.total_reimbursement_amount) ?? 0;
      return !status.includes("complete") || reimbursed < amount;
    });

    const drafts = rows.slice(0, ctx.rowLimit).map((row) =>
      makeDraft({
        ctx,
        source_kind: "safet",
        claim_family: "safet_followup",
        claim_reason: str(row.claim_reason) ?? "safet_underpaid_or_open",
        source_table: "amazon_safet_claims",
        row,
        reference_key: str(row.safet_claim_id) ?? str(row.order_id),
        source_event_key: str(row.safet_claim_id),
        expected_amount: num(row.claim_amount),
        event_date: str(row.claim_date),
        confidence: 0.85,
        reference_edges: edges([
          ["safet_claim_id", row.safet_claim_id],
          ["order_id", row.order_id],
        ]),
        extra_metadata: {
          claim_status: str(row.claim_status),
          total_reimbursement_amount: num(row.total_reimbursement_amount),
        },
      }),
    );
    return { matched_count: count ?? rows.length, drafts, notes: ["open/underpaid filter applied in memory"] };
  },
};

/* ── 8) delayed_not_received ─────────────────────────────────────────────── */
const delayedNotReceived: ClaimGeneratorDefinition = {
  source_kind: "delayed_not_received",
  title: "Expected shipments overdue — tracking never received",
  source_tables: ["expected_packages", "packages"],
  default_claim_family: "shipment_not_received",
  async generate(ctx): Promise<ClaimGeneratorOutput> {
    const overdueCutoff = new Date(
      Date.now() - ctx.settings.delayed_not_received_days * 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10);

    const { data, error } = await ctx.client
      .from("expected_packages")
      .select(
        "id, organization_id, store_id, order_id, sku, fnsku, disposition, tracking_number, expected_scan_quantity, actual_scanned_count, shipment_date, carrier, currency, resolved_product_id",
      )
      .eq("organization_id", ctx.organizationId)
      .not("tracking_number", "is", null)
      .gt("expected_scan_quantity", 0)
      .gte("shipment_date", ctx.window.from)
      .lte("shipment_date", overdueCutoff < ctx.window.to ? overdueCutoff : ctx.window.to)
      .limit(ctx.rowLimit * 4);
    if (error) throw new Error(error.message);

    const eps = (data ?? []) as Row[];
    const trackings = [...new Set(eps.map((r) => str(r.tracking_number)).filter((t): t is string => !!t))];
    const received = new Set<string>();
    for (let i = 0; i < trackings.length; i += 100) {
      const chunk = trackings.slice(i, i + 100);
      const { data: pkgs, error: pkgErr } = await ctx.client
        .from("packages")
        .select("tracking_number")
        .eq("organization_id", ctx.organizationId)
        .in("tracking_number", chunk)
        .is("deleted_at", null);
      if (pkgErr) throw new Error(pkgErr.message);
      for (const p of (pkgs ?? []) as Row[]) {
        const t = str(p.tracking_number);
        if (t) received.add(t);
      }
    }

    const rows = eps.filter((r) => {
      const t = str(r.tracking_number);
      return t !== null && !received.has(t) && intOrZero(r.actual_scanned_count) === 0;
    });

    const drafts = rows.slice(0, ctx.rowLimit).map((row) =>
      makeDraft({
        ctx,
        source_kind: "delayed_not_received",
        claim_family: "shipment_not_received",
        claim_reason: "tracking_overdue_never_received",
        source_table: "expected_packages",
        row,
        reference_key: str(row.tracking_number),
        source_event_key: str(row.tracking_number),
        expected_quantity: intOrZero(row.expected_scan_quantity),
        actual_quantity: 0,
        event_date: str(row.shipment_date),
        confidence: 0.75,
        reference_edges: edges([
          ["tracking_number", row.tracking_number],
          ["removal_order_id", row.order_id],
        ]),
        extra_metadata: {
          expected_package_id: str(row.id),
          carrier: str(row.carrier),
          overdue_days_threshold: ctx.settings.delayed_not_received_days,
        },
      }),
    );
    return {
      matched_count: rows.length,
      drafts,
      notes: ["matched against packages by tracking within fetched window cap"],
    };
  },
};

/* ── 9) inbound_shipment ─────────────────────────────────────────────────── */
const inboundShipment: ClaimGeneratorDefinition = {
  source_kind: "inbound_shipment",
  title: "Inbound shipments — quantity / problem discrepancies",
  source_tables: ["amazon_inbound_performance"],
  default_claim_family: "inbound_shipment_shortage",
  async generate(ctx): Promise<ClaimGeneratorOutput> {
    const filters = () =>
      ctx.client
        .from("amazon_inbound_performance")
        .select(
          "id, organization_id, store_id, fba_shipment_id, fba_carton_id, sku, fnsku, asin, product_name, problem_type, problem_quantity, expected_quantity, received_quantity, issue_reported_date, shipment_creation_date, fee_total, currency, problem_level, alert_status",
          { count: "exact" },
        )
        .eq("organization_id", ctx.organizationId)
        .gte("issue_reported_date", ctx.window.from)
        .lte("issue_reported_date", ctx.window.to);

    const { data, error, count } = await filters().limit(ctx.rowLimit * 2);
    if (error) throw new Error(error.message);

    const rows = ((data ?? []) as Row[]).filter((row) => {
      const expected = intOrZero(row.expected_quantity);
      const received = intOrZero(row.received_quantity);
      const problemQty = intOrZero(row.problem_quantity);
      if (problemQty > 0) return true;
      if (expected > 0 && received >= 0 && received < expected) return true;
      const level = String(row.problem_level ?? "").toLowerCase();
      return level.includes("problem") || level.includes("error");
    });

    const drafts = rows.slice(0, ctx.rowLimit).map((row) => {
      const expected = intOrZero(row.expected_quantity);
      const received = intOrZero(row.received_quantity);
      const problemQty = intOrZero(row.problem_quantity);
      return makeDraft({
        ctx,
        source_kind: "inbound_shipment",
        claim_family: "inbound_shipment_shortage",
        claim_reason: str(row.problem_type) ?? "inbound_quantity_discrepancy",
        source_table: "amazon_inbound_performance",
        row,
        reference_key: str(row.fba_shipment_id),
        source_event_key: str(row.fba_shipment_id) ?? str(row.id),
        expected_quantity: expected || null,
        actual_quantity: received || null,
        expected_amount: num(row.fee_total),
        currency: str(row.currency),
        event_date: str(row.issue_reported_date) ?? str(row.shipment_creation_date),
        confidence: 0.82,
        reference_edges: edges([
          ["fba_shipment_id", row.fba_shipment_id],
          ["fba_carton_id", row.fba_carton_id],
        ]),
        extra_metadata: {
          problem_type: str(row.problem_type),
          problem_quantity: problemQty,
          alert_status: str(row.alert_status),
        },
      });
    });

    return {
      matched_count: rows.length,
      drafts,
      notes: [`source rows in window: ${count ?? 0}; inbound problem filter applied in memory`],
    };
  },
};

/* ── 10) shipment_discrepancy ─────────────────────────────────────────────── */
const shipmentDiscrepancy: ClaimGeneratorDefinition = {
  source_kind: "shipment_discrepancy",
  title: "Received shipments — scanned vs expected quantity mismatch",
  source_tables: ["expected_packages"],
  default_claim_family: "shipment_quantity_mismatch",
  async generate(ctx): Promise<ClaimGeneratorOutput> {
    const { data, error } = await ctx.client
      .from("expected_packages")
      .select(
        "id, organization_id, store_id, order_id, sku, fnsku, disposition, tracking_number, expected_scan_quantity, actual_scanned_count, discrepancy_found, shipment_date, currency, resolved_product_id, allocated_package_id, allocated_pallet_id",
      )
      .eq("organization_id", ctx.organizationId)
      .gte("shipment_date", ctx.window.from)
      .lte("shipment_date", ctx.window.to)
      .or("discrepancy_found.eq.true,actual_scanned_count.gt.0")
      .limit(ctx.rowLimit * 4);
    if (error) throw new Error(error.message);

    const rows = ((data ?? []) as Row[]).filter((row) => {
      const expected = intOrZero(row.expected_scan_quantity);
      const actual = intOrZero(row.actual_scanned_count);
      if (row.discrepancy_found === true) return true;
      return expected > 0 && actual > 0 && actual !== expected;
    });

    const drafts = rows.slice(0, ctx.rowLimit).map((row) => {
      const expected = intOrZero(row.expected_scan_quantity);
      const actual = intOrZero(row.actual_scanned_count);
      return makeDraft({
        ctx,
        source_kind: "shipment_discrepancy",
        claim_family: "shipment_quantity_mismatch",
        claim_reason: actual > expected ? "shipment_over_received" : "shipment_under_received",
        source_table: "expected_packages",
        row,
        reference_key: str(row.tracking_number) ?? str(row.order_id),
        source_event_key: str(row.tracking_number),
        expected_quantity: expected,
        actual_quantity: actual,
        event_date: str(row.shipment_date),
        confidence: 0.8,
        reference_edges: edges([
          ["tracking_number", row.tracking_number],
          ["removal_order_id", row.order_id],
          ["package_id", row.allocated_package_id],
        ]),
        extra_metadata: {
          expected_package_id: str(row.id),
          package_id: str(row.allocated_package_id),
          pallet_id: str(row.allocated_pallet_id),
        },
      });
    });
    return { matched_count: rows.length, drafts, notes: ["mismatch filter applied in memory"] };
  },
};

/* ── 11) manual_import ───────────────────────────────────────────────────── */
const manualImport: ClaimGeneratorDefinition = {
  source_kind: "manual_import",
  title: "Manual import (settings-provided normalized rows)",
  source_tables: ["workspace_settings.module_configs.claim_intake.manual_import_rows"],
  default_claim_family: "manual_claim",
  async generate(ctx): Promise<ClaimGeneratorOutput> {
    const rows = ctx.settings.manual_import_rows;
    const drafts: ClaimCandidateDraft[] = [];
    const notes: string[] = [];
    for (const raw of rows.slice(0, ctx.rowLimit)) {
      const sourceRowId = str(raw.source_row_id);
      const family = str(raw.claim_family) ?? "manual_claim";
      if (!sourceRowId) {
        notes.push("manual_import row skipped: missing source_row_id");
        continue;
      }
      const kindRaw = str(raw.source_kind);
      // legacy_seed is not a generator kind and must never enter via manual import.
      if (kindRaw && !isClaimSourceKind(kindRaw)) {
        notes.push(`manual_import row skipped: invalid source_kind ${kindRaw}`);
        continue;
      }
      drafts.push(
        makeDraft({
          ctx,
          source_kind: "manual_import",
          claim_family: family,
          claim_reason: str(raw.claim_reason) ?? "manual_import",
          source_table: str(raw.source_table) ?? "manual_import",
          row: { ...raw, id: sourceRowId },
          reference_key: str(raw.reference_key),
          source_event_key: str(raw.source_event_key) ?? sourceRowId,
          expected_quantity: num(raw.expected_quantity),
          actual_quantity: num(raw.actual_quantity),
          expected_amount: num(raw.expected_amount),
          event_date: str(raw.event_date),
          confidence: 1,
        }),
      );
    }
    return { matched_count: drafts.length, drafts, notes };
  },
};

import { orbitFraGenerator } from "./claim-orbit-fra-generator";

export const CLAIM_INTAKE_GENERATORS: ClaimGeneratorDefinition[] = [
  scannerPhysicalReview,
  amazonRemovalApi,
  reimbursement,
  settlement,
  transaction,
  inventoryLedger,
  safet,
  delayedNotReceived,
  inboundShipment,
  shipmentDiscrepancy,
  manualImport,
  orbitFraGenerator,
];
