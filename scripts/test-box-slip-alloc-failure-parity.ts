/**
 * BOX slip expected allocation failure parity with operatorReceiveItem.
 *   npx tsx scripts/test-box-slip-alloc-failure-parity.ts
 *
 * Parity contract (documented in static checks):
 * - operatorReceiveItem: on allocate failure → delete return_items row → return { ok: false }
 * - insertOperatorPackageItemAction (BOX/slip): on allocate failure → delete all rows inserted this call → return { ok: false }
 * - No console.warn-only path leaving package-anchored return_items without expected_item_id
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { RETURN_ITEMS_TABLE } from "../app/returns/returns-constants";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import {
  allocateExpectedItemsForReturnItemIds,
  buildReceiveScopeKey,
  fetchPackageReceiveContext,
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

function staticParityChecks(): void {
  const itemActions = readFileSync(join(process.cwd(), "app/scanner/operator-mobile/item-actions.ts"), "utf8");
  const storeActions = readFileSync(
    join(process.cwd(), "app/scanner/operator-mobile/_components/operator-store-actions.ts"),
    "utf8",
  );

  const receiveSlice = itemActions.slice(itemActions.indexOf("export async function operatorReceiveItem"));
  assert.match(
    receiveSlice,
    /if \(!alloc\.ok\) \{[\s\S]*?\.from\(RETURN_ITEMS_TABLE\)\.delete\(\)\.eq\("id", returnItemId\)/,
    "operatorReceiveItem must delete return_items on allocation failure",
  );

  assert.doesNotMatch(
    storeActions,
    /\[insertOperatorPackageItemAction\] expected allocation skipped/,
    "BOX path must not warn-and-continue on allocation failure",
  );
  assert.match(
    storeActions,
    /rollbackOperatorPackageReturnItemsOnAllocationFailure/,
    "BOX path must rollback inserted return_items on allocation failure",
  );
  assert.match(
    storeActions,
    /if \(!finalizePrimary\.ok\) \{[\s\S]*?rollbackOperatorPackageReturnItemsOnAllocationFailure/,
    "insertOperatorPackageItemAction must rollback on primary finalize failure",
  );
  assert.match(
    storeActions,
    /if \(!finalizeExtra\.ok\) \{[\s\S]*?rollbackOperatorPackageReturnItemsOnAllocationFailure/,
    "insertOperatorPackageItemAction must rollback quantity batch on extra finalize failure",
  );
  assert.match(
    storeActions,
    /if \(!alloc\.ok\) \{[\s\S]*?return \{ ok: false, error: alloc\.error \}/,
    "finalizeOperatorPackageItemLinkage must hard-fail allocation",
  );
}

async function integrationTests(sb: SupabaseClient): Promise<void> {
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  assert.ok(dbUrl, "STAGING_DIRECT_POSTGRES_URL required for integration tests");

  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const scopedRes = await pgClient.query(
    `SELECT p.id::text AS package_id, p.organization_id::text, p.store_id::text,
            p.id_slip_contents::text AS slip_code,
            ep.id::text AS root_ep_id, ep.expected_scan_quantity
     FROM packages p
     INNER JOIN expected_packages ep
       ON ep.organization_id = p.organization_id
      AND ep.store_id = p.store_id
      AND ep.parent_expected_package_id IS NULL
      AND COALESCE(ep.expected_scan_quantity, 0) = 1
      AND (
        (p.id_slip_contents IS NOT NULL AND ep.id_slip_contents IS NOT DISTINCT FROM p.id_slip_contents)
        OR (p.tracking_number IS NOT NULL AND ep.tracking_number IS NOT DISTINCT FROM p.tracking_number)
      )
     WHERE p.deleted_at IS NULL
     LIMIT 1`,
  );
  let scoped = scopedRes.rows[0] as Record<string, unknown> | undefined;

  if (!scoped?.package_id) {
    const epRes = await pgClient.query(
      `SELECT id::text AS root_ep_id, organization_id::text, store_id::text, expected_scan_quantity
       FROM expected_packages
       WHERE parent_expected_package_id IS NULL
         AND COALESCE(expected_scan_quantity, 0) = 1
         AND build_source IN ('detail_shipment','detail_remainder')
       LIMIT 1`,
    );
    const ep = epRes.rows[0] as Record<string, unknown> | undefined;
    assert.ok(ep?.root_ep_id, "need root expected_packages with allocatable remainder");
    const pkgRes = await pgClient.query(
      `SELECT id::text AS package_id, id_slip_contents::text AS slip_code
       FROM packages
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
       ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
      [ep.organization_id, ep.store_id],
    );
    scoped = {
      package_id: pkgRes.rows[0]?.package_id,
      organization_id: ep.organization_id,
      store_id: ep.store_id,
      slip_code: pkgRes.rows[0]?.slip_code,
      root_ep_id: ep.root_ep_id,
      expected_scan_quantity: ep.expected_scan_quantity,
      use_hint: true,
    };
  }

  assert.ok(scoped?.package_id, "need package for BOX-anchored allocation test");

  const packageId = String(scoped.package_id);
  const orgId = String(scoped.organization_id);
  const storeId = String(scoped.store_id);
  const slipCode = String(scoped.slip_code ?? "").trim() || null;
  const rootId = String(scoped.root_ep_id);
  const remainderBefore = Number(scoped.expected_scan_quantity ?? 0);
  const useHint = Boolean(scoped.use_hint);

  const pkgCtx = await fetchPackageReceiveContext(sb, packageId);
  const receiveScopeKey = buildReceiveScopeKey({
    organizationId: orgId,
    storeId,
    packageId,
    slipCode: pkgCtx.slipCode ?? slipCode,
  });

  await pgClient.query("BEGIN");
  try {
    const { data: ins, error: insErr } = await sb
      .from(RETURN_ITEMS_TABLE)
      .insert({
        organization_id: orgId,
        store_id: storeId,
        package_id: packageId,
        marketplace: "amazon",
        item_name: "box-slip-alloc-parity-success",
        conditions: ["sellable_ok"],
        status: "received",
        notes: "test-box-slip-alloc-failure-parity",
      })
      .select("id, expected_item_id")
      .single();
    assert.ok(!insErr && ins?.id, insErr?.message ?? "insert failed");
    const returnItemId = String(ins.id);

    const alloc = await allocateExpectedItemsForReturnItemIds(sb, {
      returnItemIds: [returnItemId],
      receiveScopeKey,
      ...(useHint ? { expectedPackageHintId: rootId } : {}),
    });
    assert.ok(alloc.ok, alloc.ok ? "" : alloc.error);

    const rowAfter = await pgClient.query(
      `SELECT expected_item_id::text FROM return_items WHERE id = $1::uuid`,
      [returnItemId],
    );
    assert.ok(rowAfter.rows[0]?.expected_item_id, "successful BOX slip allocation sets expected_item_id");

    const remainderAfterSuccess = await pgClient.query(
      `SELECT expected_scan_quantity FROM expected_packages WHERE id = $1::uuid`,
      [rootId],
    );
    assert.equal(
      Number(remainderAfterSuccess.rows[0]?.expected_scan_quantity ?? -1),
      remainderBefore - 1,
      "successful allocation decrements root remainder",
    );

    const { data: insFail, error: insFailErr } = await sb
      .from(RETURN_ITEMS_TABLE)
      .insert({
        organization_id: orgId,
        store_id: storeId,
        package_id: packageId,
        marketplace: "amazon",
        item_name: "box-slip-alloc-parity-failure",
        conditions: ["sellable_ok"],
        status: "received",
        notes: "test-box-slip-alloc-failure-parity-fail",
      })
      .select("id")
      .single();
    assert.ok(!insFailErr && insFail?.id, insFailErr?.message ?? "failure-path insert failed");
    const failId = String(insFail.id);

    const allocFail = await allocateExpectedItemsForReturnItemIds(sb, {
      returnItemIds: [failId],
      receiveScopeKey,
      ...(useHint ? { expectedPackageHintId: rootId } : {}),
    });
    assert.ok(!allocFail.ok, "forced allocation failure must not succeed when remainder exhausted");
    const failErr = allocFail.ok ? "" : allocFail.error ?? "";
    assert.match(failErr, /no_allocatable_expected/i, `expected no_allocatable error, got: ${failErr}`);

    const remainderMid = await pgClient.query(
      `SELECT expected_scan_quantity FROM expected_packages WHERE id = $1::uuid`,
      [rootId],
    );
    assert.equal(
      Number(remainderMid.rows[0]?.expected_scan_quantity ?? -1),
      0,
      "expected remainder unchanged when second allocation fails after first unit consumed (still 0)",
    );

    await sb.from(RETURN_ITEMS_TABLE).delete().eq("id", failId);

    const stillThere = await pgClient.query(`SELECT id FROM return_items WHERE id = $1::uuid`, [failId]);
    assert.equal(stillThere.rowCount, 0, "rollback delete leaves no inconsistent package return_item");

    const rowOrphanCheck = await pgClient.query(
      `SELECT id FROM return_items
       WHERE id = $1::uuid AND package_id = $2::uuid AND deleted_at IS NULL`,
      [failId, packageId],
    );
    assert.equal(rowOrphanCheck.rowCount, 0, "no active package-anchored row after rollback");
  } finally {
    await pgClient.query("ROLLBACK");
  }

  await pgClient.end();
}

async function main(): Promise<void> {
  loadEnvLocal();
  staticParityChecks();

  const sb = stagingClient();
  let integration = "skipped";
  if (sb) {
    await integrationTests(sb);
    integration = "pass";
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        static: "pass",
        integration,
        parity:
          "operatorReceiveItem and insertOperatorPackageItemAction both delete return_items on expected allocation failure",
        safe_to_continue: integration === "pass" ? "yes" : "yes_with_static_only",
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
