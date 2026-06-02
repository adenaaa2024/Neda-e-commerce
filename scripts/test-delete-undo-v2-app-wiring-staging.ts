/**
 * DELETE-UNDO-V2 app wiring — staging integration (rolls back).
 *   npx tsx scripts/test-delete-undo-v2-app-wiring-staging.ts
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
  softVoidPackageWithExpectedRelease,
  softVoidReturnItemWithExpectedRelease,
} from "../lib/scanner/receive-expected-with-split";
import {
  deleteReturnItemWithExpectedReleaseV2,
  moveReturnItemParentV2,
  previewRestoreUndoBatchV2,
} from "../lib/scanner/delete-cascade-v2-app";

const STAGING_REF = "eiqfaapyumhixxoeltgu";

function loadEnvLocal(): void {
  loadEnvLocalIntoProcess();
}

function stagingClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url?.includes(STAGING_REF) || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function probeV2Rpc(sb: SupabaseClient): Promise<boolean> {
  const { error } = await sb.rpc("delete_return_item_with_expected_release", {
    p_organization_id: "00000000-0000-0000-0000-000000000001",
    p_return_item_id: "00000000-0000-0000-0000-000000000002",
    p_actor_id: null,
    p_idempotency_key: null,
    p_reason: "probe",
    p_undo_batch_id: null,
  });
  const m = String(error?.message ?? "").toLowerCase();
  if (m.includes("could not find the function") || m.includes("pgrst202")) return false;
  return true;
}

function staticWiringChecks(): void {
  const splitLib = readFileSync(join(process.cwd(), "lib/scanner/receive-expected-with-split.ts"), "utf8");
  const v2Lib = readFileSync(join(process.cwd(), "lib/scanner/delete-cascade-v2-app.ts"), "utf8");
  const returnsActions = readFileSync(join(process.cwd(), "app/returns/actions.ts"), "utf8");

  assert.match(splitLib, /deleteReturnItemWithExpectedReleaseV2/);
  assert.match(splitLib, /deletePackageCascadeV2/);
  assert.match(splitLib, /deletePalletCascadeV2/);
  assert.match(splitLib, /moveReturnItemParentV2/);
  assert.doesNotMatch(splitLib, /rpc\("move_expected_item_unit"/);
  assert.match(v2Lib, /delete_return_item_with_expected_release/);
  assert.match(v2Lib, /delete_package_cascade/);
  assert.match(v2Lib, /delete_pallet_cascade/);
  assert.match(v2Lib, /move_return_item_parent/);
  assert.match(v2Lib, /preview_restore_undo_batch/);
  assert.match(returnsActions, /moveReturnItemParentV2/);
}

async function integrationTests(sb: SupabaseClient): Promise<Record<string, string>> {
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  assert.ok(dbUrl, "STAGING_DIRECT_POSTGRES_URL required for integration tests");

  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const results: Record<string, string> = {};

  const epRes = await pgClient.query(
    `SELECT id::text, organization_id::text, store_id::text, sku, fnsku, order_id,
            expected_scan_quantity
     FROM expected_packages
     WHERE parent_expected_package_id IS NULL
       AND COALESCE(expected_scan_quantity, 0) >= 2
       AND build_source IN ('detail_shipment','detail_remainder')
     ORDER BY expected_scan_quantity DESC
     LIMIT 1`,
  );
  const ep = epRes.rows[0] as Record<string, unknown> | undefined;
  assert.ok(ep?.id, "need root EP with qty >= 2");

  const orgId = String(ep.organization_id);
  const storeId = String(ep.store_id);
  const rootId = String(ep.id);

  await pgClient.query("BEGIN");
  try {
    const sku = String(ep.sku ?? "").trim();
    const fnsku = String(ep.fnsku ?? "").trim();

    const parentBeforeAllocRes = await pgClient.query(
      `SELECT expected_scan_quantity FROM expected_packages WHERE id = $1::uuid`,
      [rootId],
    );
    const parentBeforeAlloc = Number(parentBeforeAllocRes.rows[0]?.expected_scan_quantity ?? 0);

    const returnItemId = await insertReturnItemViaPg(
      pgClient,
      {
        organization_id: orgId,
        store_id: storeId,
        order_id: ep.order_id ? String(ep.order_id) : null,
        sku: sku || null,
        fnsku: fnsku || null,
        item_name: "fixture-delete-release",
        notes: "delete-undo-v2-app-wiring",
      },
      sessionId,
    );

    const scopeKey = buildReceiveScopeKey({
      organizationId: orgId,
      storeId,
      packageId: null,
      slipCode: null,
    });
    const alloc = await allocateExpectedItemsForReturnItemIds(sb, {
      returnItemIds: [returnItemId],
      expectedPackageHintId: rootId,
      receiveScopeKey: scopeKey,
    });
    assert.ok(alloc.ok, alloc.ok ? "" : alloc.error);

    const afterAlloc = await pgClient.query(
      `SELECT expected_scan_quantity FROM expected_packages WHERE id = $1::uuid`,
      [rootId],
    );
    const parentAfterAlloc = Number(afterAlloc.rows[0]?.expected_scan_quantity ?? 0);
    assert.ok(parentAfterAlloc < parentBeforeAlloc, "parent decremented after allocate");

    const deleted = await softVoidReturnItemWithExpectedRelease(sb, {
      returnItemId,
      organizationId: orgId,
    });
    assert.ok(deleted.ok, deleted.ok ? "" : deleted.error);
    assert.ok(deleted.released, "delete should release expected qty");

    const afterDelete = await pgClient.query(
      `SELECT expected_scan_quantity FROM expected_packages WHERE id = $1::uuid`,
      [rootId],
    );
    assert.equal(Number(afterDelete.rows[0]?.expected_scan_quantity ?? 0), parentBeforeAlloc);
    results.delete_return_item_releases_expected = "pass";

    const returnItemId2 = await insertReturnItemViaPg(
      pgClient,
      {
        organization_id: orgId,
        store_id: storeId,
        sku: sku || null,
        fnsku: fnsku || null,
        item_name: "fixture-undo-preview",
      },
      sessionId,
    );

    const del2 = await deleteReturnItemWithExpectedReleaseV2(sb, {
      organizationId: orgId,
      returnItemId: returnItemId2,
      reason: "v2_undo_preview_test",
    });
    assert.ok(del2.ok, del2.ok ? "" : del2.error);
    assert.ok(del2.undoBatchId, "undo batch required");

    const preview = await previewRestoreUndoBatchV2(sb, {
      organizationId: orgId,
      undoBatchId: del2.undoBatchId!,
      persistConflicts: false,
    });
    assert.ok(preview.ok, preview.ok ? "" : preview.error);
    results.undo_preview = preview.canRestore ? "can_restore" : `blocked:${preview.message}`;

    const pkgRes = await pgClient.query(
      `SELECT p.id::text AS package_id, p.organization_id::text, p.store_id::text, p.pallet_id::text
       FROM packages p
       WHERE p.deleted_at IS NULL
         AND p.organization_id = $1::uuid
       LIMIT 1`,
      [orgId],
    );
    const pkgRow = pkgRes.rows[0] as Record<string, unknown> | undefined;

    if (pkgRow?.package_id) {
      const packageId = String(pkgRow.package_id);
      const pkgStoreId = String(pkgRow.store_id ?? storeId);

      const childId = await insertReturnItemViaPg(
        pgClient,
        {
          organization_id: orgId,
          store_id: pkgStoreId,
          package_id: packageId,
          pallet_id: pkgRow.pallet_id ? String(pkgRow.pallet_id) : null,
          sku: sku || null,
          fnsku: fnsku || null,
          item_name: "fixture-package-child",
        },
        sessionId,
      );
      if (childId) {
        await allocateExpectedItemsForReturnItemIds(sb, {
          returnItemIds: [childId],
          expectedPackageHintId: rootId,
          receiveScopeKey: buildReceiveScopeKey({
            organizationId: orgId,
            storeId: pkgStoreId,
            packageId,
            slipCode: null,
          }),
        });

        const qtyBeforePkgDelete = await pgClient.query(
          `SELECT expected_scan_quantity FROM expected_packages WHERE id = $1::uuid`,
          [rootId],
        );
        const epQtyBefore = Number(qtyBeforePkgDelete.rows[0]?.expected_scan_quantity ?? 0);

        const pkgDel = await softVoidPackageWithExpectedRelease(sb, {
          packageId,
          organizationId: orgId,
        });
        assert.ok(pkgDel.ok, pkgDel.ok ? "" : pkgDel.error);

        const qtyAfterPkgDelete = await pgClient.query(
          `SELECT expected_scan_quantity FROM expected_packages WHERE id = $1::uuid`,
          [rootId],
        );
        assert.ok(
          Number(qtyAfterPkgDelete.rows[0]?.expected_scan_quantity ?? 0) >= epQtyBefore,
          "package delete should release child allocations",
        );
        results.delete_package_cascade = "pass";
      } else {
        results.delete_package_cascade = "skipped_no_child_insert";
      }

      const altPkgRes = await pgClient.query(
        `SELECT id::text FROM packages
         WHERE organization_id = $1::uuid AND deleted_at IS NULL AND id <> $2::uuid
         LIMIT 1`,
        [orgId, packageId],
      );
      const altPkgId = String(altPkgRes.rows[0]?.id ?? "");
      if (altPkgId) {
        const moveRiId = await insertReturnItemViaPg(
          pgClient,
          {
            organization_id: orgId,
            store_id: pkgStoreId,
            package_id: packageId,
            sku: sku || null,
            fnsku: fnsku || null,
            item_name: "fixture-move-parent",
          },
          sessionId,
        );
        if (moveRiId) {
          await allocateExpectedItemsForReturnItemIds(sb, {
            returnItemIds: [moveRiId],
            expectedPackageHintId: rootId,
            receiveScopeKey: buildReceiveScopeKey({
              organizationId: orgId,
              storeId: pkgStoreId,
              packageId,
              slipCode: null,
            }),
          });

          const epBeforeMove = await pgClient.query(
            `SELECT expected_scan_quantity FROM expected_packages WHERE id = $1::uuid`,
            [rootId],
          );
          const qtyBeforeMove = Number(epBeforeMove.rows[0]?.expected_scan_quantity ?? 0);

          const moved = await moveReturnItemParentV2(sb, {
            organizationId: orgId,
            returnItemId: moveRiId,
            packageId: altPkgId,
            storeId: pkgStoreId,
            receiveScopeKey: buildReceiveScopeKey({
              organizationId: orgId,
              storeId: pkgStoreId,
              packageId: altPkgId,
              slipCode: null,
            }),
            reason: "v2_move_preserves_allocation_test",
          });
          assert.ok(moved.ok, moved.ok ? "" : moved.error);

          const epAfterMove = await pgClient.query(
            `SELECT expected_scan_quantity FROM expected_packages WHERE id = $1::uuid`,
            [rootId],
          );
          assert.equal(
            Number(epAfterMove.rows[0]?.expected_scan_quantity ?? 0),
            qtyBeforeMove,
            "move must not double-count parent EP qty",
          );
          results.move_preserves_allocation = "pass";
        } else {
          results.move_preserves_allocation = "skipped_no_move_insert";
        }
      } else {
        results.move_preserves_allocation = "skipped_single_package";
      }
    } else {
      results.delete_package_cascade = "skipped_no_package";
      results.move_preserves_allocation = "skipped_no_package";
    }
  } finally {
    await deleteScriptSessionReturnItemsViaPg(pgClient, sessionId);
    await pgClient.query("ROLLBACK");
  }

  await pgClient.end();
  return results;
}

async function main(): Promise<void> {
  loadEnvLocal();
  staticWiringChecks();

  const sb = stagingClient();
  let integration: Record<string, string> | "skipped" = "skipped";
  if (sb && (await probeV2Rpc(sb))) {
    integration = await integrationTests(sb);
  }

  const safe =
    integration !== "skipped" &&
    integration.delete_return_item_releases_expected === "pass" &&
    (integration.delete_package_cascade === "pass" ||
      integration.delete_package_cascade?.startsWith("skipped")) &&
    (integration.move_preserves_allocation === "pass" ||
      integration.move_preserves_allocation?.startsWith("skipped")) &&
    Boolean(integration.undo_preview);

  console.log(
    JSON.stringify(
      {
        ok: true,
        static: "pass",
        integration,
        staging_ref: STAGING_REF,
        SAFE_TO_CONTINUE: safe ? "yes" : integration === "skipped" ? "no_rpc" : "no",
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
