/**
 * PHASE-CLAIM-DEEP-AMAZON-REFERENCE-LEDGER-V1 — read-only census/schema probe.
 *
 * Discovers which Amazon source tables exist + are populated for the pilot org, and
 * their typed columns (esp. date columns for window matching), so the deep ledger
 * composer can search every relevant report honestly. No DB writes.
 *
 *   npx tsx scripts/diag-deep-amazon-reference-census-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";

const TABLES = [
  "amazon_removals",
  "amazon_removal_shipments",
  "amazon_inventory_ledger",
  "amazon_transactions",
  "amazon_settlements",
  "amazon_reimbursements",
  "amazon_customer_returns",
  "reports_repository",
  "amazon_reports_repository",
  "expected_packages",
];

async function probe(client: SupabaseClient, table: string): Promise<void> {
  // existence + columns via a 1-row sample
  let cols: string[] = [];
  let sampleErr: string | null = null;
  try {
    const { data, error } = await client.from(table).select("*").limit(1);
    if (error) sampleErr = error.message;
    else if (data && data[0]) cols = Object.keys(data[0]);
  } catch (e) {
    sampleErr = e instanceof Error ? e.message : String(e);
  }

  // org-scoped count (head)
  let orgCount: number | string = "n/a";
  try {
    const { count, error } = await client
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", ORG);
    orgCount = error ? `ERR(${error.message})` : count ?? 0;
  } catch (e) {
    orgCount = `EXC(${e instanceof Error ? e.message : String(e)})`;
  }

  // global count (head) to distinguish empty-table vs org-empty
  let globalCount: number | string = "n/a";
  try {
    const { count, error } = await client.from(table).select("id", { count: "exact", head: true });
    globalCount = error ? `ERR(${error.message})` : count ?? 0;
  } catch (e) {
    globalCount = `EXC(${e instanceof Error ? e.message : String(e)})`;
  }

  console.log(`\n### ${table}`);
  if (sampleErr) console.log(`  sample_error: ${sampleErr}`);
  console.log(`  org_count=${orgCount}  global_count=${globalCount}`);
  if (cols.length) console.log(`  columns: ${cols.join(", ")}`);
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const client = createClient(
    process.env.ORIGINAL_SUPABASE_URL!,
    process.env.ORIGINAL_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  console.log("=== Deep Amazon reference census (read-only, original/live) ===");
  for (const t of TABLES) await probe(client, t);
}

void main();
