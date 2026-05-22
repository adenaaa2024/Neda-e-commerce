/**
 * PRODUCT-ID-LINKAGE-CLOSURE-V167 — read-only staging column probe.
 * Run: npx tsx scripts/product-id-linkage-closure-v167-staging-probe.ts --run-id=20260524T180000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

const LINKAGE_COLUMNS = [
  "product_id",
  "resolved_product_id",
  "resolved_catalog_product_id",
  "identifier_resolution_status",
  "identifier_resolution_confidence",
  "asin",
  "fnsku",
  "sku",
  "upc",
  "upc_code",
  "seller_sku",
  "msku",
  "barcode",
  "product_name",
  "name",
  "catalog_product_id",
  "store_id",
  "organization_id",
];

const TABLES = [
  "products",
  "product_identifier_map",
  "return_items",
  "slip_contents",
  "expected_packages",
  "packages",
  "expected_items",
  "claim_reference_edges",
  "claim_evidence_lineage_events",
  "amazon_amazon_fulfilled_inventory",
  "amazon_fba_inventory",
  "amazon_returns",
  "amazon_inventory_ledger",
  "amazon_settlements",
  "amazon_transactions",
  "amazon_all_orders",
];

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromUrl(url: string): string | null {
  const m =
    url.match(/https:\/\/([a-z]{20})\.supabase\.co/i) ||
    url.match(/postgres\.([a-z]{20}):/i) ||
    url.match(/@db\.([a-z]{20})\.supabase\.co/i);
  return m ? m[1]!.toLowerCase() : null;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const runId = runIdArg();
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/product-id-linkage-closure-v167",
    runId,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const url =
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    process.env.SUPABASE_DB_URL?.trim() ||
    null;
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";

  if (!url) {
    const payload = { run_id: runId, error: "DIRECT_POSTGRES_URL unset", probed: false };
    fs.writeFileSync(path.join(outDir, "staging-column-probe.json"), JSON.stringify(payload, null, 2));
    console.log(JSON.stringify(payload, null, 2));
    process.exit(2);
  }

  const projectRef = refFromUrl(publicUrl) || refFromUrl(url) || "unknown";
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const tableExists: Record<string, boolean> = {};
  for (const t of TABLES) {
    const r = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
      [t],
    );
    tableExists[t] = (r.rowCount ?? 0) > 0;
  }

  const columnsByTable: Record<string, { column_name: string; data_type: string }[]> = {};
  const linkagePresent: Record<string, string[]> = {};
  const linkageMissing: Record<string, string[]> = {};

  for (const t of TABLES) {
    if (!tableExists[t]) {
      columnsByTable[t] = [];
      linkagePresent[t] = [];
      linkageMissing[t] = [...LINKAGE_COLUMNS];
      continue;
    }
    const cols = await client.query(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [t],
    );
    columnsByTable[t] = cols.rows as { column_name: string; data_type: string }[];
    const names = new Set(columnsByTable[t].map((c) => c.column_name));
    const present: string[] = [];
    const missing: string[] = [];
    for (const c of LINKAGE_COLUMNS) {
      if (names.has(c)) present.push(c);
      else missing.push(c);
    }
    linkagePresent[t] = present;
    linkageMissing[t] = missing;
  }

  const sampleCounts: Record<string, number | null> = {};
  for (const t of [
    "return_items",
    "slip_contents",
    "expected_packages",
    "product_identifier_map",
    "products",
  ]) {
    if (!tableExists[t]) {
      sampleCounts[t] = null;
      continue;
    }
    const c = await client.query(`SELECT COUNT(*)::bigint AS n FROM public."${t}"`);
    sampleCounts[t] = Number(c.rows[0].n);
  }

  let returnItemsLinkage = null as Record<string, unknown> | null;
  if (tableExists.return_items) {
    const ri = await client.query(`
      SELECT
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint AS with_resolved,
        COUNT(*) FILTER (WHERE identifier_resolution_status IS NOT NULL)::bigint AS with_status,
        COUNT(*) FILTER (WHERE identifier_resolution_status = 'resolved')::bigint AS resolved_status
      FROM public.return_items
    `);
    returnItemsLinkage = ri.rows[0] as Record<string, unknown>;
  }

  let slipLinkage = null as Record<string, unknown> | null;
  if (tableExists.slip_contents) {
    const sl = await client.query(`
      SELECT
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint AS with_resolved,
        COUNT(*) FILTER (WHERE identifier_resolution_status IS NOT NULL)::bigint AS with_status
      FROM public.slip_contents
    `);
    slipLinkage = sl.rows[0] as Record<string, unknown>;
  }

  await client.end();

  const payload = {
    prompt: "PRODUCT-ID-LINKAGE-CLOSURE-V167",
    run_id: runId,
    probed_at: new Date().toISOString(),
    staging_project_ref: projectRef,
    mode: "read_only",
    table_exists: tableExists,
    linkage_present: linkagePresent,
    linkage_missing: linkageMissing,
    columns_by_table: columnsByTable,
    row_counts: sampleCounts,
    return_items_linkage_stats: returnItemsLinkage,
    slip_contents_linkage_stats: slipLinkage,
  };

  fs.writeFileSync(path.join(outDir, "staging-column-probe.json"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify({ run_id: runId, projectRef, table_exists: tableExists }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
