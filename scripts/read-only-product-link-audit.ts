/**
 * NEXT-PRODUCT-ID-02 — Read-only product link column probe via PostgREST.
 *
 * Uses Supabase JS `select` with a limit of 0 rows (headers-only style read).
 * If a column does not exist, PostgREST returns an error — we record MISSING.
 *
 * Requirements (optional — script exits 0 with skip message if unset):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY  (read-only usage; bypasses RLS for audit visibility)
 *
 * No INSERT/UPDATE/DELETE. No migrations. No import writer changes.
 *
 *   npx tsx scripts/read-only-product-link-audit.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type ProbeResult = { table: string; column: string; status: "OK" | "MISSING" | "NO_TABLE" | "ERROR"; detail?: string };

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

/** Minimal column sets to validate resolver / lineage wiring (extend as needed). */
const TABLE_COLUMNS: Record<string, string[]> = {
  products: ["id", "organization_id", "store_id"],
  catalog_products: ["id", "organization_id", "store_id"],
  product_identifier_map: ["id", "organization_id", "store_id", "product_id"],
  product_identity_staging_rows: ["id", "organization_id"],
  amazon_amazon_fulfilled_inventory: ["id", "organization_id", "store_id", "resolved_product_id"],
  amazon_manage_fba_inventory: ["id", "organization_id", "store_id", "resolved_product_id"],
  amazon_fba_inventory: ["id", "organization_id", "store_id", "resolved_product_id"],
  amazon_inventory_ledger: ["id", "organization_id", "resolved_product_id", "sku", "asin"],
  amazon_all_orders: ["id", "organization_id", "resolved_product_id", "sku"],
  amazon_returns: ["id", "organization_id", "store_id"],
  amazon_reimbursements: ["id", "organization_id"],
  amazon_removals: ["id", "organization_id", "store_id", "sku"],
  amazon_removal_shipments: ["id", "organization_id", "store_id"],
  amazon_reports_repository: ["id", "organization_id", "upload_id"],
  claim_candidates: ["id", "organization_id", "store_id", "resolved_product_id", "source_table", "source_row_id"],
};

async function probeColumn(sb: SupabaseClient, table: string, column: string): Promise<ProbeResult> {
  const sel = `${column}`;
  const { error } = await sb.from(table).select(sel).limit(1);
  if (!error) return { table, column, status: "OK" };
  const msg = error.message.toLowerCase();
  if (msg.includes("relation") && msg.includes("does not exist")) {
    return { table, column, status: "NO_TABLE", detail: error.message };
  }
  if (msg.includes("does not exist") || (msg.includes("column") && msg.includes("not found"))) {
    return { table, column, status: "MISSING", detail: error.message };
  }
  return { table, column, status: "ERROR", detail: error.message };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const sqlPath = path.join(process.cwd(), "docs/product-identity/sql/01_column_presence_audit.sql");
  if (!fs.existsSync(sqlPath)) {
    console.error("Missing SQL bundle:", sqlPath);
    process.exitCode = 1;
    return;
  }

  if (!url || !key) {
    console.log("read-only-product-link-audit: SKIP (set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to probe live).");
    console.log("Bundled SQL for manual run:", sqlPath);
    process.exitCode = 0;
    return;
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });
  const results: ProbeResult[] = [];

  for (const [table, cols] of Object.entries(TABLE_COLUMNS)) {
    for (const col of cols) {
      results.push(await probeColumn(sb, table, col));
    }
  }

  const missing = results.filter((r) => r.status === "MISSING" || r.status === "NO_TABLE");
  const errors = results.filter((r) => r.status === "ERROR");

  console.log(JSON.stringify({ ok: errors.length === 0, probed: results.length, missing, errors }, null, 2));

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}

void main();
