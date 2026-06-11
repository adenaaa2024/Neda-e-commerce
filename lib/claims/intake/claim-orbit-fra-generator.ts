/**
 * Phase 7C — ORBIT-FRA generator (source_kind 'orbit_fra').
 *
 * Implements the ORBIT-FRA claim source model over the unified pool:
 *   * 18 claim categories across 9 source reports
 *   * reference_id / reference_type per category
 *   * units-affected calculation per category
 *   * COGS per unit (SellerSnap when available; staging fallback: settings
 *     overrides -> recent return_items unit value per product grain)
 *   * recovery_value = units x cogs_unit, else report amount
 *   * Evidence Summary template per candidate (metadata + evidence_summary)
 *   * dispute window status: dispute_deadline + days_remaining snapshot
 *   * source report coverage gaps reported in notes
 *
 * Reads ONLY trusted source tables — never claim_candidates / legacy_seed.
 */
import { returnItemNotesMarkOffSlip } from "../../scanner/item-scan-off-slip";
import { shouldExcludeReturnItemFromScannerCounts } from "../../scanner/return-items-test-data-guard";
import {
  isPhysicalEventClaimable,
  loadClaimCandidateIntakePolicy,
  type ClaimablePhysicalEvent,
} from "../../claim-candidate-intake-policy";
import { edges, makeDraft } from "./claim-intake-generators";
import type {
  ClaimCandidateDraft,
  ClaimGeneratorContext,
  ClaimGeneratorDefinition,
  ClaimGeneratorOutput,
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

function isoDate(v: unknown): string | null {
  const s = str(v);
  return s ? s.slice(0, 10) : null;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysRemaining(deadline: string, now: Date = new Date()): number {
  const ms = new Date(`${deadline}T23:59:59Z`).getTime() - now.getTime();
  return Math.floor(ms / 86_400_000);
}

/** The 9 ORBIT-FRA source reports available on this stack. */
const SOURCE_REPORTS = [
  { report: "scanner_returns", table: "return_items" },
  { report: "removal_orders", table: "amazon_removals" },
  { report: "removal_shipments", table: "amazon_removal_shipments" },
  { report: "reimbursements", table: "amazon_reimbursements" },
  { report: "settlements", table: "amazon_settlements" },
  { report: "transactions", table: "amazon_transactions" },
  { report: "inventory_ledger", table: "amazon_inventory_ledger" },
  { report: "safet_claims", table: "amazon_safet_claims" },
  { report: "expected_shipments", table: "expected_packages" },
] as const;

type OrbitHit = {
  row: Row;
  units: number;
  reportAmount: number | null;
  reason: string;
  referenceKey: string | null;
};

type OrbitCategory = {
  key: string;
  title: string;
  source_report: (typeof SOURCE_REPORTS)[number]["report"];
  source_table: string;
  reference_type: string;
  window_days: number;
  event_date_of: (row: Row) => string | null;
  classify: (rows: Row[], ctx: ClaimGeneratorContext) => OrbitHit[];
};

function ledgerReason(row: Row): string {
  return str(row.reason_code) ?? str(row.event_type) ?? "ledger_adjustment";
}

const ORBIT_CATEGORIES: OrbitCategory[] = [
  /* ── inventory_ledger (4 categories) ── */
  {
    key: "warehouse_lost",
    title: "Warehouse lost inventory (unreconciled)",
    source_report: "inventory_ledger",
    source_table: "amazon_inventory_ledger",
    reference_type: "ledger_reference_id",
    window_days: 545,
    event_date_of: (r) => isoDate(r.event_date),
    classify: (rows) =>
      rows
        .filter(
          (r) =>
            intOrZero(r.quantity) < 0 &&
            intOrZero(r.unreconciled_quantity) > 0 &&
            String(r.reason_code ?? "").toUpperCase().startsWith("M"),
        )
        .map((row) => ({
          row,
          units: intOrZero(row.unreconciled_quantity),
          reportAmount: null,
          reason: `warehouse_lost_${ledgerReason(row)}`,
          referenceKey: str(row.reference_id),
        })),
  },
  {
    key: "warehouse_damaged",
    title: "Warehouse damaged inventory (unreconciled)",
    source_report: "inventory_ledger",
    source_table: "amazon_inventory_ledger",
    reference_type: "ledger_reference_id",
    window_days: 545,
    event_date_of: (r) => isoDate(r.event_date),
    classify: (rows) =>
      rows
        .filter((r) => {
          const code = String(r.reason_code ?? "").toUpperCase();
          return (
            intOrZero(r.quantity) < 0 &&
            intOrZero(r.unreconciled_quantity) > 0 &&
            (code.startsWith("D") || code.startsWith("E"))
          );
        })
        .map((row) => ({
          row,
          units: intOrZero(row.unreconciled_quantity),
          reportAmount: null,
          reason: `warehouse_damaged_${ledgerReason(row)}`,
          referenceKey: str(row.reference_id),
        })),
  },
  {
    key: "destroyed_without_permission",
    title: "Inventory destroyed / disposed without authorization",
    source_report: "inventory_ledger",
    source_table: "amazon_inventory_ledger",
    reference_type: "ledger_reference_id",
    window_days: 545,
    event_date_of: (r) => isoDate(r.event_date),
    classify: (rows) =>
      rows
        .filter((r) => {
          const ev = String(r.event_type ?? "").toLowerCase();
          return (
            intOrZero(r.quantity) < 0 &&
            intOrZero(r.unreconciled_quantity) > 0 &&
            (ev.includes("dispos") || ev.includes("destro") || String(r.reason_code ?? "").toUpperCase().startsWith("Q"))
          );
        })
        .map((row) => ({
          row,
          units: intOrZero(row.unreconciled_quantity),
          reportAmount: null,
          reason: `destroyed_${ledgerReason(row)}`,
          referenceKey: str(row.reference_id),
        })),
  },
  {
    key: "inventory_adjustment_unreconciled",
    title: "Other unreconciled negative ledger adjustments",
    source_report: "inventory_ledger",
    source_table: "amazon_inventory_ledger",
    reference_type: "ledger_reference_id",
    window_days: 545,
    event_date_of: (r) => isoDate(r.event_date),
    classify: (rows) =>
      rows
        .filter((r) => {
          const code = String(r.reason_code ?? "").toUpperCase();
          const ev = String(r.event_type ?? "").toLowerCase();
          const claimed =
            code.startsWith("M") ||
            code.startsWith("D") ||
            code.startsWith("E") ||
            code.startsWith("Q") ||
            ev.includes("dispos") ||
            ev.includes("destro");
          return intOrZero(r.quantity) < 0 && intOrZero(r.unreconciled_quantity) > 0 && !claimed;
        })
        .map((row) => ({
          row,
          units: intOrZero(row.unreconciled_quantity),
          reportAmount: null,
          reason: `adjustment_${ledgerReason(row)}`,
          referenceKey: str(row.reference_id),
        })),
  },

  /* ── scanner returns (2 categories) ── */
  {
    key: "physical_return_damaged",
    title: "Physical return received damaged / unsellable",
    source_report: "scanner_returns",
    source_table: "return_items",
    reference_type: "order_id",
    window_days: 545,
    event_date_of: (r) => isoDate(r.created_at),
    classify: (rows) =>
      rows
        .filter((r) => {
          const conditions = Array.isArray(r.conditions)
            ? r.conditions.map((c) => String(c ?? "").toLowerCase())
            : [];
          return conditions.some((c) => c && c !== "sellable_ok" && c !== "sellable");
        })
        .map((row) => ({
          row,
          units: Math.max(1, intOrZero(row.scanned_quantity)),
          reportAmount: num(row.estimated_value) ?? num(row.unit_sale_price),
          reason: "operator_flagged_condition",
          referenceKey: str(row.order_id) ?? str(row.package_id),
        })),
  },
  {
    key: "physical_return_off_manifest",
    title: "Physical unit scanned off manifest",
    source_report: "scanner_returns",
    source_table: "return_items",
    reference_type: "package_id",
    window_days: 545,
    event_date_of: (r) => isoDate(r.created_at),
    classify: (rows) =>
      rows
        .filter((r) => returnItemNotesMarkOffSlip(str(r.notes)))
        .map((row) => ({
          row,
          units: Math.max(1, intOrZero(row.scanned_quantity)),
          reportAmount: num(row.estimated_value) ?? num(row.unit_sale_price),
          reason: "scanned_off_manifest_unit",
          referenceKey: str(row.package_id) ?? str(row.order_id),
        })),
  },

  /* ── removal orders (2 categories) ── */
  {
    key: "removal_units_unaccounted",
    title: "Removal order units unaccounted",
    source_report: "removal_orders",
    source_table: "amazon_removals",
    reference_type: "removal_order_id",
    window_days: 545,
    event_date_of: (r) => isoDate(r.order_date),
    classify: (rows) =>
      rows
        .map((row) => {
          const requested = intOrZero(row.requested_quantity);
          const accounted =
            intOrZero(row.shipped_quantity) +
            intOrZero(row.disposed_quantity) +
            intOrZero(row.cancelled_quantity) +
            intOrZero(row.in_process_quantity);
          return { row, missing: requested - accounted };
        })
        .filter((x) => x.missing > 0)
        .map(({ row, missing }) => ({
          row,
          units: missing,
          reportAmount: null,
          reason: "removal_units_unaccounted",
          referenceKey: str(row.order_id),
        })),
  },
  {
    key: "removal_in_process_stalled",
    title: "Removal units stuck in process beyond 30 days",
    source_report: "removal_orders",
    source_table: "amazon_removals",
    reference_type: "removal_order_id",
    window_days: 545,
    event_date_of: (r) => isoDate(r.order_date),
    classify: (rows) => {
      const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      return rows
        .filter(
          (r) => intOrZero(r.in_process_quantity) > 0 && (isoDate(r.order_date) ?? "9999") < cutoff,
        )
        .map((row) => ({
          row,
          units: intOrZero(row.in_process_quantity),
          reportAmount: null,
          reason: "removal_in_process_stalled_30d",
          referenceKey: str(row.order_id),
        }));
    },
  },

  /* ── removal shipments (2 categories) ── */
  {
    key: "removal_shipment_lost_in_transit",
    title: "Removal shipment shipped but never received",
    source_report: "removal_shipments",
    source_table: "amazon_removal_shipments",
    reference_type: "tracking_number",
    window_days: 545,
    event_date_of: (r) => isoDate(r.shipment_date),
    classify: (rows, ctx) => {
      // receivedTrackings is injected by the fetch step via ctx-scoped cache (see generate()).
      const received = orbitReceivedTrackings.get(ctx.organizationId) ?? new Set<string>();
      const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
      return rows
        .filter((r) => {
          const t = str(r.tracking_number);
          return (
            t !== null &&
            intOrZero(r.shipped_quantity) > 0 &&
            (isoDate(r.shipment_date) ?? "9999") < cutoff &&
            !received.has(t)
          );
        })
        .map((row) => ({
          row,
          units: intOrZero(row.shipped_quantity),
          reportAmount: null,
          reason: "removal_shipment_overdue_unreceived",
          referenceKey: str(row.tracking_number),
        }));
    },
  },
  {
    key: "removal_shipment_missing_units_row",
    title: "Removal shipment manifest row without unit quantity",
    source_report: "removal_shipments",
    source_table: "amazon_removal_shipments",
    reference_type: "tracking_number",
    window_days: 545,
    event_date_of: (r) => isoDate(r.shipment_date),
    classify: (rows) =>
      rows
        .filter((r) => str(r.tracking_number) !== null && intOrZero(r.shipped_quantity) === 0)
        .map((row) => ({
          row,
          units: 0,
          reportAmount: null,
          reason: "shipment_row_missing_quantity",
          referenceKey: str(row.tracking_number),
        })),
  },

  /* ── reimbursements (2 categories) ── */
  {
    key: "reimbursement_clawback",
    title: "Reimbursement reversed / clawed back",
    source_report: "reimbursements",
    source_table: "amazon_reimbursements",
    reference_type: "reimbursement_id",
    window_days: 90,
    event_date_of: (r) => isoDate(r.approval_date),
    classify: (rows) =>
      rows
        .filter((r) => (num(r.amount_total) ?? 0) < 0)
        .map((row) => ({
          row,
          units: intOrZero(row.quantity_reimbursed_total),
          reportAmount: Math.abs(num(row.amount_total) ?? 0),
          reason: str(row.reason) ?? "reimbursement_clawback",
          referenceKey: str(row.reimbursement_id),
        })),
  },
  {
    key: "reimbursement_zero_cash_inventory_only",
    title: "Inventory-only reimbursement to validate against COGS",
    source_report: "reimbursements",
    source_table: "amazon_reimbursements",
    reference_type: "reimbursement_id",
    window_days: 90,
    event_date_of: (r) => isoDate(r.approval_date),
    classify: (rows) =>
      rows
        .filter(
          (r) =>
            intOrZero(r.quantity_reimbursed_inventory) > 0 &&
            intOrZero(r.quantity_reimbursed_cash) === 0 &&
            (num(r.amount_total) ?? 0) === 0,
        )
        .map((row) => ({
          row,
          units: intOrZero(row.quantity_reimbursed_inventory),
          reportAmount: null,
          reason: "inventory_only_reimbursement_review",
          referenceKey: str(row.reimbursement_id),
        })),
  },

  /* ── settlements (2 categories) ── */
  {
    key: "settlement_refund_review",
    title: "Settlement refund / chargeback lines",
    source_report: "settlements",
    source_table: "amazon_settlements",
    reference_type: "order_id",
    window_days: 90,
    event_date_of: (r) => isoDate(r.posted_date),
    classify: (rows) =>
      rows
        .filter(
          (r) =>
            ["refund", "chargeback refund", "a-to-z guarantee refund"].includes(
              String(r.transaction_type ?? "").toLowerCase(),
            ) && (num(r.amount_total) ?? 0) < 0,
        )
        .map((row) => ({
          row,
          units: Math.max(1, intOrZero(row.quantity)),
          reportAmount: Math.abs(num(row.amount_total) ?? 0),
          reason: `settlement_${String(row.transaction_type ?? "refund").toLowerCase().replace(/\W+/g, "_")}`,
          referenceKey: str(row.order_id) ?? str(row.settlement_id),
        })),
  },
  {
    key: "settlement_adjustment_credit",
    title: "Settlement adjustment / reimbursement credit lines (cross-check)",
    source_report: "settlements",
    source_table: "amazon_settlements",
    reference_type: "settlement_id",
    window_days: 90,
    event_date_of: (r) => isoDate(r.posted_date),
    classify: (rows) =>
      rows
        .filter((r) => {
          const tt = String(r.transaction_type ?? "").toLowerCase();
          const desc = String(r.description ?? "").toLowerCase();
          return (
            (tt.includes("adjust") || desc.includes("reimburse")) && (num(r.amount_total) ?? 0) > 0
          );
        })
        .map((row) => ({
          row,
          units: intOrZero(row.quantity),
          reportAmount: num(row.amount_total),
          reason: "settlement_adjustment_credit_crosscheck",
          referenceKey: str(row.settlement_id) ?? str(row.order_id),
        })),
  },

  /* ── transactions (1 category) ── */
  {
    key: "transaction_negative_adjustment",
    title: "Negative non-order transaction adjustments",
    source_report: "transactions",
    source_table: "amazon_transactions",
    reference_type: "order_id",
    window_days: 90,
    event_date_of: (r) => isoDate(r.posted_date),
    classify: (rows) =>
      rows
        .filter(
          (r) => (num(r.amount) ?? 0) < 0 && String(r.transaction_type ?? "") !== "Order",
        )
        .map((row) => ({
          row,
          units: 0,
          reportAmount: Math.abs(num(row.amount) ?? 0),
          reason: `transaction_${String(row.transaction_type ?? "adjustment").toLowerCase().replace(/\W+/g, "_")}`,
          referenceKey: str(row.order_id) ?? str(row.settlement_id),
        })),
  },

  /* ── safet (1 category) ── */
  {
    key: "safet_underpaid_or_open",
    title: "SAFE-T claim open or reimbursed below claim amount",
    source_report: "safet_claims",
    source_table: "amazon_safet_claims",
    reference_type: "safet_claim_id",
    window_days: 60,
    event_date_of: (r) => isoDate(r.claim_date),
    classify: (rows) =>
      rows
        .filter((r) => {
          const status = String(r.claim_status ?? "").toLowerCase();
          const claimed = num(r.claim_amount) ?? 0;
          const paid = num(r.total_reimbursement_amount) ?? 0;
          return !status.includes("complete") || paid < claimed;
        })
        .map((row) => ({
          row,
          units: 0,
          reportAmount: Math.max(0, (num(row.claim_amount) ?? 0) - (num(row.total_reimbursement_amount) ?? 0)),
          reason: str(row.claim_reason) ?? "safet_underpaid_or_open",
          referenceKey: str(row.safet_claim_id),
        })),
  },

  /* ── expected shipments (2 categories) ── */
  {
    key: "shipment_not_received_overdue",
    title: "Expected shipment overdue — tracking never received",
    source_report: "expected_shipments",
    source_table: "expected_packages",
    reference_type: "tracking_number",
    window_days: 270,
    event_date_of: (r) => isoDate(r.shipment_date),
    classify: (rows, ctx) => {
      const received = orbitReceivedTrackings.get(ctx.organizationId) ?? new Set<string>();
      const cutoff = new Date(
        Date.now() - ctx.settings.delayed_not_received_days * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      return rows
        .filter((r) => {
          const t = str(r.tracking_number);
          return (
            t !== null &&
            intOrZero(r.expected_scan_quantity) > 0 &&
            intOrZero(r.actual_scanned_count) === 0 &&
            (isoDate(r.shipment_date) ?? "9999") < cutoff &&
            !received.has(t)
          );
        })
        .map((row) => ({
          row,
          units: intOrZero(row.expected_scan_quantity),
          reportAmount: null,
          reason: "tracking_overdue_never_received",
          referenceKey: str(row.tracking_number),
        }));
    },
  },
  {
    key: "shipment_quantity_mismatch",
    title: "Received shipment scanned vs expected mismatch",
    source_report: "expected_shipments",
    source_table: "expected_packages",
    reference_type: "tracking_number",
    window_days: 270,
    event_date_of: (r) => isoDate(r.shipment_date),
    classify: (rows) =>
      rows
        .filter((r) => {
          const expected = intOrZero(r.expected_scan_quantity);
          const actual = intOrZero(r.actual_scanned_count);
          return r.discrepancy_found === true || (expected > 0 && actual > 0 && actual !== expected);
        })
        .map((row) => {
          const expected = intOrZero(row.expected_scan_quantity);
          const actual = intOrZero(row.actual_scanned_count);
          return {
            row,
            units: Math.abs(expected - actual),
            reportAmount: null,
            reason: actual > expected ? "shipment_over_received" : "shipment_under_received",
            referenceKey: str(row.tracking_number) ?? str(row.order_id),
          };
        }),
  },
];

/** Per-run cache of received tracking numbers (keyed by org). */
const orbitReceivedTrackings = new Map<string, Set<string>>();

const TABLE_SELECTS: Record<string, { select: string; dateColumn: string }> = {
  return_items: {
    select:
      "id, organization_id, store_id, package_id, pallet_id, order_id, sku, fnsku, asin, product_identifier, item_name, notes, conditions, scanned_quantity, unit_sale_price, estimated_value, resolved_product_id, created_at",
    dateColumn: "created_at",
  },
  amazon_removals: {
    select:
      "id, organization_id, store_id, order_id, sku, fnsku, disposition, requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity, in_process_quantity, status, tracking_number, order_date, currency, resolved_product_id",
    dateColumn: "order_date",
  },
  amazon_removal_shipments: {
    select:
      "id, organization_id, store_id, order_id, sku, fnsku, disposition, tracking_number, carrier, shipment_date, shipped_quantity, resolved_product_id",
    dateColumn: "shipment_date",
  },
  amazon_reimbursements: {
    select:
      "id, organization_id, store_id, order_id, reimbursement_id, original_reimbursement_id, reason, case_id, sku, fnsku, asin, amount_total, currency_unit, quantity_reimbursed_total, quantity_reimbursed_cash, quantity_reimbursed_inventory, approval_date, product_id",
    dateColumn: "approval_date",
  },
  amazon_settlements: {
    select:
      "id, organization_id, store_id, order_id, settlement_id, amazon_line_key, sku, transaction_type, description, amount_total, currency, quantity, posted_date, resolved_product_id",
    dateColumn: "posted_date",
  },
  amazon_transactions: {
    select:
      "id, organization_id, store_id, order_id, settlement_id, transaction_type, amount, sku, posted_date, resolved_product_id",
    dateColumn: "posted_date",
  },
  amazon_inventory_ledger: {
    select:
      "id, organization_id, store_id, fnsku, asin, sku, quantity, disposition, event_type, event_date, reference_id, reason_code, reconciled_quantity, unreconciled_quantity, resolved_product_id",
    dateColumn: "event_date",
  },
  amazon_safet_claims: {
    select:
      "id, organization_id, store_id, safet_claim_id, order_id, asin, item_name, claim_reason, claim_status, claim_amount, total_reimbursement_amount, claim_date, product_id",
    dateColumn: "claim_date",
  },
  expected_packages: {
    select:
      "id, organization_id, store_id, order_id, sku, fnsku, disposition, tracking_number, expected_scan_quantity, actual_scanned_count, discrepancy_found, shipment_date, currency, resolved_product_id",
    dateColumn: "shipment_date",
  },
};

async function fetchTable(
  ctx: ClaimGeneratorContext,
  table: string,
  cap: number,
): Promise<Row[]> {
  const spec = TABLE_SELECTS[table]!;
  let q = ctx.client
    .from(table)
    .select(spec.select)
    .eq("organization_id", ctx.organizationId)
    .gte(spec.dateColumn, ctx.window.from)
    .lte(spec.dateColumn, `${ctx.window.to}T23:59:59.999Z`)
    .limit(cap);
  if (table === "return_items") q = q.is("deleted_at", null);
  const { data, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  let rows = (data ?? []) as unknown as Row[];
  if (table === "return_items") {
    rows = rows.filter(
      (r) =>
        !shouldExcludeReturnItemFromScannerCounts({
          item_name: str(r.item_name),
          sku: str(r.sku),
          fnsku: str(r.fnsku),
          product_identifier: str(r.product_identifier),
          notes: str(r.notes),
        }),
    );
  }
  return rows;
}

async function loadReceivedTrackings(
  ctx: ClaimGeneratorContext,
  trackings: string[],
): Promise<void> {
  const received = new Set<string>();
  const unique = [...new Set(trackings)];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const { data } = await ctx.client
      .from("packages")
      .select("tracking_number")
      .eq("organization_id", ctx.organizationId)
      .in("tracking_number", chunk)
      .is("deleted_at", null);
    for (const p of (data ?? []) as Row[]) {
      const t = str(p.tracking_number);
      if (t) received.add(t);
    }
  }
  orbitReceivedTrackings.set(ctx.organizationId, received);
}

/**
 * COGS resolver: settings overrides (claim_intake.cogs_overrides sku->cost)
 * win; staging fallback is the most recent return_items unit value per grain.
 * SellerSnap feed plugs in here when its table lands.
 */
function buildCogsResolver(
  returnItems: Row[],
  overrides: Record<string, unknown>,
): (row: Row) => number | null {
  const byGrain = new Map<string, number>();
  for (const r of returnItems) {
    const value = num(r.estimated_value) ?? num(r.unit_sale_price);
    if (value == null || value <= 0) continue;
    for (const key of [str(r.fnsku), str(r.sku), str(r.asin)]) {
      if (key && !byGrain.has(key.toLowerCase())) byGrain.set(key.toLowerCase(), value);
    }
  }
  return (row: Row) => {
    for (const key of [str(row.sku), str(row.fnsku), str(row.asin)]) {
      if (!key) continue;
      const override = num(overrides[key]);
      if (override != null && override > 0) return override;
      const fallback = byGrain.get(key.toLowerCase());
      if (fallback != null) return fallback;
    }
    return null;
  };
}

function evidenceSummary(args: {
  category: OrbitCategory;
  hit: OrbitHit;
  eventDate: string | null;
  recovery: number | null;
}): string {
  const r = args.hit.row;
  const product = str(r.fnsku) ?? str(r.sku) ?? str(r.asin) ?? "unknown product";
  const units = args.hit.units > 0 ? `${args.hit.units} unit(s)` : "amount-based";
  const recovery = args.recovery != null ? ` Expected recovery $${args.recovery.toFixed(2)}.` : "";
  return (
    `${args.category.title}: ${units} of ${product} on ${args.eventDate ?? "unknown date"}. ` +
    `Source report ${args.category.source_report} (${args.category.source_table}), ` +
    `${args.category.reference_type}=${args.hit.referenceKey ?? "n/a"}, reason ${args.hit.reason}.` +
    recovery
  );
}

export const orbitFraGenerator: ClaimGeneratorDefinition = {
  source_kind: "orbit_fra",
  title: "ORBIT-FRA — 18-category FBA recovery sweep across 9 source reports",
  source_tables: SOURCE_REPORTS.map((s) => s.table),
  default_claim_family: "orbit_fra_recovery",
  async generate(ctx): Promise<ClaimGeneratorOutput> {
    const notes: string[] = [];
    const perCategoryCap = Math.max(25, Math.floor(ctx.rowLimit / 6));
    const tableCap = ctx.rowLimit * 4;

    const rowsByTable = new Map<string, Row[]>();
    for (const src of SOURCE_REPORTS) {
      try {
        rowsByTable.set(src.table, await fetchTable(ctx, src.table, tableCap));
      } catch (e) {
        rowsByTable.set(src.table, []);
        notes.push(`coverage_gap: ${src.report} fetch failed — ${e instanceof Error ? e.message : e}`);
      }
    }

    // Coverage gaps: source reports with no rows in window.
    for (const src of SOURCE_REPORTS) {
      if ((rowsByTable.get(src.table) ?? []).length === 0) {
        notes.push(`coverage_gap: ${src.report} has 0 rows in window ${ctx.window.from}..${ctx.window.to}`);
      }
    }

    // Tracking receipt cache for in-transit categories.
    const trackingRows = [
      ...(rowsByTable.get("amazon_removal_shipments") ?? []),
      ...(rowsByTable.get("expected_packages") ?? []),
    ]
      .map((r) => str(r.tracking_number))
      .filter((t): t is string => t !== null);
    await loadReceivedTrackings(ctx, trackingRows);

    const cogsResolver = buildCogsResolver(
      rowsByTable.get("return_items") ?? [],
      ctx.settings.cogs_overrides,
    );

    // Physical-event claimability policy (over_received / unexpected_item toggles etc.).
    const intakePolicy = await loadClaimCandidateIntakePolicy(ctx.client, ctx.organizationId);
    const categoryPhysicalEvent: Record<string, ClaimablePhysicalEvent> = {
      physical_return_damaged: "damaged",
      physical_return_off_manifest: "unexpected_item",
    };

    const drafts: ClaimCandidateDraft[] = [];
    let matched = 0;
    const now = new Date();

    for (const category of ORBIT_CATEGORIES) {
      const physicalEvent = categoryPhysicalEvent[category.key];
      if (physicalEvent && !isPhysicalEventClaimable(intakePolicy, physicalEvent)) {
        notes.push(`category_disabled_by_policy: ${category.key} (${physicalEvent} not claimable)`);
        continue;
      }
      const rows = rowsByTable.get(category.source_table) ?? [];
      let hits: OrbitHit[] = [];
      try {
        hits = category.classify(rows, ctx);
      } catch (e) {
        notes.push(`category_error: ${category.key} — ${e instanceof Error ? e.message : e}`);
        continue;
      }
      if (category.key === "shipment_quantity_mismatch" && !intakePolicy.claim_over_received) {
        const before = hits.length;
        hits = hits.filter((h) => h.reason !== "shipment_over_received");
        if (hits.length !== before) {
          notes.push(`over_received_suppressed_by_policy: ${before - hits.length}`);
        }
      }
      matched += hits.length;
      if (!hits.length) continue;

      for (const hit of hits.slice(0, perCategoryCap)) {
        const eventDate = category.event_date_of(hit.row);
        const deadline = eventDate ? addDays(eventDate, category.window_days) : null;
        const remaining = deadline ? daysRemaining(deadline, now) : null;
        const cogs = hit.units > 0 ? cogsResolver(hit.row) : null;
        const recovery =
          hit.units > 0 && cogs != null
            ? Math.round(hit.units * cogs * 100) / 100
            : (hit.reportAmount ?? null);

        drafts.push(
          makeDraft({
            ctx,
            source_kind: "orbit_fra",
            claim_family: category.key,
            claim_reason: hit.reason,
            source_table: category.source_table,
            row: hit.row,
            reference_key: hit.referenceKey,
            reference_type: category.reference_type,
            source_event_key: hit.referenceKey ?? str(hit.row.id),
            expected_quantity: hit.units > 0 ? hit.units : null,
            actual_quantity: hit.units > 0 ? 0 : null,
            expected_amount: hit.reportAmount,
            event_date: eventDate,
            dispute_deadline: deadline,
            days_remaining: remaining,
            recovery_value: recovery,
            cogs_unit: cogs,
            evidence_summary: evidenceSummary({ category, hit, eventDate, recovery }),
            confidence: remaining != null && remaining < 0 ? 0.4 : 0.8,
            reference_edges: edges([
              [category.reference_type, hit.referenceKey],
              ["order_id", hit.row.order_id],
              ["tracking_number", hit.row.tracking_number],
              ["settlement_id", hit.row.settlement_id],
            ]),
            extra_metadata: {
              orbit_category: category.key,
              orbit_source_report: category.source_report,
              window_days: category.window_days,
              window_status:
                remaining == null ? "unknown" : remaining < 0 ? "expired" : remaining <= 14 ? "closing_soon" : "open",
              units_affected: hit.units,
            },
          }),
        );
      }
      if (hits.length > perCategoryCap) {
        notes.push(`category_capped: ${category.key} matched ${hits.length}, drafted ${perCategoryCap}`);
      }
    }

    notes.push(`categories_evaluated: ${ORBIT_CATEGORIES.length}; source_reports: ${SOURCE_REPORTS.length}`);
    return { matched_count: matched, drafts, notes };
  },
};

export const ORBIT_FRA_CATEGORY_COUNT = ORBIT_CATEGORIES.length;
export const ORBIT_FRA_SOURCE_REPORT_COUNT = SOURCE_REPORTS.length;
