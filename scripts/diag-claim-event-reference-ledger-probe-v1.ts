/**
 * PHASE-CLAIM-EVENT-REFERENCE-LEDGER-AND-TRID-CORRECTION-V1 — read-only probe.
 *
 * For the 10 pilot ready-to-file claims, resolves the internal anchor surrogates
 * (expected_packages.source_detail_row_id → amazon_removals.id, etc.) to REAL
 * Amazon event/report references (removal order_id, reimbursement_id, transaction
 * refs, inventory ledger reference_id) so we can classify external vs internal
 * references before building the Event Reference Ledger composer. No DB writes.
 *
 *   npx tsx scripts/diag-claim-event-reference-ledger-probe-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function s(v: unknown): string {
  return String(v ?? "").trim();
}

async function safeSelect(
  client: SupabaseClient,
  table: string,
  build: (q: ReturnType<SupabaseClient["from"]>) => unknown,
): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
  try {
    const q = build(client.from(table)) as Promise<{ data: unknown; error: { message: string } | null }>;
    const { data, error } = await q;
    if (error) return { rows: [], error: error.message };
    return { rows: (data as Record<string, unknown>[]) ?? [], error: null };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.ORIGINAL_SUPABASE_URL!;
  const key = process.env.ORIGINAL_SERVICE_ROLE_KEY!;
  const client = createClient(url, key, { auth: { persistSession: false } });

  console.log("=== Event Reference Ledger probe (read-only, original/live) ===");
  const payload = await composeClaimReadyToFileQueueV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });
  console.log(`rows: ready=${payload.ready_rows.length} blocked=${payload.blocked_rows.length}`);

  const allRows = [...payload.ready_rows, ...payload.blocked_rows];

  for (const row of allRows) {
    console.log(`\n──────── ${row.claim_submission_id} · ${row.claim_family} ────────`);
    console.log(
      `  identity: fnsku=${row.fnsku} sku=${row.sku} asin=${row.asin} qty=${row.clean_quantity}`,
    );
    console.log(
      `  current UI anchor (trid_or_expected_package) = ${row.trid_or_expected_package} (isUUID=${UUID_RE.test(s(row.trid_or_expected_package))})`,
    );
    console.log(
      `  packet removal_order_id=${row.removal_order_id} (isUUID=${UUID_RE.test(s(row.removal_order_id))}) removal_shipment_id=${row.removal_shipment_id} (isUUID=${UUID_RE.test(s(row.removal_shipment_id))})`,
    );

    const edges = row.reference_health.edges;
    console.log(`  edges (${edges.length}):`);
    for (const e of edges) {
      console.log(
        `    - kind=${e.reference_kind} value=${e.reference_value} (isUUID=${UUID_RE.test(s(e.reference_value))}) → ${e.source_table ?? "—"}#${e.source_row_id ?? "—"}`,
      );
    }

    // Collect removal surrogate UUIDs from edges pointing at amazon_removals / removal_order_id
    const removalSurrogates = new Set<string>();
    const shipmentSurrogates = new Set<string>();
    const epIds = new Set<string>();
    for (const e of edges) {
      const k = s(e.reference_kind).toLowerCase();
      const v = s(e.reference_value);
      const st = s(e.source_table).toLowerCase();
      const sid = s(e.source_row_id);
      if (st === "amazon_removals" && UUID_RE.test(sid)) removalSurrogates.add(sid);
      if (st === "amazon_removals" && UUID_RE.test(v)) removalSurrogates.add(v);
      if (st === "amazon_removal_shipments" && UUID_RE.test(sid)) shipmentSurrogates.add(sid);
      if (st === "amazon_removal_shipments" && UUID_RE.test(v)) shipmentSurrogates.add(v);
      if ((k === "expected_package_id" || st === "expected_packages") && UUID_RE.test(v)) epIds.add(v);
      if ((k === "expected_package_id" || st === "expected_packages") && UUID_RE.test(sid)) epIds.add(sid);
    }
    if (UUID_RE.test(s(row.removal_order_id))) removalSurrogates.add(s(row.removal_order_id));
    if (UUID_RE.test(s(row.trid_or_expected_package))) epIds.add(s(row.trid_or_expected_package));

    // Resolve expected_packages → source_detail_row_id / tracking / order_id
    const orderIds = new Set<string>();
    if (epIds.size > 0) {
      const ep = await safeSelect(client, "expected_packages", (q) =>
        (q as any)
          .select("id, order_id, tracking_number, source_detail_row_id, source_shipment_row_id, sku, fnsku")
          .eq("organization_id", ORG)
          .in("id", [...epIds]),
      );
      if (ep.error) console.log(`  expected_packages ERROR: ${ep.error}`);
      for (const r of ep.rows) {
        console.log(
          `  EP ${s(r.id)}: order_id=${s(r.order_id)} tracking=${s(r.tracking_number)} detail_row=${s(r.source_detail_row_id)} shipment_row=${s(r.source_shipment_row_id)}`,
        );
        if (UUID_RE.test(s(r.source_detail_row_id))) removalSurrogates.add(s(r.source_detail_row_id));
        if (UUID_RE.test(s(r.source_shipment_row_id))) shipmentSurrogates.add(s(r.source_shipment_row_id));
        if (s(r.order_id)) orderIds.add(s(r.order_id));
      }
    }

    // Resolve amazon_removals by surrogate id → REAL order_id
    if (removalSurrogates.size > 0) {
      const rem = await safeSelect(client, "amazon_removals", (q) =>
        (q as any)
          .select("id, order_id, sku, fnsku, disposition, requested_quantity, shipped_quantity, disposed_quantity, order_date, order_type")
          .eq("organization_id", ORG)
          .in("id", [...removalSurrogates]),
      );
      if (rem.error) console.log(`  amazon_removals ERROR: ${rem.error}`);
      for (const r of rem.rows) {
        console.log(
          `  REMOVAL ${s(r.id)} → order_id=${s(r.order_id)} sku=${s(r.sku)} fnsku=${s(r.fnsku)} disp=${s(r.disposition)} reqQ=${s(r.requested_quantity)} shipQ=${s(r.shipped_quantity)} date=${s(r.order_date)} status=${s(r.order_status)}`,
        );
        if (s(r.order_id)) orderIds.add(s(r.order_id));
      }
    }

    // Resolve amazon_removal_shipments by surrogate id
    if (shipmentSurrogates.size > 0) {
      const sh = await safeSelect(client, "amazon_removal_shipments", (q) =>
        (q as any).select("*").eq("organization_id", ORG).in("id", [...shipmentSurrogates]).limit(5),
      );
      if (sh.error) console.log(`  amazon_removal_shipments ERROR: ${sh.error}`);
      for (const r of sh.rows) {
        console.log(`  SHIPMENT ${s(r.id)} cols=${Object.keys(r).join(",")}`);
        console.log(
          `    order_id=${s((r as any).order_id)} tracking=${s((r as any).tracking_number)} carrier=${s((r as any).carrier)} shipment_date=${s((r as any).shipment_date)} qty=${s((r as any).quantity)}`,
        );
      }
    }

    console.log(`  resolved order_ids: [${[...orderIds].join(", ")}]`);

    // Join financial/event tables by order_id
    if (orderIds.size > 0) {
      const ids = [...orderIds];
      const reim = await safeSelect(client, "amazon_reimbursements", (q) =>
        (q as any)
          .select("id, order_id, reimbursement_id, case_id, sku, fnsku, asin, amount_total, currency_unit, approval_date, reason")
          .eq("organization_id", ORG)
          .in("order_id", ids),
      );
      console.log(`  REIMBURSEMENTS (${reim.rows.length})${reim.error ? " ERROR:" + reim.error : ""}:`);
      for (const r of reim.rows) {
        console.log(
          `    reimbursement_id=${s(r.reimbursement_id)} case_id=${s(r.case_id)} amount=${s(r.amount_total)} ${s(r.currency_unit)} approval=${s(r.approval_date)} order=${s(r.order_id)} row=${s(r.id)}`,
        );
      }

      const txn = await safeSelect(client, "amazon_transactions", (q) =>
        (q as any)
          .select("id, order_id, transaction_type, settlement_id, amount, posted_date, sku")
          .eq("organization_id", ORG)
          .in("order_id", ids),
      );
      console.log(`  TRANSACTIONS (${txn.rows.length})${txn.error ? " ERROR:" + txn.error : ""}:`);
      for (const r of txn.rows) {
        console.log(
          `    txn_row=${s(r.id)} type=${s(r.transaction_type)} settlement_id=${s(r.settlement_id)} amount=${s(r.amount)} ${s(r.currency)} posted=${s(r.posted_date)} order=${s(r.order_id)}`,
        );
      }

      const led = await safeSelect(client, "amazon_inventory_ledger", (q) =>
        (q as any)
          .select("id, reference_id, reason_code, reconciled_quantity, unreconciled_quantity, fnsku, sku, asin")
          .eq("organization_id", ORG)
          .in("reference_id", ids),
      );
      console.log(`  INVENTORY_LEDGER by reference_id (${led.rows.length})${led.error ? " ERROR:" + led.error : ""}:`);
      for (const r of led.rows) {
        console.log(
          `    ref_id=${s(r.reference_id)} reason=${s(r.reason_code)} reconciled=${s(r.reconciled_quantity)} unreconciled=${s(r.unreconciled_quantity)} fnsku=${s(r.fnsku)} row=${s(r.id)}`,
        );
      }
    }
  }
}

void main();
