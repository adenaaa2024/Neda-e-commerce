/**
 * DIAG (read-only) — PHASE-CLAIM-MISSING-SALE-PRICE-SOURCE-IMPORT-V1
 *
 * For the removal claims whose latest-sale-net is UNKNOWN, exhaustively probe every
 * candidate Amazon sale-price/fee source to determine WHY no valid Order sale row is
 * found and EXACTLY what report/API import (if any) is needed.
 *
 * For each missing claim it reports, per source table:
 *   - whether the table exists / has a usable schema
 *   - rows for the SKU (any transaction_type), and the distinct transaction_types seen
 *   - valid Order sale rows (transaction_type='Order' AND product_sales>0) ANY date
 *   - valid Order sale rows at/before EOD(removal event date)  ← the resolver's rule
 *   - the same, matched by FNSKU and ASIN (to detect "loaded but unmapped to SKU")
 *   - $0 / Adjustment-only rows (the known noise)
 *
 * SELECT-only. No writes. No claim mutation. No Amazon submit. No scanner change. No AI.
 *
 *   npx tsx scripts/diag-missing-sale-price-source-import-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeReimbursementTrackingPreviewV1 } from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import { PILOT_CASE_RUN_ID, PILOT_INTAKE_RUN_ID } from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { resolveLatestSaleNetDeterministic } from "../lib/claims/submission/latest-sale-net-resolver-v1";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const RUN_OPTS = { pilot_case_run_id: PILOT_CASE_RUN_ID, intake_run_id: PILOT_INTAKE_RUN_ID };

type Row = Record<string, unknown>;

function str(v: unknown): string {
  return String(v ?? "").trim();
}
function endOfDay(d: string | null): string {
  const day = str(d).slice(0, 10);
  return day ? `${day}T23:59:59.999+00:00` : "2999-12-31T23:59:59.999+00:00";
}

/** Count rows matching eq filters; returns -1 if the table/column does not exist. */
async function countWhere(
  client: SupabaseClient,
  table: string,
  filters: Array<[string, unknown]>,
  gt?: [string, number],
  lte?: [string, string],
): Promise<number> {
  let q = client.from(table).select("*", { count: "exact", head: true }).eq("organization_id", ORG);
  for (const [c, v] of filters) q = q.eq(c, v);
  if (gt) q = q.gt(gt[0], gt[1]);
  if (lte) q = q.lte(lte[0], lte[1]);
  const { count, error } = await q;
  if (error) return -1;
  return count ?? 0;
}

/** Probe a table's existence + a sample of identifier-related columns. */
async function probeTable(
  client: SupabaseClient,
  table: string,
): Promise<{ exists: boolean; columns: string[]; orgRows: number }> {
  const { data, error } = await client.from(table).select("*").limit(1);
  if (error) return { exists: false, columns: [], orgRows: 0 };
  const columns = data && data.length > 0 ? Object.keys(data[0] as Row) : [];
  const orgRows = await countWhere(client, table, []);
  return { exists: true, columns, orgRows };
}

