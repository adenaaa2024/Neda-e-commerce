/**
 * PHASE-CLAIM-EVENT-REFERENCE-LEDGER-AND-TRID-CORRECTION-V1
 *
 * Read-only composer that resolves, per pilot claim submission, the REAL external
 * Amazon event / report references (removal order id, removal shipment + tracking,
 * reimbursement id, transaction / settlement, inventory ledger reference) by joining
 * the materialized reference graph surrogates to the underlying Amazon source tables,
 * and cleanly separates them from internal DB UUID anchors.
 *
 * Correctness rules (Maysam):
 *  - An internal DB UUID (expected_packages.id, amazon_removals.id pointer, claim_*.id,
 *    resolved_product_id) is NEVER surfaced as a "TRID" / Amazon reference. It goes in
 *    `internal_anchors`.
 *  - The Primary Reference Anchor prefers a real external Amazon reference; only falls
 *    back to an internal anchor (labelled as such) when no external reference exists.
 *  - A claim with zero external/source references is flagged `needs_reference_review`.
 *  - Event date/time is reported but is NOT used as a join filter (documented).
 *
 * Hard rules (by construction): no DB writes, no claim_* mutation, no Amazon call,
 * no scanner change, no AI. All reads are defensive (missing column/table tolerated).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ClaimEventReferenceLedger,
  DeepReferenceCensus,
  DeepReferenceFilingSufficiency,
  DeepReferenceSourceGroup,
  DeepReferenceSourceStatus,
  DeepReferenceTableCensus,
  EventReferenceConfidence,
  EventReferenceRow,
  InternalAnchorRow,
  PrimaryReferenceAnchor,
} from "../filing/claim-ready-to-file-queue-ui-contract";
import type { PerSubmissionReferenceTrace } from "./trid-reference-trace-matrix-v1";

export const CLAIM_EVENT_REFERENCE_LEDGER_V1 = "claim-event-reference-ledger-v1" as const;

/**
 * Deep search now runs a bounded event-date WINDOW pass (fnsku/sku ± window around the
 * removal/shipment event) for inventory-ledger / reimbursement / transaction candidates,
 * in addition to exact order_id / row-id materialized matches. Window matches are surfaced
 * as weak/ambiguous candidates (NOT auto-materialized, NOT in the Seller Central block).
 */
export const EVENT_DATETIME_FILTER_USED = true as const;
export const EVENT_DATETIME_WINDOW_DAYS = 45 as const;
export const EVENT_DATETIME_NOTE =
  "Materialized references resolve by row id / order_id. A bounded ±" +
  `${EVENT_DATETIME_WINDOW_DAYS}` +
  "-day event-date window pass (anchored on the removal order/shipment date, matched by " +
  "FNSKU/SKU) is run to surface candidate inventory-ledger / reimbursement / transaction rows " +
  "that exist in loaded reports but are not order-linked. Window candidates are advisory only " +
  "(weak/ambiguous) and are excluded from the Seller Central filing block.";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function s(v: unknown): string {
  return String(v ?? "").trim();
}

