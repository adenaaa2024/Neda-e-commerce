/**
 * PHASE-CLAIM-RECOVERY-GAP-AND-REIMBURSEMENT-MATCHING-V1 — read-only probe.
 *
 * Inspects, for the pilot removal order ids, what transaction_type / reason values
 * the order-linked settlement/transaction/reimbursement rows actually carry, so the
 * recovery-gap classifier counts ONLY real reimbursement/credit rows. No writes.
 *
 *   npx tsx scripts/diag-recovery-gap-reimbursement-probe-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const ORDER_IDS = ["1621GIL", "/x5UTzvZZK", "/571WdHlKl"];
const FNSKUS = ["X004D9AMWV", "X003VSWH37", "X004TRQBB3", "X004WJ8OE5", "X004N992LN", "X004LLJMN1"];

async function dist(client: SupabaseClient, table: string, col: string, rows: Record<string, unknown>[]): Promise<void> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = String(r[col] ?? "∅");
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  console.log(`  ${table}.${col} distribution (${rows.length} rows):`);
  for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${v.toString().padStart(4)}  ${k}`);
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const client = createClient(process.env.ORIGINAL_SUPABASE_URL!, process.env.ORIGINAL_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  console.log("=== Recovery-gap reimbursement probe (read-only) ===");

  // amazon_transactions by order_id
  const { data: txn } = await client
    .from("amazon_transactions")
    .select("order_id, transaction_type, amount, posted_date, sku, settlement_id")
    .eq("organization_id", ORG)
    .in("order_id", ORDER_IDS);
  console.log(`\n## amazon_transactions for pilot order ids → ${txn?.length ?? 0} rows`);
  await dist(client, "amazon_transactions", "transaction_type", txn ?? []);
  for (const r of (txn ?? []).slice(0, 8)) console.log(`    ${r.order_id} | ${r.transaction_type} | amount=${r.amount} | ${r.posted_date} | sku=${r.sku}`);

  // amazon_settlements by order_id
  const { data: set } = await client
    .from("amazon_settlements")
    .select("order_id, transaction_type, amount_total, posted_date, sku, settlement_id")
    .eq("organization_id", ORG)
    .in("order_id", ORDER_IDS)
    .limit(200);
  console.log(`\n## amazon_settlements for pilot order ids → ${set?.length ?? 0} rows`);
  await dist(client, "amazon_settlements", "transaction_type", set ?? []);

  // amazon_reimbursements by order_id (strong) — expect 0
  const { data: reimByOrder } = await client
    .from("amazon_reimbursements")
    .select("order_id, reimbursement_id, reason, amount_total, quantity_reimbursed_total, approval_date")
    .eq("organization_id", ORG)
    .in("order_id", ORDER_IDS);
  console.log(`\n## amazon_reimbursements by order_id → ${reimByOrder?.length ?? 0} rows`);
  for (const r of reimByOrder ?? []) console.log(`    ${r.order_id} | ${r.reimbursement_id} | ${r.reason} | amt=${r.amount_total} | qty=${r.quantity_reimbursed_total}`);

  // amazon_reimbursements by fnsku (window candidates) — reason distribution
  const { data: reimByFnsku } = await client
    .from("amazon_reimbursements")
    .select("fnsku, reason, amount_total, quantity_reimbursed_total, approval_date, order_id")
    .eq("organization_id", ORG)
    .in("fnsku", FNSKUS)
    .limit(300);
  console.log(`\n## amazon_reimbursements by pilot FNSKUs → ${reimByFnsku?.length ?? 0} rows`);
  await dist(client, "amazon_reimbursements", "reason", reimByFnsku ?? []);
}

void main();
