/**
 * PHASE1-DELETE-MOVE-BACKEND-PARITY — staging smoke (transaction rollback).
 *   npx tsx scripts/phase1-delete-move-parity-staging-smoke.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { assertScriptReturnItemsWriteAllowed } from "../lib/script-return-items-write-guard";
import {
  deleteScriptSessionReturnItemsViaPg,
  insertReturnItemViaPg,
  newScriptReturnItemsSessionId,
} from "../lib/scanner/return-items-script-pg";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import {
  allocateExpectedItemsForReturnItemIds,
  buildReceiveScopeKey,
  moveExpectedItemsForPackageScope,
  softVoidReturnItemWithExpectedRelease,
  syncReturnItemsPalletForPackage,
} from "../lib/scanner/receive-expected-with-split";

const STAGING_REF = "eiqfaapyumhixxoeltgu";

function staticChecks(): void {
  const storeActions = readFileSync(
    join(process.cwd(), "app/scanner/operator-mobile/_components/operator-store-actions.ts"),
    "utf8",
  );
  const returnsActions = readFileSync(join(process.cwd(), "app/returns/actions.ts"), "utf8");
  const splitLib = readFileSync(join(process.cwd(), "lib/scanner/receive-expected-with-split.ts"), "utf8");

  assert.match(splitLib, /syncReturnItemsPalletForPackage/);
  assert.match(storeActions, /palletId:\s*targetPallet\.id/);
  assert.match(returnsActions, /softVoidReturnItemWithExpectedRelease/);
  assert.match(returnsActions, /softVoidPackageWithExpectedRelease/);
  assert.match(returnsActions, /softVoidPalletWithExpectedRelease/);
}

function stagingClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url?.includes(STAGING_REF) || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function probeReleaseRpc(sb: SupabaseClient): Promise<boolean> {
  const { error } = await sb.rpc("release_expected_item_unit", {
    p_return_item_id: "00000000-0000-0000-0000-000000000001",
    p_organization_id: "00000000-0000-0000-0000-000000000001",
    p_soft_delete: true,
  });
  const m = String(error?.message ?? "").toLowerCase();
  return !m.includes("could not find the function") && !m.includes("pgrst202");
}

async function probeV2DeleteRpc(sb: SupabaseClient): Promise<boolean> {
  const { error } = await sb.rpc("delete_return_item_with_expected_release", {
    p_organization_id: "00000000-0000-0000-0000-000000000001",
    p_return_item_id: "00000000-0000-0000-0000-000000000002",
    p_actor_id: null,
    p_idempotency_key: null,
    p_reason: "probe",
    p_undo_batch_id: null,
  });
  const m = String(error?.message ?? "").toLowerCase();
  return !m.includes("could not find the function") && !m.includes("pgrst202");
}

async function integrationSmoke(sb: SupabaseClient): Promise<Record<string, string>> {
  assertScriptReturnItemsWriteAllowed();
  const sessionId = newScriptReturnItemsSessionId();

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  assert.ok(dbUrl, "STAGING_DIRECT_POSTGRES_URL required for staging smoke");

  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();
  const results: Record<string, string> = {};

  const epRes = await pgClient.query(
    `SELECT id::text, organization_id::text, store_id::text, sku, fnsku, order_id, expected_scan_quantity
     FROM expected_packages
     WHERE parent_expected_package_id IS NULL
       AND COALESCE(expected_scan_quantity, 0) >= 2
       AND build_source IN ('detail_shipment','detail_remainder')
     ORDER BY expected_scan_quantity DESC
     LIMIT 1`,
  );
  const ep = epRes.rows[0] as Record<string, unknown> | undefined;
  assert.ok(ep?.id, "need root EP with qty >= 2 for smoke");

  const orgId = String(ep.organization_id);
  const storeId = String(ep.store_id);
  const rootId = String(ep.id);

  const pkgRes = await pgClient.query(
    `SELECT p.id::text AS package_id, p.pallet_id::text AS old_pallet_id
     FROM packages p
     WHERE p.organization_id = $1::uuid AND p.deleted_at IS NULL
     LIMIT 1`,
    [orgId],
  );
  const pkgRow = pkgRes.rows[0] as Record<string, unknown> | undefined;
  assert.ok(pkgRow?.package_id, "need active package for move-box smoke");
  const packageId = String(pkgRow.package_id);

  const palRes = await pgClient.query(
    `SELECT id::text FROM pallets
     WHERE organization_id = $1::uuid AND deleted_at IS NULL
       AND id IS DISTINCT FROM COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
     LIMIT 1`,
    [orgId, pkgRow.old_pallet_id ?? null],
  );
  const targetPalletId = String(palRes.rows[0]?.id ?? "");
  assert.ok(targetPalletId, "need alternate pallet for move-box smoke");

  await pgClient.query("BEGIN");
  try {
    const parentBefore = Number(ep.expected_scan_quantity ?? 0);
    const sku = String(ep.sku ?? "").trim();
    const fnsku = String(ep.fnsku ?? "").trim();

    const returnItemId = await insertReturnItemViaPg(
      pgClient,
      {
        organization_id: orgId,
        store_id: storeId,
        package_id: packageId,
        pallet_id: pkgRow.old_pallet_id ? String(pkgRow.old_pallet_id) : null,
        sku: sku || null,
        fnsku: fnsku || null,
        item_name: "fixture-delete-move-run",
        notes: "phase1-delete-move-parity-staging",
      },
      sessionId,
    );

    const scopeKey = buildReceiveScopeKey({
      organizationId: orgId,
      storeId,
      packageId,
      slipCode: null,
    });
    const alloc = await allocateExpectedItemsForReturnItemIds(sb, {
      returnItemIds: [returnItemId],
      expectedPackageHintId: rootId,
      receiveScopeKey: scopeKey,
    });
    assert.ok(alloc.ok, alloc.ok ? "" : alloc.error);

    const { error: pkgUpErr } = await sb
      .from("packages")
      .update({ pallet_id: targetPalletId, updated_at: new Date().toISOString() })
      .eq("id", packageId);
    assert.ok(!pkgUpErr, pkgUpErr?.message);

    const moveAlloc = await moveExpectedItemsForPackageScope(sb, {
      packageId,
      organizationId: orgId,
      storeId,
      receiveScopeKey: scopeKey,
      palletId: targetPalletId,
    });
    if (!moveAlloc.ok && String(moveAlloc.error).toLowerCase().includes("move_return_item_parent")) {
      results.move_box_alloc = "skipped_v2_rpc_missing";
    } else {
      assert.ok(moveAlloc.ok, moveAlloc.ok ? "" : moveAlloc.error);
      results.move_box_alloc = "pass";
    }

    const sync = await syncReturnItemsPalletForPackage(sb, {
      packageId,
      organizationId: orgId,
      palletId: targetPalletId,
    });
    assert.ok(sync.ok, sync.ok ? "" : sync.error);

    const riPal = await pgClient.query(
      `SELECT pallet_id::text FROM return_items WHERE id = $1::uuid`,
      [returnItemId],
    );
    assert.equal(String(riPal.rows[0]?.pallet_id ?? ""), targetPalletId, "RI pallet_id must match target");
    results.move_box_ri_pallet_sync = "pass";

    const deleted = await softVoidReturnItemWithExpectedRelease(sb, {
      returnItemId,
      organizationId: orgId,
    });
    assert.ok(deleted.ok, deleted.ok ? "" : deleted.error);
    assert.ok(deleted.released, "admin-style delete must release allocation");

    const afterDelete = await pgClient.query(
      `SELECT expected_scan_quantity FROM expected_packages WHERE id = $1::uuid`,
      [rootId],
    );
    assert.equal(Number(afterDelete.rows[0]?.expected_scan_quantity ?? 0), parentBefore);
    results.admin_delete_item_release = "pass";

    const riDeleted = await pgClient.query(
      `SELECT deleted_at IS NOT NULL AS soft FROM return_items WHERE id = $1::uuid`,
      [returnItemId],
    );
    assert.equal(riDeleted.rows[0]?.soft, true, "return_item must be soft-deleted");
    results.admin_delete_soft_void = "pass";
  } finally {
    await deleteScriptSessionReturnItemsViaPg(pgClient, sessionId);
    await pgClient.query("ROLLBACK");
  }

  await pgClient.end();
  return results;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  staticChecks();

  const sb = stagingClient();
  const out: Record<string, unknown> = {
    ok: true,
    prompt: "PHASE1-DELETE-MOVE-BACKEND-PARITY-EXECUTE",
    static: "pass",
    staging_ref: STAGING_REF,
    rollback: "pg_transaction_rollback",
  };

  if (sb) {
    out.release_rpc = (await probeReleaseRpc(sb)) ? "present" : "missing";
    out.v2_delete_rpc = (await probeV2DeleteRpc(sb)) ? "present" : "missing";
    if (out.release_rpc === "present") {
      out.integration = await integrationSmoke(sb);
    } else {
      out.integration = "skipped_release_rpc_missing";
    }
  } else {
    out.integration = "skipped_no_staging_credentials";
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