function isUuid(v: unknown): boolean {
  return UUID_RE.test(s(v));
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type Row = Record<string, unknown>;

type MiniResult = { data: unknown; error: { message: string } | null };

/** Shallow PostgREST builder shape — avoids deep generic instantiation. */
interface MiniQuery extends PromiseLike<MiniResult> {
  select(cols: string): MiniQuery;
  eq(col: string, val: string): MiniQuery;
  in(col: string, vals: string[]): MiniQuery;
  gte(col: string, val: string): MiniQuery;
  lte(col: string, val: string): MiniQuery;
  limit(n: number): MiniQuery;
}

type MiniCountResult = { count: number | null; error: { message: string } | null };
interface MiniCountQuery extends PromiseLike<MiniCountResult> {
  select(cols: string, opts: { count: "exact"; head: true }): MiniCountQuery;
  eq(col: string, val: string): MiniCountQuery;
  in(col: string, vals: string[]): MiniCountQuery;
}

/** Defensive select — tolerates a missing table/column without throwing. */
async function safeSelect(
  client: SupabaseClient,
  table: string,
  build: (q: MiniQuery) => MiniQuery,
): Promise<Row[]> {
  try {
    const base = client.from(table) as unknown as MiniQuery;
    const { data, error } = await build(base);
    if (error) return [];
    return (data as Row[]) ?? [];
  } catch {
    return [];
  }
}

/** Returns null when the table does not exist; a number (incl. 0) otherwise. */
async function safeOrgCount(
  client: SupabaseClient,
  table: string,
  organizationId: string,
): Promise<number | null> {
  try {
    const base = client.from(table) as unknown as MiniCountQuery;
    const { count, error } = await base
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId);
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Add (or subtract) days to an ISO date/timestamp string → "YYYY-MM-DD" (null on parse fail). */
function shiftDate(iso: string | null, days: number): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

type RemovalRow = {
  id: string;
  order_id: string | null;
  sku: string | null;
  fnsku: string | null;
  disposition: string | null;
  requested_quantity: number | null;
  shipped_quantity: number | null;
  disposed_quantity: number | null;
  order_date: string | null;
};

type ShipmentRow = {
  id: string;
  order_id: string | null;
  tracking_number: string | null;
  carrier: string | null;
  shipment_date: string | null;
  sku: string | null;
  fnsku: string | null;
  shipped_quantity: number | null;
  requested_quantity: number | null;
};

type EpRow = {
  id: string;
  order_id: string | null;
  tracking_number: string | null;
  source_detail_row_id: string | null;
  source_shipment_row_id: string | null;
};

/**
 * Resolve external event references for a set of trace rows. One batched query per
 * source table covers all submissions.
 */
/** Source tables searched by the deep reference ledger, grouped by UI bucket. */
const CENSUS_TABLES: Array<{ table: string; group: string }> = [
  { table: "amazon_removals", group: "removal" },
  { table: "amazon_removal_shipments", group: "shipment_tracking" },
  { table: "amazon_inventory_ledger", group: "inventory_ledger" },
  { table: "amazon_transactions", group: "transaction_settlement" },
  { table: "amazon_settlements", group: "transaction_settlement" },
  { table: "amazon_reimbursements", group: "reimbursement" },
  { table: "amazon_customer_returns", group: "customer_return" },
  { table: "amazon_reports_repository", group: "report_metadata" },
  { table: "expected_packages", group: "removal" },
];

async function buildSourceCensus(
  client: SupabaseClient,
  organizationId: string,
): Promise<{ rows: DeepReferenceTableCensus[]; byTable: Map<string, DeepReferenceTableCensus> }> {
  const rows: DeepReferenceTableCensus[] = [];
  const byTable = new Map<string, DeepReferenceTableCensus>();
  for (const { table, group } of CENSUS_TABLES) {
    const count = await safeOrgCount(client, table, organizationId);
    const exists = count !== null;
    const status: DeepReferenceTableCensus["status"] = !exists
      ? "missing"
      : count === 0
        ? "empty"
        : "populated";
    const row: DeepReferenceTableCensus = { table, group, exists, org_row_count: count, status };
    rows.push(row);
    byTable.set(table, row);
  }
  return { rows, byTable };
}

export async function composeClaimEventReferenceLedgerForTrace(
  client: SupabaseClient,
  organizationId: string,
  traceRows: PerSubmissionReferenceTrace[],
): Promise<{ ledgers: Map<string, ClaimEventReferenceLedger>; census: DeepReferenceCensus }> {
  // ---- 0. Source census (which Amazon report tables exist + are populated) ----
  const census = await buildSourceCensus(client, organizationId);
  const tableStatus = (t: string): DeepReferenceTableCensus["status"] =>
    census.byTable.get(t)?.status ?? "missing";

  // ---- 1. Collect surrogate ids / candidate text refs across all submissions ----
  const epIds = new Set<string>();
  const removalSurrogates = new Set<string>();
  const shipmentSurrogates = new Set<string>();

  for (const t of traceRows) {
    if (isUuid(t.expected_package_id)) epIds.add(s(t.expected_package_id));
    for (const e of t.reference_edges) {
      const st = s(e.to_source_table || e.from_source_table).toLowerCase();
      const sid = s(e.to_source_row_id || e.from_source_row_id);
      const val = s(e.reference_value);
      if (st === "amazon_removals") {
        if (isUuid(sid)) removalSurrogates.add(sid);
        if (isUuid(val)) removalSurrogates.add(val);
      }
      if (st === "amazon_removal_shipments") {
        if (isUuid(sid)) shipmentSurrogates.add(sid);
        if (isUuid(val)) shipmentSurrogates.add(val);
      }
      if (st === "expected_packages") {
        if (isUuid(sid)) epIds.add(sid);
        if (isUuid(val)) epIds.add(val);
      }
    }
    for (const ro of t.removal_order_ids) if (isUuid(ro)) removalSurrogates.add(s(ro));
    for (const rs of t.removal_shipment_ids) if (isUuid(rs)) shipmentSurrogates.add(s(rs));
  }

  // ---- 2. Resolve expected_packages → order_id / tracking / detail+shipment surrogates ----
  const epMap = new Map<string, EpRow>();
  for (const part of chunk([...epIds], 100)) {
    const rows = await safeSelect(client, "expected_packages", (q) =>
      q
        .select("id, order_id, tracking_number, source_detail_row_id, source_shipment_row_id")
        .eq("organization_id", organizationId)
        .in("id", part),
    );
    for (const r of rows) {
      const ep: EpRow = {
        id: s(r.id),
        order_id: s(r.order_id) || null,
        tracking_number: s(r.tracking_number) || null,
        source_detail_row_id: s(r.source_detail_row_id) || null,
        source_shipment_row_id: s(r.source_shipment_row_id) || null,
      };
      epMap.set(ep.id, ep);
      if (isUuid(ep.source_detail_row_id)) removalSurrogates.add(s(ep.source_detail_row_id));
      if (isUuid(ep.source_shipment_row_id)) shipmentSurrogates.add(s(ep.source_shipment_row_id));
    }
  }

  // ---- 3. Resolve amazon_removals (authoritative external removal order id) ----
  const removalMap = new Map<string, RemovalRow>();
  for (const part of chunk([...removalSurrogates], 100)) {
    const rows = await safeSelect(client, "amazon_removals", (q) =>
      q
        .select(
          "id, order_id, sku, fnsku, disposition, requested_quantity, shipped_quantity, disposed_quantity, order_date",
        )
        .eq("organization_id", organizationId)
        .in("id", part),
    );
    for (const r of rows) {
      removalMap.set(s(r.id), {
        id: s(r.id),
        order_id: s(r.order_id) || null,
        sku: s(r.sku) || null,
        fnsku: s(r.fnsku) || null,
        disposition: s(r.disposition) || null,
        requested_quantity: num(r.requested_quantity),
        shipped_quantity: num(r.shipped_quantity),
        disposed_quantity: num(r.disposed_quantity),
        order_date: s(r.order_date) || null,
      });
    }
  }

  // ---- 4. Resolve amazon_removal_shipments (tracking + carrier + date) ----
  const shipmentMap = new Map<string, ShipmentRow>();
  for (const part of chunk([...shipmentSurrogates], 100)) {
    const rows = await safeSelect(client, "amazon_removal_shipments", (q) =>
      q
        .select(
          "id, order_id, tracking_number, carrier, shipment_date, sku, fnsku, shipped_quantity, requested_quantity",
        )
        .eq("organization_id", organizationId)
        .in("id", part),
    );
    for (const r of rows) {
      shipmentMap.set(s(r.id), {
        id: s(r.id),
        order_id: s(r.order_id) || null,
        tracking_number: s(r.tracking_number) || null,
        carrier: s(r.carrier) || null,
        shipment_date: s(r.shipment_date) || null,
        sku: s(r.sku) || null,
        fnsku: s(r.fnsku) || null,
        shipped_quantity: num(r.shipped_quantity),
        requested_quantity: num(r.requested_quantity),
      });
    }
  }

  // ---- 5. Collect resolved external order ids → financial / ledger joins ----
  const allOrderIds = new Set<string>();
  for (const t of traceRows) {
    if (isUuid(t.expected_package_id)) {
      const ep = epMap.get(s(t.expected_package_id));
      if (ep?.order_id && !isUuid(ep.order_id)) allOrderIds.add(ep.order_id);
    }
    for (const ro of t.removal_order_ids) if (!isUuid(ro) && s(ro)) allOrderIds.add(s(ro));
  }
  for (const r of removalMap.values()) if (r.order_id && !isUuid(r.order_id)) allOrderIds.add(r.order_id);
  for (const r of shipmentMap.values()) if (r.order_id && !isUuid(r.order_id)) allOrderIds.add(r.order_id);

  const reimByOrder = new Map<string, Row[]>();
  const txnByOrder = new Map<string, Row[]>();
  const ledgerByRef = new Map<string, Row[]>();
  const settlementByOrder = new Map<string, Row[]>();
  const reportByOrder = new Map<string, Row[]>();

  const orderIdList = [...allOrderIds];
  for (const part of chunk(orderIdList, 100)) {
    const reim = await safeSelect(client, "amazon_reimbursements", (q) =>
      q
        .select("id, order_id, reimbursement_id, case_id, sku, fnsku, asin, amount_total, currency_unit, approval_date, reason")
        .eq("organization_id", organizationId)
        .in("order_id", part),
    );
    for (const r of reim) {
      const k = s(r.order_id);
      reimByOrder.set(k, [...(reimByOrder.get(k) ?? []), r]);
    }

    const txn = await safeSelect(client, "amazon_transactions", (q) =>
      q
        .select("id, order_id, transaction_type, settlement_id, amount, posted_date, sku")
        .eq("organization_id", organizationId)
        .in("order_id", part),
    );
    for (const r of txn) {
      const k = s(r.order_id);
      txnByOrder.set(k, [...(txnByOrder.get(k) ?? []), r]);
    }

    const led = await safeSelect(client, "amazon_inventory_ledger", (q) =>
      q
        .select("id, reference_id, reason_code, reconciled_quantity, unreconciled_quantity, fnsku, sku, asin")
        .eq("organization_id", organizationId)
        .in("reference_id", part),
    );
    for (const r of led) {
      const k = s(r.reference_id);
      ledgerByRef.set(k, [...(ledgerByRef.get(k) ?? []), r]);
    }

    if (tableStatus("amazon_settlements") === "populated") {
      const set = await safeSelect(client, "amazon_settlements", (q) =>
        q
          .select("id, order_id, settlement_id, transaction_type, amount_total, posted_date, sku")
          .eq("organization_id", organizationId)
          .in("order_id", part)
          .limit(50),
      );
      for (const r of set) {
        const k = s(r.order_id);
        settlementByOrder.set(k, [...(settlementByOrder.get(k) ?? []), r]);
      }
    }

    if (tableStatus("amazon_reports_repository") === "populated") {
      const rep = await safeSelect(client, "amazon_reports_repository", (q) =>
        q
          .select("id, order_id, settlement_id, transaction_type, total_amount, date_time, sku, description")
          .eq("organization_id", organizationId)
          .in("order_id", part)
          .limit(50),
      );
      for (const r of rep) {
        const k = s(r.order_id);
        reportByOrder.set(k, [...(reportByOrder.get(k) ?? []), r]);
      }
    }
  }

  // ---- 5b. Bounded event-date WINDOW candidate pass (advisory, per identity) ----
  const LIMIT = 20;
  /** ledger candidates by fnsku within a date window. */
  async function ledgerWindow(fnsku: string, start: string, end: string): Promise<Row[]> {
    if (tableStatus("amazon_inventory_ledger") !== "populated") return [];
    return safeSelect(client, "amazon_inventory_ledger", (q) =>
      q
        .select("id, reference_id, reason_code, event_type, event_date, quantity, fnsku, sku, asin")
        .eq("organization_id", organizationId)
        .eq("fnsku", fnsku)
        .gte("event_date", start)
        .lte("event_date", end)
        .limit(LIMIT),
    );
  }
  async function reimbursementWindow(fnsku: string, start: string, end: string): Promise<Row[]> {
    if (tableStatus("amazon_reimbursements") !== "populated") return [];
    return safeSelect(client, "amazon_reimbursements", (q) =>
      q
        .select("id, order_id, reimbursement_id, case_id, amount_total, approval_date, reason, fnsku, sku")
        .eq("organization_id", organizationId)
        .eq("fnsku", fnsku)
        .gte("approval_date", start)
        .lte("approval_date", end)
        .limit(LIMIT),
    );
  }
  async function transactionWindow(sku: string, start: string, end: string): Promise<Row[]> {
    if (tableStatus("amazon_transactions") !== "populated") return [];
    return safeSelect(client, "amazon_transactions", (q) =>
      q
        .select("id, order_id, settlement_id, transaction_type, amount, posted_date, sku")
        .eq("organization_id", organizationId)
        .eq("sku", sku)
        .gte("posted_date", start)
        .lte("posted_date", end)
        .limit(LIMIT),
    );
  }

  // ---- 6. Assemble per-submission ledger ----
  const out = new Map<string, ClaimEventReferenceLedger>();

  for (const t of traceRows) {
    const fnsku = s(t.fnsku) || null;
    const sku = s(t.sku) || null;
    const asin = s(t.asin) || null;

    const external: EventReferenceRow[] = [];
    const internal: InternalAnchorRow[] = [];
    const matchReasons = new Set<string>();

    // Surrogates relevant to THIS submission
    const subRemovalSurrogates = new Set<string>();
    const subShipmentSurrogates = new Set<string>();
    for (const e of t.reference_edges) {
      const st = s(e.to_source_table || e.from_source_table).toLowerCase();
      const sid = s(e.to_source_row_id || e.from_source_row_id);
      const val = s(e.reference_value);
      if (st === "amazon_removals") {
        if (isUuid(sid)) subRemovalSurrogates.add(sid);
        if (isUuid(val)) subRemovalSurrogates.add(val);
      }
      if (st === "amazon_removal_shipments") {
        if (isUuid(sid)) subShipmentSurrogates.add(sid);
        if (isUuid(val)) subShipmentSurrogates.add(val);
      }
    }
    for (const rs of t.removal_shipment_ids) if (isUuid(rs)) subShipmentSurrogates.add(s(rs));
    const ep = isUuid(t.expected_package_id) ? epMap.get(s(t.expected_package_id)) ?? null : null;
    if (ep?.source_detail_row_id && isUuid(ep.source_detail_row_id)) subRemovalSurrogates.add(ep.source_detail_row_id);
    if (ep?.source_shipment_row_id && isUuid(ep.source_shipment_row_id)) subShipmentSurrogates.add(ep.source_shipment_row_id);

    // ---- Removal order references (external) ----
    const removalOrderRefs = new Set<string>();
    const trackingRefs = new Set<string>();
    const removalShipmentRefs = new Set<string>();

    for (const sid of subRemovalSurrogates) {
      const r = removalMap.get(sid);
      if (!r) continue;
      const orderId = r.order_id && !isUuid(r.order_id) ? r.order_id : null;
      if (!orderId) continue;
      removalOrderRefs.add(orderId);
      const identityMatch = !!(fnsku && r.fnsku && s(r.fnsku) === fnsku);
      const reasons = ["removal_order_match"];
      if (identityMatch) reasons.push("product_identity_match");
      reasons.forEach((x) => matchReasons.add(x));
      external.push({
        source: "amazon_removals",
        source_label: "Removal Order Detail",
        reference_kind: "removal_order_id",
        reference_id: orderId,
        event_type: "removal_order",
        event_date: r.order_date,
        quantity: r.requested_quantity,
        amount: null,
        source_row_id: r.id,
        match_reason: reasons,
        confidence: identityMatch ? "high" : "medium",
        is_external_amazon_reference: true,
      });
    }
    // Candidate / EP text removal order ids not covered by a removal row
    for (const ro of t.removal_order_ids) {
      const v = s(ro);
      if (!v || isUuid(v) || removalOrderRefs.has(v)) continue;
      removalOrderRefs.add(v);
      matchReasons.add("removal_order_match");
      external.push({
        source: "amazon_removals",
        source_label: "Removal Order Detail",
        reference_kind: "removal_order_id",
        reference_id: v,
        event_type: "removal_order",
        event_date: null,
        quantity: null,
        amount: null,
        source_row_id: null,
        match_reason: ["removal_order_match"],
        confidence: "medium",
        is_external_amazon_reference: true,
      });
    }
    if (ep?.order_id && !isUuid(ep.order_id) && !removalOrderRefs.has(ep.order_id)) {
      removalOrderRefs.add(ep.order_id);
      matchReasons.add("removal_order_match");
      external.push({
        source: "expected_packages",
        source_label: "Expected Package (removal reconciliation)",
        reference_kind: "removal_order_id",
        reference_id: ep.order_id,
        event_type: "removal_order",
        event_date: null,
        quantity: null,
        amount: null,
        source_row_id: ep.id,
        match_reason: ["removal_order_match"],
        confidence: "medium",
        is_external_amazon_reference: true,
      });
    }

    // ---- Removal shipment references (external) ----
    for (const sid of subShipmentSurrogates) {
      const r = shipmentMap.get(sid);
      if (!r) continue;
      const tracking = r.tracking_number && !isUuid(r.tracking_number) ? r.tracking_number : null;
      const refId = tracking ?? (r.order_id && !isUuid(r.order_id) ? r.order_id : null);
      if (!refId) continue;
      removalShipmentRefs.add(refId);
      if (tracking) trackingRefs.add(tracking);
      const identityMatch = !!(fnsku && r.fnsku && s(r.fnsku) === fnsku);
      const reasons = ["removal_shipment_match"];
      if (identityMatch) reasons.push("product_identity_match");
      if (tracking) reasons.push("tracking_match");
      reasons.forEach((x) => matchReasons.add(x));
      external.push({
        source: "amazon_removal_shipments",
        source_label: "Removal Shipment Detail",
        reference_kind: "removal_shipment_reference",
        reference_id: refId,
        event_type: r.carrier ? `removal_shipment · ${r.carrier}` : "removal_shipment",
        event_date: r.shipment_date,
        quantity: r.shipped_quantity ?? r.requested_quantity,
        amount: null,
        source_row_id: r.id,
        match_reason: reasons,
        confidence: identityMatch ? "high" : "medium",
        is_external_amazon_reference: true,
      });
    }

    // ---- Tracking references (external) ----
    for (const tk of t.tracking_numbers) {
      const v = s(tk);
      if (!v || isUuid(v) || trackingRefs.has(v)) continue;
      trackingRefs.add(v);
      matchReasons.add("tracking_match");
      external.push({
        source: "tracking",
        source_label: "Carrier tracking / shipment reference",
        reference_kind: "tracking_number",
        reference_id: v,
        event_type: "shipment_tracking",
        event_date: null,
        quantity: null,
        amount: null,
        source_row_id: null,
        match_reason: ["tracking_match"],
        confidence: "medium",
        is_external_amazon_reference: true,
      });
    }
    if (ep?.tracking_number && !isUuid(ep.tracking_number) && !trackingRefs.has(ep.tracking_number)) {
      trackingRefs.add(ep.tracking_number);
      matchReasons.add("tracking_match");
      external.push({
        source: "tracking",
        source_label: "Carrier tracking / shipment reference",
        reference_kind: "tracking_number",
        reference_id: ep.tracking_number,
        event_type: "shipment_tracking",
        event_date: null,
        quantity: null,
        amount: null,
        source_row_id: ep.id,
        match_reason: ["tracking_match"],
        confidence: "medium",
        is_external_amazon_reference: true,
      });
    }

    // ---- Reimbursement references (external) ----
    const reimbursementRefs = new Set<string>();
    for (const orderId of removalOrderRefs) {
      for (const r of reimByOrder.get(orderId) ?? []) {
        const reimId = s(r.reimbursement_id) || s(r.case_id) || s(r.id);
        if (!reimId || reimbursementRefs.has(reimId)) continue;
        reimbursementRefs.add(reimId);
        matchReasons.add("reimbursement_order_match");
        external.push({
          source: "amazon_reimbursements",
          source_label: "Reimbursements report",
          reference_kind: "reimbursement_id",
          reference_id: reimId,
          event_type: s(r.reason) || "reimbursement",
          event_date: s(r.approval_date) || null,
          quantity: null,
          amount: num(r.amount_total),
          source_row_id: s(r.id) || null,
          match_reason: ["reimbursement_order_match"],
          confidence: "high",
          is_external_amazon_reference: true,
        });
      }
    }

    // SKU-relevance guard: keep order-level lines (no sku) + lines matching the claim sku.
    const skuOk = (rowSku: unknown): boolean => {
      const rs = s(rowSku);
      return !sku || !rs || rs === sku;
    };

    // ---- Transaction / settlement references (external) ----
    const transactionRefs = new Set<string>();
    for (const orderId of removalOrderRefs) {
      for (const r of txnByOrder.get(orderId) ?? []) {
        if (!skuOk(r.sku)) continue;
        const txnId = s(r.settlement_id) || s(r.id);
        if (!txnId || transactionRefs.has(txnId)) continue;
        transactionRefs.add(txnId);
        matchReasons.add("transaction_order_match");
        external.push({
          source: "amazon_transactions",
          source_label: "Transactions / settlement report",
          reference_kind: s(r.settlement_id) ? "settlement_id" : "transaction_id",
          reference_id: txnId,
          event_type: s(r.transaction_type) || "transaction",
          event_date: s(r.posted_date) || null,
          quantity: null,
          amount: num(r.amount),
          source_row_id: s(r.id) || null,
          match_reason: ["transaction_order_match"],
          confidence: "high",
          is_external_amazon_reference: true,
        });
      }
    }

    // ---- Inventory ledger references (external) ----
    const inventoryLedgerRefs = new Set<string>();
    for (const orderId of removalOrderRefs) {
      for (const r of ledgerByRef.get(orderId) ?? []) {
        const refId = s(r.reference_id);
        if (!refId || inventoryLedgerRefs.has(refId)) continue;
        inventoryLedgerRefs.add(refId);
        matchReasons.add("inventory_ledger_reference_match");
        external.push({
          source: "amazon_inventory_ledger",
          source_label: "Inventory Ledger",
          reference_kind: "ledger_reference_id",
          reference_id: refId,
          event_type: s(r.reason_code) || "inventory_ledger_event",
          event_date: null,
          quantity: num(r.unreconciled_quantity) ?? num(r.reconciled_quantity),
          amount: null,
          source_row_id: s(r.id) || null,
          match_reason: ["inventory_ledger_reference_match"],
          confidence: "high",
          is_external_amazon_reference: true,
        });
      }
    }

    // ---- Settlement references (external, exact order match) ----
    const settlementRefs = new Set<string>();
    for (const orderId of removalOrderRefs) {
      for (const r of settlementByOrder.get(orderId) ?? []) {
        if (!skuOk(r.sku)) continue;
        const sid = s(r.settlement_id) || s(r.id);
        if (!sid || settlementRefs.has(sid)) continue;
        settlementRefs.add(sid);
        transactionRefs.add(sid);
        matchReasons.add("settlement_order_match");
        external.push({
          source: "amazon_settlements",
          source_label: "Settlement report",
          reference_kind: "settlement_id",
          reference_id: sid,
          event_type: s(r.transaction_type) || "settlement",
          event_date: s(r.posted_date) || null,
          quantity: null,
          amount: num(r.amount_total),
          source_row_id: s(r.id) || null,
          match_reason: ["settlement_order_match"],
          confidence: "high",
          is_external_amazon_reference: true,
        });
      }
    }

    // ---- Report-repository references (external, exact order match) ----
    const reportMetadataRefs = new Set<string>();
    for (const orderId of removalOrderRefs) {
      for (const r of reportByOrder.get(orderId) ?? []) {
        if (!skuOk(r.sku)) continue;
        const rid = s(r.settlement_id) || s(r.order_id) || s(r.id);
        if (!rid || reportMetadataRefs.has(rid)) continue;
        reportMetadataRefs.add(rid);
        matchReasons.add("report_repository_order_match");
        external.push({
          source: "amazon_reports_repository",
          source_label: "Reports repository (flat-file)",
          reference_kind: "report_row_reference",
          reference_id: rid,
          event_type: s(r.transaction_type) || "report_row",
          event_date: s(r.date_time) || null,
          quantity: null,
          amount: num(r.total_amount),
          source_row_id: s(r.id) || null,
          match_reason: ["report_repository_order_match"],
          confidence: "medium",
          is_external_amazon_reference: true,
        });
      }
    }

    // ---- Bounded event-date WINDOW candidate pass (advisory, not materialized) ----
    const anchorDates: string[] = [];
    for (const sid of subRemovalSurrogates) {
      const r = removalMap.get(sid);
      if (r?.order_date) anchorDates.push(r.order_date);
    }
    for (const sid of subShipmentSurrogates) {
      const r = shipmentMap.get(sid);
      if (r?.shipment_date) anchorDates.push(r.shipment_date);
    }
    const sortedAnchors = anchorDates.filter(Boolean).sort();
    const winStart = shiftDate(sortedAnchors[0] ?? null, -EVENT_DATETIME_WINDOW_DAYS);
    const winEnd = shiftDate(sortedAnchors[sortedAnchors.length - 1] ?? null, EVENT_DATETIME_WINDOW_DAYS);
    const dateWindowAvailable = !!(winStart && winEnd && fnsku);

    let ledgerCandidates: EventReferenceRow[] = [];
    let reimburseCandidates: EventReferenceRow[] = [];
    let txnCandidates: EventReferenceRow[] = [];
    if (dateWindowAvailable) {
      const [lc, rc] = await Promise.all([
        ledgerWindow(fnsku as string, winStart as string, winEnd as string),
        reimbursementWindow(fnsku as string, winStart as string, winEnd as string),
      ]);
      const tc = sku ? await transactionWindow(sku, winStart as string, winEnd as string) : [];
      ledgerCandidates = lc.map((r) => ({
        source: "amazon_inventory_ledger",
        source_label: "Inventory Ledger (FNSKU + date window)",
        reference_kind: "ledger_reference_id",
        reference_id: s(r.reference_id) || s(r.id),
        event_type: s(r.event_type) || s(r.reason_code) || "inventory_ledger_event",
        event_date: s(r.event_date) || null,
        quantity: num(r.quantity),
        amount: null,
        source_row_id: s(r.id) || null,
        match_reason: ["fnsku_match", "event_date_window_match"],
        confidence: "low" as const,
        is_external_amazon_reference: true as const,
      }));
      reimburseCandidates = rc
        .filter((r) => !removalOrderRefs.has(s(r.order_id))) // exclude exact-order ones already materialized
        .map((r) => ({
          source: "amazon_reimbursements",
          source_label: "Reimbursements (FNSKU + date window)",
          reference_kind: "reimbursement_id",
          reference_id: s(r.reimbursement_id) || s(r.case_id) || s(r.id),
          event_type: s(r.reason) || "reimbursement",
          event_date: s(r.approval_date) || null,
          quantity: null,
          amount: num(r.amount_total),
          source_row_id: s(r.id) || null,
          match_reason: ["fnsku_match", "event_date_window_match"],
          confidence: "low" as const,
          is_external_amazon_reference: true as const,
        }));
      txnCandidates = tc
        .filter((r) => !removalOrderRefs.has(s(r.order_id)))
        .map((r) => ({
          source: "amazon_transactions",
          source_label: "Transactions (SKU + date window)",
          reference_kind: s(r.settlement_id) ? "settlement_id" : "transaction_id",
          reference_id: s(r.settlement_id) || s(r.id),
          event_type: s(r.transaction_type) || "transaction",
          event_date: s(r.posted_date) || null,
          quantity: null,
          amount: num(r.amount),
          source_row_id: s(r.id) || null,
          match_reason: ["sku_match", "event_date_window_match"],
          confidence: "low" as const,
          is_external_amazon_reference: true as const,
        }));
    }
    const dateWindowCandidateCount =
      ledgerCandidates.length + reimburseCandidates.length + txnCandidates.length;

    // ---- Build per-source groups + statuses ----
    const bySource = (sources: string[]): EventReferenceRow[] =>
      external.filter((e) => sources.includes(e.source));
    const groupStatus = (
      materialized: EventReferenceRow[],
      candidates: EventReferenceRow[],
      tables: string[],
    ): DeepReferenceSourceStatus => {
      if (materialized.length > 0) return "found";
      if (candidates.length > 0) return "found_weak_ambiguous";
      const statuses = tables.map((tb) => tableStatus(tb));
      if (statuses.length > 0 && statuses.every((x) => x === "missing")) return "source_table_missing";
      if (statuses.length > 0 && statuses.every((x) => x === "missing" || x === "empty"))
        return "source_table_empty";
      return "not_found_in_loaded_reports";
    };

    const removalGroupRefs = bySource(["amazon_removals", "expected_packages"]);
    const shipmentGroupRefs = bySource(["amazon_removal_shipments", "tracking"]);
    const ledgerGroupRefs = bySource(["amazon_inventory_ledger"]);
    const txnGroupRefs = bySource(["amazon_transactions", "amazon_settlements"]);
    const reimGroupRefs = bySource(["amazon_reimbursements"]);
    const reportGroupRefs = bySource(["amazon_reports_repository"]);

    const source_groups: DeepReferenceSourceGroup[] = [
      {
        group: "removal",
        source_label: "Removal references (Removal Order Detail)",
        status: groupStatus(removalGroupRefs, [], ["amazon_removals"]),
        references: removalGroupRefs,
        candidate_count: 0,
        candidate_samples: [],
        note:
          removalGroupRefs.length > 0
            ? "Resolved real removal order id(s) from the Removal Order Detail report."
            : "No removal order reference resolved.",
      },
      {
        group: "shipment_tracking",
        source_label: "Shipment / tracking references (Removal Shipment Detail)",
        status: groupStatus(shipmentGroupRefs, [], ["amazon_removal_shipments"]),
        references: shipmentGroupRefs,
        candidate_count: 0,
        candidate_samples: [],
        note:
          shipmentGroupRefs.length > 0
            ? "Resolved tracking / shipment reference(s) from the Removal Shipment Detail report."
            : "No shipment/tracking reference resolved.",
      },
      {
        group: "inventory_ledger",
        source_label: "Inventory ledger references",
        status: groupStatus(ledgerGroupRefs, ledgerCandidates, ["amazon_inventory_ledger"]),
        references: ledgerGroupRefs,
        candidate_count: ledgerCandidates.length,
        candidate_samples: ledgerCandidates.slice(0, 5),
        note:
          ledgerGroupRefs.length > 0
            ? "Order-linked inventory ledger reference found."
            : ledgerCandidates.length > 0
              ? `${ledgerCandidates.length}${ledgerCandidates.length >= 20 ? "+" : ""} ledger row(s) match FNSKU within ±${EVENT_DATETIME_WINDOW_DAYS}d of the removal event but are NOT order-linked (advisory, not for filing).`
              : "No inventory ledger reference order-linked or in the date window.",
      },
      {
        group: "transaction_settlement",
        source_label: "Transaction / settlement references",
        status: groupStatus(txnGroupRefs, txnCandidates, ["amazon_transactions", "amazon_settlements"]),
        references: txnGroupRefs,
        candidate_count: txnCandidates.length,
        candidate_samples: txnCandidates.slice(0, 5),
        note:
          txnGroupRefs.length > 0
            ? "Order-linked transaction/settlement reference found."
            : "Not found in loaded reports — removal orders are not settlement order ids; a settlement appears only after Amazon reimburses (post-filing).",
      },
      {
        group: "reimbursement",
        source_label: "Reimbursement references",
        status: groupStatus(reimGroupRefs, reimburseCandidates, ["amazon_reimbursements"]),
        references: reimGroupRefs,
        candidate_count: reimburseCandidates.length,
        candidate_samples: reimburseCandidates.slice(0, 5),
        note:
          reimGroupRefs.length > 0
            ? "Order-linked reimbursement found."
            : reimburseCandidates.length > 0
              ? `${reimburseCandidates.length} reimbursement(s) match FNSKU within the date window but are NOT linked to this removal order (advisory).`
              : "Not found in loaded reports — this removal has not been reimbursed yet (pre-filing).",
      },
      {
        group: "customer_return",
        source_label: "FBA customer return references",
        status: groupStatus([], [], ["amazon_customer_returns"]),
        references: [],
        candidate_count: 0,
        candidate_samples: [],
        note: "amazon_customer_returns is not loaded for this org (not applicable to removal families).",
      },
      {
        group: "report_metadata",
        source_label: "Report metadata (reports repository)",
        status: groupStatus(reportGroupRefs, [], ["amazon_reports_repository"]),
        references: reportGroupRefs,
        candidate_count: 0,
        candidate_samples: [],
        note:
          reportGroupRefs.length > 0
            ? "Found a flat-file report row referencing this order."
            : "No report-repository row references this removal order.",
      },
    ];

    // ---- Internal anchors (debug / provenance only) ----
    const pushInternal = (label: string, value: string | null | undefined, kind: string, note: string) => {
      const v = s(value);
      if (v) internal.push({ label, value: v, kind, note });
    };
    pushInternal(
      "Expected Package ID",
      t.expected_package_id,
      "expected_package_id",
      "Internal expected_packages.id — reconciliation row, not an Amazon reference.",
    );
    pushInternal(
      "Product link (resolved_product_id)",
      t.resolved_product_id,
      "resolved_product_id",
      "Internal catalog product link — NOT a TRID / Amazon reference.",
    );
    pushInternal("Claim case ID", t.claim_case_id, "claim_case_id", "Internal claim_cases.id.");
    pushInternal("Source candidate ID", t.source_candidate_id, "claim_candidate_id", "Internal claim_candidates.id.");
    for (const sid of subRemovalSurrogates) {
      pushInternal("Removal row pointer", sid, "amazon_removals.id", "Internal amazon_removals.id surrogate (use the Removal Order ID instead).");
    }
    for (const sid of subShipmentSurrogates) {
      pushInternal("Removal shipment row pointer", sid, "amazon_removal_shipments.id", "Internal amazon_removal_shipments.id surrogate (use tracking / order id instead).");
    }
    for (const e of t.reference_edges) {
      const k = s(e.reference_kind).toLowerCase();
      if (k === "claim_line_id" && isUuid(e.reference_value)) {
        pushInternal("Claim line ID", e.reference_value, "claim_line_id", "Internal claim_lines.id.");
      }
    }

    // ---- Primary reference anchor (external preferred) ----
    const firstRemovalOrder = [...removalOrderRefs][0] ?? null;
    const firstTracking = [...trackingRefs][0] ?? null;
    const firstShipment = [...removalShipmentRefs][0] ?? null;
    let primary: PrimaryReferenceAnchor;
    if (firstRemovalOrder) {
      primary = { label: "Removal Order ID", value: firstRemovalOrder, kind: "removal_order_id", is_external_amazon_reference: true };
    } else if (firstShipment) {
      primary = { label: "Removal Shipment reference", value: firstShipment, kind: "removal_shipment_reference", is_external_amazon_reference: true };
    } else if (firstTracking) {
      primary = { label: "Tracking / shipment reference", value: firstTracking, kind: "tracking_number", is_external_amazon_reference: true };
    } else {
      primary = {
        label: "Internal anchor (Expected Package ID)",
        value: s(t.expected_package_id) || null,
        kind: "expected_package_id",
        is_external_amazon_reference: false,
      };
    }

    const externalCount = external.length;
    const hasRemovalExternal =
      removalOrderRefs.size > 0 || removalShipmentRefs.size > 0 || trackingRefs.size > 0;
    const hasFinancialExternal = reimbursementRefs.size > 0 || transactionRefs.size > 0;
    const needsReview = !hasRemovalExternal;
    const ambiguity = (t.ambiguous_matches?.length ?? 0) > 0 || removalOrderRefs.size > 1;

    let filingSufficiency: DeepReferenceFilingSufficiency;
    if (!hasRemovalExternal) {
      filingSufficiency = "needs_reference_review";
    } else if (
      removalOrderRefs.size > 0 &&
      (trackingRefs.size > 0 || removalShipmentRefs.size > 0) &&
      hasFinancialExternal
    ) {
      filingSufficiency = "complete";
    } else {
      filingSufficiency = "sufficient_for_manual_filing";
    }

    const matchedBy: string[] = [];
    if (s(t.resolved_product_id)) matchedBy.push("resolved_product_id");
    if (fnsku) matchedBy.push("fnsku");
    if (sku) matchedBy.push("sku");
    if (asin) matchedBy.push("asin");
    if (removalOrderRefs.size > 0) matchedBy.push("removal_order_id");
    if (removalShipmentRefs.size > 0) matchedBy.push("removal_shipment_id");
    if (trackingRefs.size > 0) matchedBy.push("tracking_number");
    if (dateWindowCandidateCount > 0) matchedBy.push("event_date_window");

    const notFoundSources: string[] = [];
    const ambiguousSources: string[] = [];
    for (const g of source_groups) {
      if (
        g.status === "not_found_in_loaded_reports" ||
        g.status === "source_table_empty" ||
        g.status === "source_table_missing"
      ) {
        notFoundSources.push(`${g.source_label} (${g.status})`);
      }
      if (g.status === "found_weak_ambiguous") {
        ambiguousSources.push(`${g.source_label} (${g.candidate_count} window candidate(s))`);
      }
    }

    let confidence: EventReferenceConfidence = "low";
    if (matchReasons.has("product_identity_match") && (removalOrderRefs.size > 0 || removalShipmentRefs.size > 0)) {
      confidence = "high";
    } else if (externalCount > 0) {
      confidence = "medium";
    }

    // ---- Seller Central reference block (external only, no UUIDs, no "TRID") ----
    const blockLines: string[] = [];
    if (asin) blockLines.push(`ASIN: ${asin}`);
    if (fnsku) blockLines.push(`FNSKU: ${fnsku}`);
    if (sku) blockLines.push(`SKU: ${sku}`);
    if (removalOrderRefs.size > 0) blockLines.push(`Removal Order ID: ${[...removalOrderRefs].join(", ")}`);
    // Removal shipment reference is the tracking number — only list separately when it
    // is NOT already covered by a tracking reference (avoid duplicate lines).
    const shipmentOnly = [...removalShipmentRefs].filter((v) => !trackingRefs.has(v));
    if (shipmentOnly.length > 0) blockLines.push(`Removal Shipment reference: ${shipmentOnly.join(", ")}`);
    if (trackingRefs.size > 0) blockLines.push(`Tracking / shipment reference: ${[...trackingRefs].join(", ")}`);
    if (reimbursementRefs.size > 0) blockLines.push(`Reimbursement ID: ${[...reimbursementRefs].join(", ")}`);
    if (transactionRefs.size > 0) blockLines.push(`Transaction / settlement: ${[...transactionRefs].join(", ")}`);
    if (inventoryLedgerRefs.size > 0) blockLines.push(`Inventory Ledger reference: ${[...inventoryLedgerRefs].join(", ")}`);
    blockLines.push(`Quantity affected: ${t.quantity ?? "—"}`);
    if (needsReview) {
      blockLines.push("");
      blockLines.push("NEEDS REFERENCE REVIEW — no external Amazon report reference resolved; do not file with internal IDs only.");
    }

    out.set(t.claim_submission_id, {
      claim_submission_id: t.claim_submission_id,
      claim_case_id: t.claim_case_id,
      claim_family: t.claim_family,
      product_identity: { resolved_product_id: t.resolved_product_id, fnsku, sku, asin },
      quantity: t.quantity,
      event_datetime: t.event_datetime,
      event_time_window_used: EVENT_DATETIME_FILTER_USED,
      event_datetime_note: EVENT_DATETIME_NOTE,
      primary_reference_anchor: primary,
      external_references: external,
      internal_anchors: internal,
      removal_order_refs: [...removalOrderRefs],
      removal_shipment_refs: [...removalShipmentRefs],
      tracking_refs: [...trackingRefs],
      inventory_ledger_refs: [...inventoryLedgerRefs],
      transaction_refs: [...transactionRefs],
      reimbursement_refs: [...reimbursementRefs],
      external_reference_count: externalCount,
      internal_anchor_count: internal.length,
      match_reasons: [...matchReasons],
      confidence,
      ambiguity_flag: ambiguity,
      missing_reference: needsReview,
      needs_reference_review: needsReview,
      seller_central_reference_block: blockLines.join("\n"),
      source_groups,
      customer_return_refs: [],
      report_metadata_refs: [...reportMetadataRefs],
      matched_by: matchedBy,
      date_window_used: EVENT_DATETIME_FILTER_USED,
      date_window_days: EVENT_DATETIME_WINDOW_DAYS,
      date_window_candidate_count: dateWindowCandidateCount,
      not_found_sources: notFoundSources,
      ambiguous_sources: ambiguousSources,
      filing_sufficiency: filingSufficiency,
    });
  }

  // ---- 7. Aggregate census totals ----
  const ledgers = out;
  let claimsComplete = 0;
  let claimsSufficient = 0;
  let claimsNeedsReview = 0;
  const totals = {
    external_references: 0,
    removal_order_refs: 0,
    removal_shipment_refs: 0,
    tracking_refs: 0,
    inventory_ledger_refs: 0,
    transaction_refs: 0,
    reimbursement_refs: 0,
    customer_return_refs: 0,
    report_metadata_refs: 0,
  };
  for (const l of ledgers.values()) {
    totals.external_references += l.external_reference_count;
    totals.removal_order_refs += l.removal_order_refs.length;
    totals.removal_shipment_refs += l.removal_shipment_refs.length;
    totals.tracking_refs += l.tracking_refs.length;
    totals.inventory_ledger_refs += l.inventory_ledger_refs.length;
    totals.transaction_refs += l.transaction_refs.length;
    totals.reimbursement_refs += l.reimbursement_refs.length;
    totals.customer_return_refs += l.customer_return_refs.length;
    totals.report_metadata_refs += l.report_metadata_refs.length;
    if (l.filing_sufficiency === "complete") claimsComplete += 1;
    else if (l.filing_sufficiency === "sufficient_for_manual_filing") claimsSufficient += 1;
    else claimsNeedsReview += 1;
  }

  const censusPayload: DeepReferenceCensus = {
    source_tables_checked: census.rows,
    source_tables_empty_or_missing: census.rows
      .filter((r) => r.status !== "populated")
      .map((r) => `${r.table} (${r.status})`),
    date_window_days: EVENT_DATETIME_WINDOW_DAYS,
    event_date_time_filter_used: EVENT_DATETIME_FILTER_USED,
    totals,
    claims_total: ledgers.size,
    claims_complete: claimsComplete,
    claims_filing_sufficient: claimsSufficient,
    claims_needs_reference_review: claimsNeedsReview,
  };

  return { ledgers, census: censusPayload };
}
