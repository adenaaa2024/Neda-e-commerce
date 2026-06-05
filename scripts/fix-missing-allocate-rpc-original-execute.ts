/**
 * FIX_MISSING_ALLOCATE_EXPECTED_ITEMS_RPC_ON_ORIGINAL — apply item-level RPC pack on original.
 *
 *   npx tsx scripts/fix-missing-allocate-rpc-original-audit.ts
 *   set APPROVED_TO_RESTORE_MISSING_SCANNER_RPC=true
 *   npx tsx scripts/fix-missing-allocate-rpc-original-execute.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const MIGRATION = "supabase/migrations/20260830120000_expected_receive_split_item_level.sql";
const PACK_DIR = ".cursor/audit-reports/fix-missing-allocate-rpc-original/20260604T230000Z";

const TARGET_SIG =
  "p_return_item_ids uuid[], p_expected_package_hint uuid, p_receive_scope_key text";

async function fnSignatures(client: pg.Client, name: string): Promise<string[]> {
  const r = await client.query<{ sig: string }>(
    `SELECT pg_get_function_identity_arguments(p.oid) AS sig
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = $1 ORDER BY sig`,
    [name],
  );
  return r.rows.map((row) => row.sig);
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const approved = process.env.APPROVED_TO_RESTORE_MISSING_SCANNER_RPC?.trim().toLowerCase() === "true";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim();
  if (!originalUrl?.includes(ORIGINAL_REF)) {
    throw new Error(`ORIGINAL_DIRECT_POSTGRES_URL must target ${ORIGINAL_REF}`);
  }

  const packAbs = path.join(process.cwd(), PACK_DIR);
  fs.mkdirSync(packAbs, { recursive: true });

  const client = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const before = await fnSignatures(client, "allocate_expected_items_for_return_item_ids");
  const hadTargetSig = before.includes(TARGET_SIG);

  let applied = false;
  let applyError: string | null = null;

  if (!hadTargetSig && approved) {
    const sql = fs.readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
    try {
      await client.query(sql);
      applied = true;
    } catch (e) {
      applyError = e instanceof Error ? e.message : String(e);
    }
  }

  const after = await fnSignatures(client, "allocate_expected_items_for_return_item_ids");
  const hasTargetSig = after.includes(TARGET_SIG);

  let probeOk = false;
  let probeError: string | null = null;
  if (hasTargetSig) {
    try {
      const probe = await client.query(
        `SELECT * FROM public.allocate_expected_items_for_return_item_ids(
          ARRAY['00000000-0000-0000-0000-000000000099'::uuid],
          NULL::uuid,
          NULL::text
        ) LIMIT 1`,
      );
      probeOk = Array.isArray(probe.rows);
    } catch (e) {
      probeError = e instanceof Error ? e.message : String(e);
    }
  }

  await client.end();

  const report = {
    ok: !applyError && hasTargetSig,
    approved,
    applied,
    apply_error: applyError,
    rpc_restored: hasTargetSig,
    schema_cache_refreshed: applied,
    signature_before: before,
    signature_after: after,
    probe_ok: probeOk,
    probe_error: probeError,
    scanner_save_unit_ready: hasTargetSig && probeOk,
    safe_for_operator_test: hasTargetSig && probeOk,
    migration_file: MIGRATION,
    pack_dir: PACK_DIR,
  };

  fs.writeFileSync(path.join(packAbs, "execute-result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (applyError) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
