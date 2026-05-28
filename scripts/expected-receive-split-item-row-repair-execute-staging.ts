/**
 * EXPECTED-RECEIVE-SPLIT-ITEM-ROW-REPAIR — staging execute
 *
 *   npx tsx scripts/expected-receive-split-item-row-repair-execute-staging.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const APPROVAL_PATH = ".cursor/operator-approvals/item-level-receive-split-fix-approval.md";
const MIGRATION_SPLIT = "supabase/migrations/20260829120000_expected_receive_split.sql";
const MIGRATION_ITEM_LEVEL = "supabase/migrations/20260830120000_expected_receive_split_item_level.sql";
const OUT_BASE = ".cursor/audit-reports/expected-receive-split-item-row-repair-execute";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApproval(): { valid: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runVal = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const fixVal = /APPROVED_ITEM_LEVEL_RECEIVE_SPLIT_FIX\s*=\s*true/i.test(text);
  return {
    valid: runVal && fixVal,
    raw: {
      APPROVED_TO_RUN_STAGING: runVal ? "true" : "false",
      APPROVED_ITEM_LEVEL_RECEIVE_SPLIT_FIX: fixVal ? "true" : "false",
    },
  };
}

async function columnExists(client: pg.Client, table: string, col: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     ) AS ok`,
    [table, col],
  );
  return Boolean((r.rows[0] as { ok: boolean }).ok);
}

async function familySnapshot(client: pg.Client, rootId: string) {
  const ep = await client.query(
    `
    SELECT id::text, build_source, expected_scan_quantity, actual_scanned_count,
      parent_expected_package_id::text, id_slip_contents
    FROM public.expected_packages
    WHERE id = $1::uuid OR parent_expected_package_id = $1::uuid
    ORDER BY build_source, id
    `,
    [rootId],
  );
  return ep.rows;
}

async function returnItemsForRoot(
  client: pg.Client,
  rootId: string,
  slip: string,
): Promise<Array<{ id: string; expected_item_id: string | null }>> {
  const r = await client.query(
    `
    SELECT ri.id::text, ri.expected_item_id::text
    FROM public.return_items ri
    WHERE ri.organization_id = $1::uuid
      AND ri.expected_item_id IN (
        SELECT ep.id FROM public.expected_packages ep
        WHERE ep.parent_expected_package_id = $2::uuid
           OR ep.id = $2::uuid
      )
      OR (ri.id IN (
        SELECT ri2.id FROM public.return_items ri2
        JOIN public.expected_packages ep ON ep.id = ri2.expected_item_id
        WHERE ep.id_slip_contents = $3
      ))
    `,
    [ORG_ID, rootId, slip],
  );
  return r.rows as Array<{ id: string; expected_item_id: string | null }>;
}

async function insertSmokeReturnItem(client: pg.Client): Promise<string> {
  const r = await client.query(
    `
    INSERT INTO public.return_items (
      organization_id, store_id, marketplace, item_name, conditions, status, sku, fnsku
    ) VALUES (
      $1::uuid, $2::uuid, 'amazon', 'item-row-repair-smoke', ARRAY['sellable']::text[], 'received',
      'SMOKE-SKU', 'SMOKEFNSKU'
    )
    RETURNING id::text
    `,
    [ORG_ID, STORE_ID],
  );
  return (r.rows[0] as { id: string }).id;
}

async function testQtyOnlyBlocked(client: pg.Client, rootId: string): Promise<boolean> {
  const r = await client.query(
    `SELECT * FROM public.receive_expected_item_with_split($1::uuid,$2::uuid,$3::uuid,3,'box','x',NULL,NULL,NULL::uuid,NULL::uuid[],false)`,
    [ORG_ID, STORE_ID, rootId],
  );
  const row = r.rows[0] as { ok: boolean; message: string };
  return row.ok === false && row.message.includes("return_item_ids required");
}

async function testA(client: pg.Client, rootId: string, slip: string) {
  const before = await familySnapshot(client, rootId);
  const rootBefore = before.find((x) => (x as { id: string }).id === rootId) as {
    expected_scan_quantity: number;
  };
  const startQty = Number(rootBefore?.expected_scan_quantity ?? 0);

  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push(await insertSmokeReturnItem(client));
  }

  const alloc = await client.query(
    `SELECT * FROM public.allocate_expected_items_for_return_item_ids(
      $1::uuid,$2::uuid,$3::uuid,$4::uuid[],'box',$5::text,NULL::uuid,NULL::uuid,NULL::uuid)`,
    [ORG_ID, STORE_ID, rootId, ids, slip],
  );
  const allocRow = alloc.rows[0] as Record<string, unknown>;

  const ri = await client.query(
    `SELECT id::text, expected_item_id::text FROM public.return_items WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const after = await familySnapshot(client, rootId);
  const rootAfter = after.find((x) => (x as { id: string }).id === rootId);
  const child = after.find(
    (x) => (x as { build_source: string }).build_source === "receive_allocated",
  ) as { expected_scan_quantity: number } | undefined;

  const allLinked = (ri.rows as Array<{ expected_item_id: string | null }>).every(
    (r) => r.expected_item_id != null,
  );
  const sameAlloc =
    new Set(
      (ri.rows as Array<{ expected_item_id: string | null }>).map((r) => r.expected_item_id),
    ).size === 1;

  const conservation =
    Number(rootAfter?.expected_scan_quantity ?? 0) === startQty - 3 &&
    Number(child?.expected_scan_quantity ?? 0) === 3;

  return {
    pass: Boolean(allocRow.ok) && allLinked && sameAlloc && conservation,
    startQty,
    before,
    after,
    return_items: ri.rows,
    alloc: allocRow,
    child_qty: child?.expected_scan_quantity ?? null,
    root_remainder: rootAfter?.expected_scan_quantity ?? null,
    return_item_ids: ids,
  };
}

async function testB(client: pg.Client, returnItemId: string, rootId: string) {
  const before = await familySnapshot(client, rootId);
  const rel = await client.query(
    `SELECT * FROM public.release_expected_item_unit($1::uuid,$2::uuid)`,
    [ORG_ID, returnItemId],
  );
  const after = await familySnapshot(client, rootId);
  const ri = await client.query(
    `SELECT expected_item_id::text FROM public.return_items WHERE id = $1::uuid`,
    [returnItemId],
  );
  const rootBefore = before.find((x) => (x as { id: string }).id === rootId);
  const rootAfter = after.find((x) => (x as { id: string }).id === rootId);
  const childBefore = before.filter((x) => (x as { build_source: string }).build_source === "receive_allocated");
  const childAfter = after.filter((x) => (x as { build_source: string }).build_source === "receive_allocated");

  const rootUp =
    Number(rootAfter?.expected_scan_quantity ?? 0) ===
    Number(rootBefore?.expected_scan_quantity ?? 0) + 1;
  const childDown =
    childAfter.reduce((s, c) => s + Number((c as { expected_scan_quantity: number }).expected_scan_quantity ?? 0), 0) ===
    childBefore.reduce((s, c) => s + Number((c as { expected_scan_quantity: number }).expected_scan_quantity ?? 0), 0) - 1;

  return {
    pass: Boolean((rel.rows[0] as { ok: boolean }).ok) && (ri.rows[0] as { expected_item_id: null }).expected_item_id == null && rootUp && childDown,
    release: rel.rows[0],
    before,
    after,
  };
}

async function testC(
  client: pg.Client,
  returnItemId: string,
  rootId: string,
  slip1: string,
  slip2: string,
) {
  const before = await familySnapshot(client, rootId);
  const mv = await client.query(
    `SELECT * FROM public.move_expected_item_unit($1::uuid,$2::uuid,$3::uuid,'box',$4::text,NULL::uuid,NULL::uuid)`,
    [ORG_ID, STORE_ID, returnItemId, slip2],
  );
  const mvRow = mv.rows[0] as Record<string, unknown>;
  const after = await familySnapshot(client, rootId);
  const ri = await client.query(
    `SELECT expected_item_id::text FROM public.return_items WHERE id = $1::uuid`,
    [returnItemId],
  );
  const ep = await client.query(
    `SELECT id_slip_contents, expected_scan_quantity FROM public.expected_packages WHERE id = $1::uuid`,
    [(ri.rows[0] as { expected_item_id: string }).expected_item_id],
  );

  const slip2Child = after.find(
    (x) =>
      (x as { build_source: string; id_slip_contents: string }).build_source === "receive_allocated" &&
      (x as { id_slip_contents: string }).id_slip_contents === slip2,
  );

  return {
    pass:
      Boolean(mvRow.ok) &&
      (ep.rows[0] as { id_slip_contents: string }).id_slip_contents === slip2 &&
      Number(slip2Child?.expected_scan_quantity ?? 0) >= 1,
    move: mvRow,
    before,
    after,
    slip1,
    slip2,
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (!approval.valid) blockers.push(`${APPROVAL_PATH}: flags not true — STOP`);

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else {
    if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
      blockers.push(`DB must be staging ${STAGING_REF}`);
    }
    if (dbUrl.includes(ORIGINAL_REF)) blockers.push("Original ref forbidden");
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      `| File | \`${APPROVAL_PATH}\` |`,
      `| APPROVED_TO_RUN_STAGING | ${approval.raw.APPROVED_TO_RUN_STAGING} |`,
      `| APPROVED_ITEM_LEVEL_RECEIVE_SPLIT_FIX | ${approval.raw.APPROVED_ITEM_LEVEL_RECEIVE_SPLIT_FIX} |`,
      `| valid | **${approval.valid}** |`,
    ].join("\n") + "\n",
  );

  if (!apply || blockers.length) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      blockers.length
        ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
        : "- Dry-run; pass `--apply` after approval.\n",
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, ok: false, apply: false, blockers }, null, 2),
    );
    console.log(JSON.stringify({ ok: false, outDir, blockers }, null, 2));
    process.exit(blockers.length && !approval.valid ? 1 : 0);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const fnCheck = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'allocate_expected_item_unit'
     ) AS ok`,
  );
  const hasItemLevel = Boolean((fnCheck.rows[0] as { ok: boolean }).ok);
  if (!hasItemLevel && fs.existsSync(path.join(process.cwd(), MIGRATION_SPLIT))) {
    await client.query(fs.readFileSync(path.join(process.cwd(), MIGRATION_SPLIT), "utf8"));
  }
  await client.query(fs.readFileSync(path.join(process.cwd(), MIGRATION_ITEM_LEVEL), "utf8"));

  const hasExpectedItemId = await columnExists(client, "return_items", "expected_item_id");
  const qtyOnlyBlocked = await (async () => {
    const cand = await client.query(
      `SELECT id::text FROM public.expected_packages
       WHERE organization_id=$1 AND store_id=$2
         AND build_source IN ('detail_shipment','detail_remainder')
         AND COALESCE(expected_scan_quantity,0) >= 10
         AND parent_expected_package_id IS NULL
       LIMIT 1`,
      [ORG_ID, STORE_ID],
    );
    const rootId = (cand.rows[0] as { id?: string } | undefined)?.id;
    return rootId ? testQtyOnlyBlocked(client, rootId) : false;
  })();

  fs.writeFileSync(
    path.join(outDir, "migration-summary.md"),
    [
      "# Migration summary",
      "",
      `- \`${MIGRATION_SPLIT}\` (base columns + legacy function replaced)`,
      `- \`${MIGRATION_ITEM_LEVEL}\` (item-level alloc/release/move + expected_item_id)`,
      "",
      `| return_items.expected_item_id | **${hasExpectedItemId ? "present" : "MISSING"}** |`,
      `| quantity-only path blocked | **${qtyOnlyBlocked ? "yes" : "no"}** |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "code-change-summary.md"),
    [
      "# Code changes",
      "",
      "| File | Change |",
      "|------|--------|",
      "| `supabase/migrations/20260830120000_expected_receive_split_item_level.sql` | Item-level RPCs + block qty-only |",
      "| `lib/scanner/receive-expected-with-split.ts` | Types for unit/batch alloc |",
      "| `app/scanner/operator-mobile/item-actions.ts` | `allocate_expected_items_for_return_item_ids` |",
      "| `scripts/expected-receive-split-item-row-repair-execute-staging.ts` | This execute + smokes |",
    ].join("\n") + "\n",
  );

  const cand = await client.query(
    `SELECT id::text FROM public.expected_packages
     WHERE organization_id=$1 AND store_id=$2
       AND build_source IN ('detail_shipment','detail_remainder')
       AND COALESCE(expected_scan_quantity,0) >= 10
       AND parent_expected_package_id IS NULL
     ORDER BY expected_scan_quantity DESC LIMIT 1`,
    [ORG_ID, STORE_ID],
  );
  const rootId = (cand.rows[0] as { id?: string } | undefined)?.id;
  if (!rootId) blockers.push("no_smoke_root_ep");

  let testAResult: Awaited<ReturnType<typeof testA>> | null = null;
  let testBResult: Awaited<ReturnType<typeof testB>> | null = null;
  let testCResult: Awaited<ReturnType<typeof testC>> | null = null;

  if (rootId) {
    await client.query("BEGIN");
    try {
      const slipA = `ITEMROW-${randomUUID().slice(0, 8)}`;
      testAResult = await testA(client, rootId, slipA);
      if (testAResult.pass && testAResult.return_item_ids[0]) {
        testBResult = await testB(client, testAResult.return_item_ids[0]!, rootId);
      }
      if (testAResult.pass && testAResult.return_item_ids[1]) {
        const slip2 = `ITEMROW-${randomUUID().slice(0, 8)}`;
        testCResult = await testC(client, testAResult.return_item_ids[1]!, rootId, slipA, slip2);
      }
      await client.query("ROLLBACK");
    } catch (e) {
      await client.query("ROLLBACK");
      blockers.push(e instanceof Error ? e.message : "smoke_error");
    }
  }

  fs.writeFileSync(
    path.join(outDir, "item-row-smoke-before-after.json"),
    JSON.stringify({ test_a: testAResult, qty_only_blocked: qtyOnlyBlocked }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "delete-release-smoke.json"),
    JSON.stringify({ test_b: testBResult }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "move-scope-smoke.json"),
    JSON.stringify({ test_c: testCResult }, null, 2),
  );

  fs.writeFileSync(
    path.join(outDir, "view-count-proof.md"),
    [
      "# View count proof",
      "",
      "- `v_scanned_items_counted` aggregates `return_items` rows (one row = one physical scan).",
      "- `v_inventory_item_status` compares `expected_scan_quantity` vs counted return_items — **no** `quantity_entered` on return_items.",
      "- Item-level alloc sets `actual_scanned_count` on receive_allocated EP for legacy readers; canonical count is `COUNT(return_items)`.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      "DROP FUNCTION IF EXISTS public.move_expected_item_unit(uuid,uuid,uuid,text,text,uuid,uuid);",
      "DROP FUNCTION IF EXISTS public.release_expected_item_unit(uuid,uuid);",
      "DROP FUNCTION IF EXISTS public.allocate_expected_items_for_return_item_ids(uuid,uuid,uuid,uuid[],text,text,uuid,uuid,uuid);",
      "DROP FUNCTION IF EXISTS public.allocate_expected_item_unit(uuid,uuid,uuid,uuid,text,text,uuid,uuid,uuid);",
      "DROP FUNCTION IF EXISTS public._receive_split_resolve_root(uuid,uuid,uuid);",
      "DROP FUNCTION IF EXISTS public._receive_split_scope_key(text,text,uuid,uuid);",
      "DROP FUNCTION IF EXISTS public.receive_expected_item_with_split(uuid,uuid,uuid,integer,text,text,uuid,uuid,uuid,uuid[],boolean);",
      "-- restore prior 10-arg overload from 20260829120000 if needed",
    ].join("\n") + "\n",
  );

  const execBlockers = [...blockers];
  if (testAResult && !testAResult.pass) execBlockers.push("test_a_failed");
  if (testBResult && !testBResult.pass) execBlockers.push("test_b_failed");
  if (testCResult && !testCResult.pass) execBlockers.push("test_c_failed");
  if (!qtyOnlyBlocked) execBlockers.push("qty_only_not_blocked");

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    execBlockers.length ? execBlockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        run_id: runId,
        ok: execBlockers.length === 0,
        schema_expected_item_id: hasExpectedItemId,
        quantity_only_blocked: qtyOnlyBlocked,
        test_a_pass: testAResult?.pass ?? false,
        test_b_pass: testBResult?.pass ?? false,
        test_c_pass: testCResult?.pass ?? false,
        blockers: execBlockers,
        exact_next_prompt:
          execBlockers.length === 0
            ? "NEDA-SCANNER-RECEIVE-ITEM-ROW-SMOKE — browser proof operatorReceiveItem qty=3 creates 3 return_items + conservation"
            : "EXPECTED-RECEIVE-SPLIT-ITEM-ROW-REPAIR-DIAGNOSE — fix failed smoke from audit artifacts",
      },
      null,
      2,
    ),
  );

  await client.end();
  console.log(
    JSON.stringify(
      {
        ok: execBlockers.length === 0,
        outDir,
        schema_fixed: hasExpectedItemId,
        quantity_only_blocked: qtyOnlyBlocked,
        test_a: testAResult?.pass,
        test_b: testBResult?.pass,
        test_c: testCResult?.pass,
      },
      null,
      2,
    ),
  );
  if (execBlockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
