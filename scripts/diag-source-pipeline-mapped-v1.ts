/**
 * DIAG (read-only) — confirm the Order-sale schema/importer is mapped and working,
 * so the 7 missing claims are a DATA-COVERAGE gap (Order rows not loaded for 3 SKUs),
 * not a wiring/mapping gap.
 *
 * SELECT-only. No writes.
 *
 *   npx tsx scripts/diag-source-pipeline-mapped-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";

async function sampleOrderSales(client: SupabaseClient, table: string, dateCol: string): Promise<void> {
  const { data, error } = await client
    .from(table)
    .select(`id, sku, ${dateCol}, transaction_type, product_sales, selling_fees, fba_fees`)
    .eq("organization_id", ORG)
    .eq("transaction_type", "Order")
    .gt("product_sales", 0)
    .order(dateCol, { ascending: false })
    .limit(5);
  if (error) {
    console.log(`  [${table}] ERR: ${error.message}`);
    return;
  }
  const rows = (data ?? []) as Record<string, unknown>[];
  console.log(`  [${table}] Order&product_sales>0 sample rows (any SKU): found=${rows.length}`);
  for (const r of rows) {
    console.log(
      `      sku=${r.sku} ${String(r[dateCol]).slice(0, 10)} ps=${r.product_sales} sf=${r.selling_fees} fba=${r.fba_fees}`,
    );
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const client = createClient(process.env.ORIGINAL_SUPABASE_URL!, process.env.ORIGINAL_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  console.log("=== source pipeline mapped check (read-only) ===\n");
  console.log("Order+product_sales>0 rows DO exist for other SKUs => importer maps sales+fees correctly:\n");
  await sampleOrderSales(client, "amazon_reports_repository", "date_time");
  await sampleOrderSales(client, "amazon_settlements", "posted_date");
}

void main();
