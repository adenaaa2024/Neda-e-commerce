/**
 * FIX-SCANNER-DELETE-UNIT-PERMISSION-WIRING — static + optional staging DB verify
 *   npx tsx scripts/fix-scanner-delete-unit-permission-wiring-verify.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

function staticChecks(): void {
  const migration = read("supabase/migrations/20260912120000_scanner_delete_unit_permission_wiring.sql");
  const guard = read("lib/operator-mobile-permission-guard.ts");
  const perms = read("lib/operator-mobile-permissions.ts");
  const extras = read("lib/sidebar-catalog-extras.ts");
  const actions = read("app/scanner/operator-mobile/_components/operator-store-actions.ts");

  assert.match(migration, /operations\.operator_mobile\.delete_item/);
  assert.match(migration, /_ops_can_scanner_delete_return_item/);
  assert.match(migration, /super_admin.*operator.*system_employee/s);
  assert.match(guard, /"operator"/);
  assert.match(guard, /"system_employee"/);
  assert.match(guard, /OPERATOR_MOBILE_DELETE_ITEM_DENIED_MESSAGE/);
  assert.match(perms, /operations\.operator_mobile\.delete_item/);
  assert.match(extras, /operations\.operator_mobile\.delete_item/);
  assert.match(extras, /operations\.operator_mobile\.edit_item/);
  assert.match(actions, /assertOperatorMobilePermission\(organizationId, OPERATOR_MOBILE_DELETE_ITEM\)/);
  assert.match(actions, /assertOperatorMobileScannedUnitDeleteScope/);
  assert.match(actions, /mapScannerDeleteRpcError/);
  assert.match(actions, /assertOperatorMobilePermission\(organizationId, OPERATOR_MOBILE_EDIT_ITEM\)/);
}

async function dbChecks(url: string): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const perm = await client.query(
      `SELECT key FROM permissions WHERE key = 'operations.operator_mobile.delete_item'`,
    );
    const grants = await client.query(
      `SELECT r.key AS role_key
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE p.key = 'operations.operator_mobile.delete_item'
       ORDER BY r.key`,
    );
    const fn = await client.query(
      `SELECT 1 FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = '_ops_can_scanner_delete_return_item'`,
    );
    return {
      permission_row: perm.rowCount === 1,
      roles_granted: grants.rows.map((r: { role_key: string }) => r.role_key),
      rpc_helper_present: (fn.rowCount ?? 0) === 1,
    };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  staticChecks();

  const out: Record<string, unknown> = {
    permission_definitions_found: [
      "lib/operator-mobile-permissions.ts",
      "lib/sidebar-catalog-extras.ts",
      "supabase/migrations/20260912120000_scanner_delete_unit_permission_wiring.sql",
    ],
    permission_key_standardized: "operations.operator_mobile.delete_item",
    rpc_mapping_needed: "yes — _ops_can_scanner_delete_return_item maps scanner delete into delete_return_item_with_expected_release",
    static_checks: "pass",
  };

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (stagingUrl.includes(STAGING_REF)) {
    out.staging_db = await dbChecks(stagingUrl);
  } else {
    out.staging_db = { skipped: "STAGING_DIRECT_POSTGRES_URL unset or wrong ref" };
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