/** Distinct transaction_type + sample for one SKU (to see what IS loaded). */
async function txnTypeBreakdown(
  client: SupabaseClient,
  table: string,
  idCol: string,
  idVal: string,
  dateCol: string,
): Promise<string> {
  const { data, error } = await client
    .from(table)
    .select(`transaction_type, product_sales, ${dateCol}`)
    .eq("organization_id", ORG)
    .eq(idCol, idVal)
    .order(dateCol, { ascending: false })
    .limit(60);
  if (error) return `(err ${error.message.slice(0, 40)})`;
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return "(none)";
  const counts = new Map<string, number>();
  for (const r of rows) {
    const t = str(r.transaction_type) || "(blank)";
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const breakdown = [...counts.entries()].map(([t, n]) => `${t}×${n}`).join(", ");
  const sample = rows
    .slice(0, 3)
    .map((r) => `${str(r[dateCol]).slice(0, 10)} ${str(r.transaction_type)}=${str(r.product_sales)}`)
    .join(" | ");
  return `${breakdown}  [latest: ${sample}]`;
}

type SourceProbe = {
  table: string;
  dateCol: string;
  hasFnsku: boolean;
  hasAsin: boolean;
  storeScoped: boolean;
};

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const client = createClient(process.env.ORIGINAL_SUPABASE_URL!, process.env.ORIGINAL_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  console.log("=== DIAG MISSING-SALE-PRICE-SOURCE-IMPORT-V1 (read-only) ===");
  console.log(`target: kxsvedvpjldygtdbylsy · org=${ORG} · store=${STORE}\n`);

  // ---- 1. Probe candidate source tables ----
  const candidateTables = [
    "amazon_reports_repository",
    "amazon_settlements",
    "amazon_transactions",
    "amazon_all_orders",
    "all_orders",
    "amazon_order_items",
    "amazon_orders",
    "order_items",
    "amazon_settlement_transactions",
  ];
  console.log("--- source_tables_checked ---");
  const tableInfo = new Map<string, { exists: boolean; columns: string[]; orgRows: number }>();
  for (const t of candidateTables) {
    const info = await probeTable(client, t);
    tableInfo.set(t, info);
    const saleCols = info.columns.filter((c) =>
      /product_sales|item.?price|principal|sku|fnsku|asin|transaction_type|posted_date|date_time|selling_fees|fba_fees/i.test(c),
    );
    console.log(
      `  ${t}: exists=${info.exists ? "yes" : "no"} org_rows=${info.exists ? info.orgRows : "—"}` +
        (info.exists ? `\n      sale_cols=[${saleCols.join(", ")}]` : ""),
    );
  }

  // Build active probes for tables that exist and have product_sales + transaction_type.
  const probes: SourceProbe[] = [];
  const repo = tableInfo.get("amazon_reports_repository");
  if (repo?.exists && repo.columns.includes("product_sales")) {
    probes.push({
      table: "amazon_reports_repository",
      dateCol: repo.columns.includes("date_time") ? "date_time" : "posted_date",
      hasFnsku: repo.columns.includes("fnsku"),
      hasAsin: repo.columns.includes("asin"),
      storeScoped: false,
    });
  }
  const setl = tableInfo.get("amazon_settlements");
  if (setl?.exists && setl.columns.includes("product_sales")) {
    probes.push({
      table: "amazon_settlements",
      dateCol: setl.columns.includes("posted_date") ? "posted_date" : "date_time",
      hasFnsku: setl.columns.includes("fnsku"),
      hasAsin: setl.columns.includes("asin"),
      storeScoped: setl.columns.includes("store_id"),
    });
  }

  // ---- 2. Identify missing claims ----
  const composed = await composeReimbursementTrackingPreviewV1(client, ORG, STORE, RUN_OPTS);
  const previews = composed.previews;

  let missingCount = 0;
  let coveredCount = 0;

  for (const p of previews) {
    const sku = str(p.sku);
    const fnsku = str(p.fnsku);
    const asin = str(p.asin);
    const before = endOfDay(p.source_event_date);
    const res = await resolveLatestSaleNetDeterministic(client, {
      organizationId: ORG,
      storeId: STORE,
      sku: p.sku,
      eventDate: p.source_event_date,
    });
    if (res.found) {
      coveredCount += 1;
      continue;
    }
    missingCount += 1;

    console.log(`\n──── MISSING #${missingCount}: ${p.claim_submission_id} · ${p.family_key_v3}`);
    console.log(`     SKU=${sku || "—"}  FNSKU=${fnsku || "—"}  ASIN=${asin || "—"}  qty=${p.clean_quantity}  removal_event=${p.source_event_date}`);
    console.log(`     current_reason=${res.unknown_reason}`);

    for (const pr of probes) {
      const skuTotal = sku ? await countWhere(client, pr.table, [["sku", sku]]) : -2;
      const orderAny = sku
        ? await countWhere(client, pr.table, [["sku", sku], ["transaction_type", "Order"]], ["product_sales", 0])
        : -2;
      const orderBefore = sku
        ? await countWhere(
            client,
            pr.table,
            [["sku", sku], ["transaction_type", "Order"]],
            ["product_sales", 0],
            [pr.dateCol, before],
          )
        : -2;
      const fnskuOrder =
        pr.hasFnsku && fnsku
          ? await countWhere(client, pr.table, [["fnsku", fnsku], ["transaction_type", "Order"]], ["product_sales", 0])
          : -2;
      const asinOrder =
        pr.hasAsin && asin
          ? await countWhere(client, pr.table, [["asin", asin], ["transaction_type", "Order"]], ["product_sales", 0])
          : -2;
      const breakdown = sku ? await txnTypeBreakdown(client, pr.table, "sku", sku, pr.dateCol) : "(no sku)";

      const fmtN = (n: number) => (n === -1 ? "n/a-col" : n === -2 ? "skip" : String(n));
      console.log(
        `     [${pr.table}] sku_rows_any_type=${fmtN(skuTotal)} | Order&sales>0 any_date=${fmtN(orderAny)} | Order&sales>0 <=event=${fmtN(orderBefore)} | by_FNSKU Order=${fmtN(fnskuOrder)} | by_ASIN Order=${fmtN(asinOrder)}`,
      );
      console.log(`        sku transaction_type breakdown: ${breakdown}`);
    }
  }

  console.log(`\n──── SUMMARY ────`);
  console.log(`claims_total: ${previews.length}`);
  console.log(`covered (have valid Order sale): ${coveredCount}`);
  console.log(`missing (UNKNOWN): ${missingCount}`);
  console.log(`\nInterpretation guide:`);
  console.log(`  - If 'Order&sales>0 <=event' > 0 for any source → resolver SHOULD already find it (mapping/date bug).`);
  console.log(`  - If 'Order&sales>0 any_date' > 0 but <=event = 0 → sale exists but AFTER the removal event (not eligible).`);
  console.log(`  - If 'by_FNSKU Order' > 0 while 'sku Order' = 0 → rows loaded under a different SKU → wire FNSKU match.`);
  console.log(`  - If all = 0 and breakdown shows only Adjustment/$0 → NO Order sale loaded → import required.`);
}

void main();
