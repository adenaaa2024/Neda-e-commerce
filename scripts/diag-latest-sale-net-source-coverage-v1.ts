/**
 * DIAG (read-only): test deterministic latest-sale-net resolution for the 10 pilot removal claims.
 *
 * Rule under test: among amazon_reports_repository (Transaction View) then amazon_settlements
 * rows for the same SKU with transaction_type='Order' and product_sales > 0 posted at/before the
 * claim source_event_date, pick the latest by date with a stable (date desc, id desc) tie-break.
 * Fees come from the SAME selected row (|selling_fees| + |fba_fees| + |other|). No writes.
 *
 *   npx tsx scripts/diag-latest-sale-net-source-coverage-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeReimbursementTrackingPreviewV1 } from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import { PILOT_CASE_RUN_ID, PILOT_INTAKE_RUN_ID } from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function endOfDay(d: string): string {
  const day = String(d).slice(0, 10);
  return `${day}T23:59:59.999+00:00`;
}

async function orderRows(
  client: SupabaseClient,
  table: string,
  dateCol: string,
  sku: string,
  beforeIso: string,
  storeScoped: boolean,
): Promise<Record<string, unknown>[]> {
  let q = client
    .from(table)
    .select("id, sku, " + dateCol + ", transaction_type, product_sales, selling_fees, fba_fees, other_transaction_fees, other_amount, quantity, order_id")
    .eq("organization_id", ORG)
    .eq("sku", sku)
    .eq("transaction_type", "Order")
    .gt("product_sales", 0)
    .lte(dateCol, beforeIso)
    .order(dateCol, { ascending: false })
    .order("id", { ascending: false })
    .limit(5);
  if (storeScoped) q = q.eq("store_id", STORE);
  const { data, error } = await q;
  if (error) {
    console.log(`     ! ${table} err: ${error.message}`);
    return [];
  }
  return (data ?? []) as Record<string, unknown>[];
}

function feesOf(r: Record<string, unknown>): number {
  return (
    Math.abs(num(r.selling_fees) ?? 0) +
    Math.abs(num(r.fba_fees) ?? 0) +
    Math.abs(num(r.other_transaction_fees) ?? 0)
  );
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const client = createClient(process.env.ORIGINAL_SUPABASE_URL!, process.env.ORIGINAL_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const composed = await composeReimbursementTrackingPreviewV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });

  let priceCovered = 0;
  let feeCovered = 0;

  for (const p of composed.previews) {
    const sku = String(p.sku ?? "");
    const before = endOfDay(p.source_event_date ?? "2999-01-01");
    const repo = await orderRows(client, "amazon_reports_repository", "date_time", sku, before, false);
    const setl = await orderRows(client, "amazon_settlements", "posted_date", sku, before, true);

    const repoTop = repo[0];
    const setlTop = setl[0];
    const chosen = repoTop
      ? { src: "amazon_reports_repository.product_sales", row: repoTop, date: String(repoTop.date_time) }
      : setlTop
        ? { src: "amazon_settlements.product_sales", row: setlTop, date: String(setlTop.posted_date) }
        : null;

    console.log(`---- ${p.claim_submission_id} · ${p.family_key_v3} · sku=${sku} qty=${p.clean_quantity} event=${p.source_event_date}`);
    console.log(`     repo Order rows<=event: ${repo.length}  setl Order rows<=event: ${setl.length}`);
    if (chosen) {
      const price = num(chosen.row.product_sales);
      const fees = feesOf(chosen.row);
      const qty = num(p.clean_quantity) ?? 0;
      priceCovered += 1;
      if (fees > 0) feeCovered += 1;
      console.log(`     CHOSEN ${chosen.src} date=${chosen.date} price=${price} fees=${fees} expected=(${price}-${fees})x${qty}=${((((price ?? 0) - fees)) * qty).toFixed(2)}`);
      if (repo.length > 1) console.log(`     alt repo dates: ${repo.slice(1).map((r) => `${r.date_time}=${r.product_sales}`).join(", ")}`);
    } else {
      console.log(`     NO valid Order sale at/before event for sku=${sku}`);
    }
    console.log("");
  }

  console.log(`=== price_coverage=${priceCovered}/${composed.previews.length}  fee_coverage=${feeCovered}/${composed.previews.length} ===`);
}

void main();
