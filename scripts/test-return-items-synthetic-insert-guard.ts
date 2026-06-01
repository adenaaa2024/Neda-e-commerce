/**
 * Unit + optional staging DB checks for synthetic bulk-orphan INSERT guard.
 *   npx tsx scripts/test-return-items-synthetic-insert-guard.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { RETURN_ITEMS_TABLE } from "../app/returns/returns-constants";
import {
  isSyntheticBulkOrphanInsertBlocked,
  SYNTHETIC_BULK_ORPHAN_INSERT_ERROR,
} from "../lib/return-item-physical-scan";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const MIGRATION = "20260601143000_return_items_block_synthetic_bulk_orphan_insert.sql";

function unitTests(): void {
  assert.equal(
    isSyntheticBulkOrphanInsertBlocked({
      expected_item_id: "ep-1",
      package_id: null,
      pallet_id: null,
      created_by: null,
    }),
    true,
  );
  assert.equal(
    isSyntheticBulkOrphanInsertBlocked({
      expected_item_id: "ep-1",
      package_id: "pkg-1",
      pallet_id: null,
      created_by: null,
    }),
    false,
  );
  assert.equal(
    isSyntheticBulkOrphanInsertBlocked({
      expected_item_id: null,
      package_id: null,
      pallet_id: null,
      created_by: null,
    }),
    false,
  );
  assert.equal(
    isSyntheticBulkOrphanInsertBlocked({
      expected_item_id: "ep-1",
      package_id: null,
      pallet_id: null,
      created_by: "operator-uuid",
    }),
    false,
  );

  const mig = fs.readFileSync(path.join(process.cwd(), "supabase/migrations", MIGRATION), "utf8");
  assert.match(mig, /trg_return_items_block_synthetic_bulk_orphan_insert/);
  assert.match(mig, /BEFORE INSERT ON public\.return_items/);

  const actions = fs.readFileSync(path.join(process.cwd(), "app/returns/actions.ts"), "utf8");
  assert.match(actions, /isSyntheticBulkOrphanInsertBlocked/);
  assert.match(actions, /SYNTHETIC_BULK_ORPHAN_INSERT_ERROR/);
}

async function stagingDbTests(): Promise<Record<string, unknown>> {
  loadEnvLocalIntoProcess();
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url?.includes(STAGING_REF)) return { skipped: "no staging postgres url" };

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const trig = await client.query(`
    SELECT tgname FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'return_items'
      AND NOT t.tgisinternal
      AND tgname = 'trg_return_items_block_synthetic_bulk_orphan_insert'
  `);
  const triggerPresent = trig.rows.length > 0;

  const orgId = "00000000-0000-0000-0000-000000000001";
  const storeId = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
  const epRes = await client.query(
    `SELECT id::text FROM expected_packages WHERE organization_id = $1::uuid LIMIT 1`,
    [orgId],
  );
  const epId = String(epRes.rows[0]?.id ?? "");

  let syntheticBlocked = false;
  let physicalAllowed = false;
  let syntheticMsg = "";
  let physicalError = "";

  const pkgRes = await client.query(
    `SELECT id::text FROM packages
     WHERE organization_id = $1::uuid AND deleted_at IS NULL
     LIMIT 1`,
    [orgId],
  );
  const pkgId = String(pkgRes.rows[0]?.id ?? "");

  await client.query("BEGIN");
  try {
    if (epId && orgId) {
      await client.query("SAVEPOINT synthetic_test");
      try {
        await client.query(
          `INSERT INTO return_items (
            organization_id, store_id, marketplace, item_name, conditions, status,
            expected_item_id, package_id, pallet_id, created_by
          ) VALUES (
            $1::uuid, $2::uuid, 'amazon', 'guard-test-synthetic', ARRAY['sellable_ok']::text[], 'received',
            $3::uuid, NULL, NULL, NULL
          )`,
          [orgId, storeId || null, epId],
        );
        await client.query("ROLLBACK TO SAVEPOINT synthetic_test");
      } catch (e) {
        syntheticMsg = e instanceof Error ? e.message : String(e);
        syntheticBlocked = syntheticMsg.includes("return_items_insert_blocked");
        await client.query("ROLLBACK TO SAVEPOINT synthetic_test");
      }
    }

    if (pkgId && orgId) {
      try {
        const ins = await client.query(
          `INSERT INTO return_items (
            organization_id, store_id, marketplace, item_name, conditions, status,
            package_id
          ) VALUES (
            $1::uuid, $2::uuid, 'amazon', 'guard-test-physical', ARRAY['sellable_ok']::text[], 'received',
            $3::uuid
          ) RETURNING id::text`,
          [orgId, storeId, pkgId],
        );
        physicalAllowed = Boolean(ins.rows[0]?.id);
      } catch (e) {
        physicalError = e instanceof Error ? e.message : String(e);
      }
    }
  } finally {
    await client.query("ROLLBACK");
  }

  await client.end();

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  let appGuardViaInsertReturn: string | null = null;
  if (sbUrl?.includes(STAGING_REF) && key && epId) {
    const sb = createClient(sbUrl, key, { auth: { persistSession: false } });
    const { error } = await sb.from(RETURN_ITEMS_TABLE).insert({
      organization_id: orgId,
      store_id: storeId,
      marketplace: "amazon",
      item_name: "guard-test-sb-synthetic",
      conditions: ["sellable_ok"],
      status: "received",
      expected_item_id: epId,
      package_id: null,
      pallet_id: null,
      created_by: null,
    });
    appGuardViaInsertReturn = error?.message ?? null;
  }

  const itemActions = fs.readFileSync(
    path.join(process.cwd(), "app/scanner/operator-mobile/item-actions.ts"),
    "utf8",
  );
  const scannerPathAllowed =
    itemActions.includes("insertReturn") &&
    /package_id/.test(itemActions) &&
    !isSyntheticBulkOrphanInsertBlocked({
      expected_item_id: "00000000-0000-0000-0000-000000000001",
      package_id: "00000000-0000-0000-0000-000000000002",
      pallet_id: null,
      created_by: "00000000-0000-0000-0000-0000000000fe",
    });

  return {
    trigger_present: triggerPresent,
    synthetic_blocked: syntheticBlocked,
    synthetic_msg: syntheticMsg.slice(0, 200),
    physical_allowed: physicalAllowed,
    physical_error: physicalError.slice(0, 200),
    service_role_insert_blocked: Boolean(
      appGuardViaInsertReturn?.includes("return_items_insert_blocked"),
    ),
    scanner_path_allowed: scannerPathAllowed,
  };
}

async function main(): Promise<void> {
  unitTests();
  const staging = await stagingDbTests();
  const ok =
    staging.skipped ||
    (staging.trigger_present === true &&
      staging.synthetic_blocked === true &&
      staging.service_role_insert_blocked === true &&
      (staging.physical_allowed === true || staging.scanner_path_allowed === true));

  console.log(
    JSON.stringify(
      {
        ok,
        unit: "pass",
        staging,
        scanner_insert_still_allowed:
          staging.physical_allowed === true || staging.scanner_path_allowed === true,
        synthetic_insert_blocked:
          staging.synthetic_blocked === true || staging.service_role_insert_blocked === true,
      },
      null,
      2,
    ),
  );
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
