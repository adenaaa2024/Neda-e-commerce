/**
 * EXPECTED-RECEIVE-SPLIT-EXECUTE-STAGING
 *
 *   npx tsx scripts/expected-receive-split-execute-staging.ts
 *   npx tsx scripts/expected-receive-split-execute-staging.ts --apply
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
const APPROVAL_PATH =
  ".cursor/operator-approvals/expected-receive-split-contract-approval.md";
const MIGRATION_PATH = "supabase/migrations/20260829120000_expected_receive_split.sql";
const OUT_BASE = ".cursor/audit-reports/expected-receive-split-execute-staging";

type EpRow = {
  id: string;
  build_source: string | null;
  expected_scan_quantity: number | null;
  actual_scanned_count: number | null;
  id_slip_contents: string | null;
  parent_expected_package_id: string | null;
};

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
  const fixVal = /APPROVED_EXPECTED_RECEIVE_SPLIT_CONTRACT\s*=\s*true/i.test(text);
  return {
    valid: runVal && fixVal,
    raw: {
      APPROVED_TO_RUN_STAGING: runVal ? "true" : "false",
      APPROVED_EXPECTED_RECEIVE_SPLIT_CONTRACT: fixVal ? "true" : "false",
    },
  };
}

async function familyRows(client: pg.Client, rootId: string): Promise<EpRow[]> {
  const r = await client.query(
    `
    SELECT id::text, build_source, expected_scan_quantity, actual_scanned_count,
      id_slip_contents, parent_expected_package_id::text
    FROM public.expected_packages
    WHERE id = $1::uuid
       OR parent_expected_package_id = $1::uuid
    ORDER BY build_source, id
    `,
    [rootId],
  );
  return r.rows as EpRow[];
}

async function runSmoke(client: pg.Client, rootId: string): Promise<{
  pass: boolean;
  before: EpRow[];
  after_first: EpRow[];
  after_second: EpRow[];
  details: Record<string, unknown>;
}> {
  const before = await familyRows(client, rootId);
  const rootBefore = before.find((x) => x.id === rootId);
  const startQty = Number(rootBefore?.expected_scan_quantity ?? 0);
  if (startQty < 10) {
    return {
      pass: false,
      before,
      after_first: before,
      after_second: before,
      details: { error: `root expected_scan_quantity ${startQty} < 10` },
    };
  }

  const slip1 = `SMOKE-${randomUUID().slice(0, 8)}`;
  const slip2 = `SMOKE-${randomUUID().slice(0, 8)}`;
  const pkg1 = randomUUID();
  const pkg2 = randomUUID();

  const s1 = await client.query(
    `SELECT * FROM public.receive_expected_item_with_split($1::uuid,$2::uuid,$3::uuid,3,'box',$4::text,NULL::uuid,NULL::uuid,$5::uuid,NULL::uuid[])`,
    [ORG_ID, STORE_ID, rootId, slip1, randomUUID()],
  );
  const row1 = s1.rows[0] as Record<string, unknown>;
  const after_first = await familyRows(client, rootId);

  const s2 = await client.query(
    `SELECT * FROM public.receive_expected_item_with_split($1::uuid,$2::uuid,$3::uuid,2,'box',$4::text,NULL::uuid,NULL::uuid,$5::uuid,NULL::uuid[])`,
    [ORG_ID, STORE_ID, rootId, slip2, randomUUID()],
  );
  const row2 = s2.rows[0] as Record<string, unknown>;
  const after_second = await familyRows(client, rootId);

  const rootAfter = after_second.find((x) => x.id === rootId);
  const children = after_second.filter((x) => x.build_source === "receive_allocated");
  const childSum = children.reduce((s, c) => s + Number(c.expected_scan_quantity ?? 0), 0);
  const rootRemainder = Number(rootAfter?.expected_scan_quantity ?? 0);

  const pass =
    Boolean(row1.ok) &&
    Boolean(row2.ok) &&
    children.length >= 2 &&
    childSum === 5 &&
    rootRemainder === startQty - 5;

  return {
    pass,
    before,
    after_first,
    after_second,
    details: {
      startQty,
      split1: row1,
      split2: row2,
      childSum,
      rootRemainder,
      children: children.map((c) => ({
        id: c.id,
        qty: c.expected_scan_quantity,
        slip: c.id_slip_contents,
      })),
    },
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
  if (!approval.valid) blockers.push("Approval flags not both true");

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else {
    if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
      blockers.push(`DB URL must target staging ${STAGING_REF}`);
    }
    if (dbUrl.includes(ORIGINAL_REF)) blockers.push("DB URL targets original — forbidden");
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      "| Flag | Value |",
      "|------|-------|",
      `| APPROVED_TO_RUN_STAGING | ${approval.raw.APPROVED_TO_RUN_STAGING} |`,
      `| APPROVED_EXPECTED_RECEIVE_SPLIT_CONTRACT | ${approval.raw.APPROVED_EXPECTED_RECEIVE_SPLIT_CONTRACT} |`,
      `| valid | **${approval.valid}** |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "code-change-summary.md"),
    [
      "# Code change summary",
      "",
      "| File | Change |",
      "|------|--------|",
      "| `supabase/migrations/20260829120000_expected_receive_split.sql` | Columns + `receive_expected_item_with_split` |",
      "| `lib/scanner/receive-expected-with-split.ts` | RPC types + scope key helper |",
      "| `app/scanner/operator-mobile/item-actions.ts` | Split after return_items insert |",
      "| `app/returns/returns-action-types.ts` | `expected_item_id` on insert payload |",
      "| `app/returns/actions.ts` | Persist `expected_item_id` on insertReturn |",
    ].join("\n") + "\n",
  );

  if (!apply || blockers.length) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      blockers.length
        ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
        : "- Dry-run only; pass `--apply` after approval sign-off.\n",
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        { run_id: runId, ok: false, apply: false, blockers, scanner_wired: true },
        null,
        2,
      ) + "\n",
    );
    console.log(JSON.stringify({ ok: false, outDir, apply: false, blockers }, null, 2));
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const migrationSql = fs.readFileSync(path.join(process.cwd(), MIGRATION_PATH), "utf8");
  await client.query(migrationSql);

  fs.writeFileSync(
    path.join(outDir, "migration-summary.md"),
    [
      "# Migration applied",
      "",
      `- File: \`${MIGRATION_PATH}\``,
      "- Columns: parent_expected_package_id, receive_scope_key, receive_entity_type, allocated_package_id, allocated_pallet_id, receive_idempotency_key",
      "- build_source: receive_allocated",
      "- Function: receive_expected_item_with_split(...)",
    ].join("\n") + "\n",
  );

  const cand = await client.query(
    `
    SELECT id::text FROM public.expected_packages
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
      AND build_source IN ('detail_shipment','detail_remainder')
      AND COALESCE(expected_scan_quantity, 0) >= 10
      AND parent_expected_package_id IS NULL
    ORDER BY expected_scan_quantity DESC
    LIMIT 1
    `,
    [ORG_ID, STORE_ID],
  );
  const rootId = (cand.rows[0] as { id?: string } | undefined)?.id;
  if (!rootId) {
    blockers.push("no_smoke_candidate_ep_qty_10");
  }

  let smoke = {
    pass: false,
    before: [] as EpRow[],
    after_first: [] as EpRow[],
    after_second: [] as EpRow[],
    details: {} as Record<string, unknown>,
  };

  if (rootId) {
    await client.query("BEGIN");
    try {
      smoke = await runSmoke(client, rootId);
      await client.query("ROLLBACK");
    } catch (e) {
      await client.query("ROLLBACK");
      blockers.push(e instanceof Error ? e.message : "smoke_failed");
    }
  }

  fs.writeFileSync(
    path.join(outDir, "smoke-before-after.json"),
    JSON.stringify(
      {
        run_id: runId,
        smoke_root_id: rootId ?? null,
        smoke_pass: smoke.pass,
        before: smoke.before,
        after_first: smoke.after_first,
        after_second: smoke.after_second,
        details: smoke.details,
        note: "Smoke executed in rolled-back transaction — staging EP unchanged.",
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      "-- Rollback migration objects",
      "DROP FUNCTION IF EXISTS public.receive_expected_item_with_split(uuid,uuid,uuid,integer,text,text,uuid,uuid,uuid,uuid[]);",
      "DROP INDEX IF EXISTS public.uq_expected_packages_receive_allocated_scope;",
      "DROP INDEX IF EXISTS public.uq_expected_packages_receive_idempotency;",
      "DROP INDEX IF EXISTS public.idx_expected_packages_receive_parent;",
      "DELETE FROM public.expected_packages WHERE build_source = 'receive_allocated';",
      "ALTER TABLE public.expected_packages DROP COLUMN IF EXISTS receive_idempotency_key;",
      "ALTER TABLE public.expected_packages DROP COLUMN IF EXISTS allocated_pallet_id;",
      "ALTER TABLE public.expected_packages DROP COLUMN IF EXISTS allocated_package_id;",
      "ALTER TABLE public.expected_packages DROP COLUMN IF EXISTS receive_entity_type;",
      "ALTER TABLE public.expected_packages DROP COLUMN IF EXISTS receive_scope_key;",
      "ALTER TABLE public.expected_packages DROP COLUMN IF EXISTS parent_expected_package_id;",
    ].join("\n") + "\n",
  );

  const execBlockers = [...blockers];
  if (!smoke.pass && rootId) execBlockers.push("smoke_test_failed");

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
        smoke_pass: smoke.pass,
        scanner_wired: true,
        rows_before: smoke.before.length,
        rows_after: smoke.after_second.length,
        blockers: execBlockers,
      },
      null,
      2,
    ) + "\n",
  );

  await client.end();
  console.log(
    JSON.stringify(
      {
        ok: execBlockers.length === 0,
        outDir,
        smoke_pass: smoke.pass,
        scanner_wired: true,
        blockers: execBlockers,
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
