/**
 * FIX_MISSING_ALLOCATE_EXPECTED_ITEMS_RPC_ON_ORIGINAL — audit staging vs original
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const MIGRATION = "supabase/migrations/20260830120000_expected_receive_split_item_level.sql";
const OUT_BASE = ".cursor/audit-reports/fix-missing-allocate-rpc-original";

const RPC_NAMES = [
  "allocate_expected_item_unit",
  "allocate_expected_items_for_return_item_ids",
  "release_expected_item_unit",
  "move_expected_item_unit",
  "_normalize_tracking_token",
  "_ep_build_source_rank",
] as const;

const EP_COLS = [
  "parent_expected_package_id",
  "receive_scope_key",
  "allocated_package_id",
  "allocated_pallet_id",
  "receive_entity_type",
] as const;

async function fnSignatures(client: pg.Client, name: string): Promise<string[]> {
  const r = await client.query<{ sig: string }>(
    `SELECT pg_get_function_identity_arguments(p.oid) AS sig
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = $1
     ORDER BY sig`,
    [name],
  );
  return r.rows.map((row) => row.sig);
}

async function columnExists(client: pg.Client, table: string, col: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, col],
  );
  return (r.rowCount ?? 0) > 0;
}

async function probeDb(label: string, url: string) {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '60s'");
  try {
    const rpcs: Record<string, { exists: boolean; signatures: string[] }> = {};
    for (const name of RPC_NAMES) {
      const signatures = await fnSignatures(client, name);
      rpcs[name] = { exists: signatures.length > 0, signatures };
    }
    const epCols: Record<string, boolean> = {};
    for (const col of EP_COLS) {
      epCols[col] = await columnExists(client, "expected_packages", col);
    }
    const riExpected = await columnExists(client, "return_items", "expected_item_id");
    return { label, rpcs, epCols, return_items_expected_item_id: riExpected };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim();
  if (!stagingUrl?.includes(STAGING_REF) || !originalUrl?.includes(ORIGINAL_REF)) {
    throw new Error("STAGING_DIRECT_POSTGRES_URL and ORIGINAL_DIRECT_POSTGRES_URL required.");
  }

  const staging = await probeDb("staging", stagingUrl);
  const original = await probeDb("original", originalUrl);

  const report = {
    prompt: "FIX_MISSING_ALLOCATE_EXPECTED_ITEMS_RPC_ON_ORIGINAL",
    migration_file: MIGRATION,
    migration_timestamp: "20260830120000",
    caller: {
      primary: "lib/scanner/receive-expected-with-split.ts allocateExpectedItemsForReturnItemIds",
      params: {
        p_return_item_ids: "uuid[]",
        p_expected_package_hint: "uuid | null",
        p_receive_scope_key: "text | null",
      },
      secondary: "app/scanner/operator-mobile/item-actions.ts",
    },
    exists_on_staging: staging.rpcs.allocate_expected_items_for_return_item_ids.exists,
    exists_on_original: original.rpcs.allocate_expected_items_for_return_item_ids.exists,
    signature_on_staging: staging.rpcs.allocate_expected_items_for_return_item_ids.signatures,
    signature_on_original: original.rpcs.allocate_expected_items_for_return_item_ids.signatures,
    staging,
    original,
  };

  fs.writeFileSync(path.join(outDir, "audit.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
