/**
 * DIAG (read-only) — repo Order-sale re-probe for the 3 distinct missing SKUs.
 *
 * The coverage diag's exact-count over amazon_reports_repository (412k rows) errored
 * ("n/a-col" = exact-count timeout). This re-probe uses limit-based existence checks
 * (no exact count) to definitively answer: does amazon_reports_repository hold ANY
 * Order sale (transaction_type='Order' AND product_sales>0) for these SKUs?
 *
 * SELECT-only. No writes.
 *
 *   npx tsx scripts/diag-repo-order-sale-reprobe-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const SKUS = ["I6-VR35-FSXQ", "WD-VY8Z-CZ3F", "2H-7ZAX-Z2IP"];

async function existsOrderSale(client: SupabaseClient, table: string, dateCol: string, sku: string): Promise<{ n: number; sample: string; err: string | null }> {
  const { data, error } = await client
    .from(table)
    .select(`id, ${dateCol}, transaction_type, product_sales, selling_fees, fba_fees`)
    .eq("organization_id", ORG)
    .eq("sku", sku)
    .eq("transaction_type", "Order")
    .gt("product_sales", 0)
    .order(dateCol, { ascending: false })
    .limit(5);
  if (error) return { n: -1, sample: "", err: error.message };
  const rows = (data ?? []) as Record<string, unknown>[];
  const sample = rows
    .map((r) => `${String(r[dateCol]).slice(0, 10)} ps=${r.product_sales} sf=${r.selling_fees} fba=${r.fba_fees}`)
    .join(" | ");
  return { n: rows.length, sample, err: null };
}

/** Any product_sales>0 row regardless of transaction_type (detect mislabeled sales). */
async function anyPositiveSale(client: SupabaseClient, table: string, dateCol: string, sku: string): Promise<{ n: number; sample: string }> {
  const { data, error } = await client
    .from(table)
    .select(`id, ${dateCol}, transaction_type, product_sales`)
    .eq("organization_id", ORG)
    .eq("sku", sku)
    .gt("product_sales", 0)
    .order(dateCol, { ascending: false })
    .limit(5);
  if (error) return { n: -1, sample: error.message.slice(0, 50) };
  const rows = (data ?? []) as Record<string, unknown>[];
  return {
    n: rows.length,
    sample: rows.map((r) => `${String(r[dateCol]).slice(0, 10)} ${r.transaction_type}=${r.product_sales}`).join(" | "),
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const client = createClient(process.env.ORIGINAL_SUPABASE_URL!, process.env.ORIGINAL_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  console.log("=== repo Order-sale re-probe (limit-based, timeout-safe) ===\n");
  for (const sku of SKUS) {
    console.log(`SKU ${sku}:`);
    for (const [table, dateCol] of [
      ["amazon_reports_repository", "date_time"],
      ["amazon_settlements", "posted_date"],
    ] as const) {
      const ord = await existsOrderSale(client, table, dateCol, sku);
      const pos = await anyPositiveSale(client, table, dateCol, sku);
      console.log(
        `  [${table}] Order&sales>0 found=${ord.n < 0 ? `ERR(${ord.err})` : ord.n}` +
          (ord.n > 0 ? `\n      ${ord.sample}` : "") +
          `\n      ANY product_sales>0 (any type) found=${pos.n < 0 ? `ERR(${pos.sample})` : pos.n}` +
          (pos.n > 0 ? `\n      ${pos.sample}` : ""),
      );
    }
    console.log("");
  }
}

void main();
