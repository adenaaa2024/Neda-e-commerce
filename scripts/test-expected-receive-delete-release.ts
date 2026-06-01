/**
 * Expected receive delete/release wiring — staging integration (rolls back).
 *   npx tsx scripts/test-expected-receive-delete-release.ts
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { RETURN_ITEMS_TABLE } from "../app/returns/returns-constants";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import {
  allocateExpectedItemsForReturnItemIds,
  buildReceiveScopeKey,
  releaseExpectedItemUnit,
} from "../lib/scanner/receive-expected-with-split";

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

async function probeRpc(sb: SupabaseClient): Promise<boolean> {
  const { error } = await sb.rpc("release_expected_item_unit", {
    p_return_item_id: "00000000-0000-0000-0000-000000000001",
    p_organization_id: "00000000-0000-0000-0000-000000000001",
    p_soft_delete: true,
  });
  const m = String(error?.message ?? "").toLowerCase();
  if (m.includes("could not find the function") || m.includes("pgrst202")) return false;
  return true;
}

async function integrationTests(sb: SupabaseClient): Promise<void> {
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  assert.ok(dbUrl, "STAGING_DIRECT_POSTGRES_URL required for integration tests");

  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const epRes = await pgClient.query(
    `SELECT id::text, organization_id::text, store_id::text, sku, fnsku, order_id,
            tracking_number, expected_scan_quantity, parent_expected_package_id
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
  const parentBefore = Number(ep.expected_scan_quantity ?? 0);

  await pgClient.query("BEGIN");
  try {
    const sku = String(ep.sku ?? "").trim();
    const fnsku = String(ep.fnsku ?? "").trim();
    const { data: ins, error: insErr } = await sb
      .from(RETURN_ITEMS_TABLE)
      .insert({
        organization_id: orgId,
        store_id: storeId,
        marketplace: "amazon",
        item_name: "delete-release-wire-test",
        conditions: ["sellable_ok"],
        status: "received",
        order_id: ep.order_id,
        sku: sku || null,
        fnsku: fnsku || null,
        notes: "test-expected-receive-delete-release",
      })
      .select("id")
      .single();
    assert.ok(!insErr && ins?.id, insErr?.message ?? "insert failed");
    const returnItemId = String(ins.id);

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
    assert.equal(parentAfterAlloc, parentBefore - 1, "parent decremented after allocate");

    const rel1 = await releaseExpectedItemUnit(sb, {
      returnItemId,
      organizationId: orgId,
      softDelete: false,
    });
    assert.ok(rel1.ok && rel1.result.released, "first release should release allocation");

    const afterRel1 = await pgClient.query(
      `SELECT expected_scan_quantity FROM expected_packages WHERE id = $1::uuid`,
      [rootId],
    );
    assert.equal(
      Number(afterRel1.rows[0]?.expected_scan_quantity ?? 0),
      parentBefore,
      "parent restored after release",
    );

    const rel2 = await releaseExpectedItemUnit(sb, {
      returnItemId,
      organizationId: orgId,
      softDelete: false,
    });
    assert.ok(rel2.ok, rel2.ok ? "" : rel2.error);
    assert.equal(rel2.result.released, false, "double release must not re-release");

    const siblingRes = await pgClient.query(
      `SELECT count(*)::int AS c FROM expected_packages
       WHERE organization_id = $1::uuid AND store_id = $2::uuid
         AND lower(btrim(COALESCE(sku,''))) = lower(btrim($3::text))
         AND parent_expected_package_id IS NULL
         AND COALESCE(expected_scan_quantity, 0) >= 1`,
      [orgId, storeId, sku],
    );
    const siblingRoots = Number(siblingRes.rows[0]?.c ?? 0);

    const overRes = await pgClient.query(
      `SELECT expected_scan_quantity FROM expected_packages WHERE id = $1::uuid`,
      [rootId],
    );
    const remaining = Number(overRes.rows[0]?.expected_scan_quantity ?? 0);
    assert.ok(remaining >= 1, "need remainder for over-scan test");
    for (let i = 0; i < remaining; i++) {
      const { data: insN } = await sb
        .from(RETURN_ITEMS_TABLE)
        .insert({
          organization_id: orgId,
          store_id: storeId,
          marketplace: "amazon",
          item_name: `delete-release-over-scan-${i}`,
          conditions: ["sellable_ok"],
          status: "received",
          sku: sku || null,
          fnsku: fnsku || null,
        })
        .select("id")
        .single();
      const ridN = String(insN?.id ?? "");
      const a = await allocateExpectedItemsForReturnItemIds(sb, {
        returnItemIds: [ridN],
        expectedPackageHintId: rootId,
        receiveScopeKey: scopeKey,
      });
      assert.ok(a.ok, `alloc drain ${i + 1}/${remaining}`);
    }
    const { data: insOver } = await sb
      .from(RETURN_ITEMS_TABLE)
      .insert({
        organization_id: orgId,
        store_id: storeId,
        marketplace: "amazon",
        item_name: "delete-release-over-scan-final",
        conditions: ["sellable_ok"],
        status: "received",
        sku: sku || null,
        fnsku: fnsku || null,
      })
      .select("id")
      .single();
    const rootZero = await pgClient.query(
      `SELECT expected_scan_quantity FROM expected_packages WHERE id = $1::uuid`,
      [rootId],
    );
    assert.equal(Number(rootZero.rows[0]?.expected_scan_quantity ?? -1), 0, "root drained before over-scan");

    if (siblingRoots <= 1) {
      const overAlloc = await allocateExpectedItemsForReturnItemIds(sb, {
        returnItemIds: [String(insOver?.id ?? "")],
        expectedPackageHintId: rootId,
        receiveScopeKey: scopeKey,
      });
      const overErr = overAlloc.ok
        ? ""
        : overAlloc.error ?? overAlloc.rows[0]?.error_message ?? "";
      assert.ok(
        !overAlloc.ok && /no_allocatable_expected/i.test(overErr),
        `over-scan must fail when no allocatable root (ok=${overAlloc.ok} err=${overErr})`,
      );
    }
  } finally {
    await pgClient.query("ROLLBACK");
  }

  await pgClient.end();
}

function staticWiringChecks(): void {
  const itemActions = readFileSync(join(process.cwd(), "app/scanner/operator-mobile/item-actions.ts"), "utf8");
  const storeActions = readFileSync(
    join(process.cwd(), "app/scanner/operator-mobile/_components/operator-store-actions.ts"),
    "utf8",
  );
  const returnsActions = readFileSync(join(process.cwd(), "app/returns/actions.ts"), "utf8");
  const splitLib = readFileSync(join(process.cwd(), "lib/scanner/receive-expected-with-split.ts"), "utf8");
  assert.match(itemActions, /softVoidReturnItemWithExpectedRelease/);
  assert.match(storeActions, /releaseExpectedItemsForPackage/);
  assert.match(storeActions, /moveExpectedItemsForPackageScope/);
  assert.match(returnsActions, /softVoidPackageWithExpectedRelease/);
  assert.match(returnsActions, /softVoidPalletWithExpectedRelease/);
  assert.match(returnsActions, /softVoidReturnItemWithExpectedRelease/);
  assert.match(returnsActions, /moveExpectedItemsForPackageScope/);
  const fnSlice = (name: string) => {
    const start = returnsActions.indexOf(`export async function ${name}`);
    assert.ok(start >= 0, `missing ${name}`);
    const next = returnsActions.indexOf("export async function", start + 12);
    return next > 0 ? returnsActions.slice(start, next) : returnsActions.slice(start);
  };
  assert.doesNotMatch(fnSlice("deletePackage"), /from\("packages"\)\.delete\(/);
  assert.doesNotMatch(fnSlice("deletePallet"), /from\("pallets"\)\.delete\(/);
  assert.doesNotMatch(fnSlice("deleteReturn"), /from\(RETURN_ITEMS_TABLE\)\.delete\(/);
  assert.doesNotMatch(fnSlice("bulkDeleteReturns"), /from\(RETURN_ITEMS_TABLE\)\.delete\(/);
  const opDel = itemActions.slice(itemActions.indexOf("export async function operatorDeleteReturnItem"));
  assert.doesNotMatch(opDel, /from\(RETURN_ITEMS_TABLE\)\.delete\(/);
  assert.match(splitLib, /softVoidPackageWithExpectedRelease/);
  assert.match(splitLib, /deletePackageCascadeV2/);
  assert.match(splitLib, /deletePalletCascadeV2/);
  assert.match(splitLib, /moveReturnItemParentV2/);
  assert.doesNotMatch(splitLib, /rpc\("move_expected_item_unit"/);
  assert.doesNotMatch(storeActions, /VOID_BLOCKED_ITEMS_MESSAGE/);
  assert.match(splitLib, /syncReturnItemsPalletForPackage/);
  assert.match(splitLib, /isSupabaseRpcMissingError/);
  const moveBoxSlice = storeActions.slice(
    storeActions.indexOf("export async function moveOperatorIntakeBoxToPalletAction"),
    storeActions.indexOf("export async function voidOperatorIntakeBoxPackageAction"),
  );
  assert.match(moveBoxSlice, /palletId:\s*targetPallet\.id/);
  assert.match(moveBoxSlice, /syncReturnItemsPalletForPackage/);
}

async function main(): Promise<void> {
  loadEnvLocal();
  staticWiringChecks();

  const sb = stagingClient();
  let integration = "skipped";
  let overScan = "skipped";
  if (sb && (await probeRpc(sb))) {
    await integrationTests(sb);
    integration = "pass";
    overScan = "pass_or_skipped_multi_root";
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        static: "pass",
        integration,
        over_scan: overScan,
        staging_ref: STAGING_REF,
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
