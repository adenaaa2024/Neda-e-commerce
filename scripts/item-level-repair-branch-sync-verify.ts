/**
 * ITEM-LEVEL REPAIR BRANCH SYNC AND VERIFY (read-only + optional migration apply)
 *
 *   npx tsx scripts/item-level-repair-branch-sync-verify.ts
 *   npx tsx scripts/item-level-repair-branch-sync-verify.ts --apply-migration
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/item-level-repair-branch-sync-and-verify";
const MIGRATION_ITEM_LEVEL = "supabase/migrations/20260830120000_expected_receive_split_item_level.sql";
const MAIN_PASS_REPORT =
  ".cursor/audit-reports/expected-receive-split-item-row-repair-execute/20260528T180714Z";
const NEDA_BLOCKED_REPORT =
  ".cursor/audit-reports/neda-item-level-receive-smoke-after-repair/20260528T183457Z";

const REPO_FILES = [
  "supabase/migrations/20260830120000_expected_receive_split_item_level.sql",
  "supabase/migrations/20260829120000_expected_receive_split.sql",
  "app/scanner/operator-mobile/item-actions.ts",
  "lib/scanner/receive-expected-with-split.ts",
  "scripts/expected-receive-split-item-row-repair-execute-staging.ts",
  ".cursor/operator-approvals/item-level-receive-split-fix-approval.md",
] as const;

const RPC_FUNCTIONS = [
  "allocate_expected_item_unit",
  "allocate_expected_items_for_return_item_ids",
  "release_expected_item_unit",
  "move_expected_item_unit",
  "receive_expected_item_with_split",
] as const;

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function checkRepoFiles(): Record<string, { exists: boolean; has_allocate_rpc: boolean | null }> {
  const out: Record<string, { exists: boolean; has_allocate_rpc: boolean | null }> = {};
  for (const rel of REPO_FILES) {
    const full = path.join(process.cwd(), rel);
    const exists = fs.existsSync(full);
    let has_allocate_rpc: boolean | null = null;
    if (rel.endsWith("item-actions.ts") && exists) {
      const text = fs.readFileSync(full, "utf8");
      has_allocate_rpc = text.includes("allocate_expected_items_for_return_item_ids");
    }
    out[rel] = { exists, has_allocate_rpc };
  }
  return out;
}

async function functionExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = $1
     ) AS ok`,
    [name],
  );
  return Boolean((r.rows[0] as { ok: boolean }).ok);
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

async function testQtyOnlyBlocked(client: pg.Client): Promise<{ blocked: boolean; message: string }> {
  const cand = await client.query(
    `SELECT id::text FROM public.expected_packages
     WHERE organization_id=$1 AND store_id=$2
       AND build_source IN ('detail_shipment','detail_remainder')
       AND COALESCE(expected_scan_quantity,0) >= 5
       AND parent_expected_package_id IS NULL
     LIMIT 1`,
    [ORG_ID, STORE_ID],
  );
  const rootId = (cand.rows[0] as { id?: string } | undefined)?.id;
  if (!rootId) return { blocked: false, message: "no_root_candidate" };

  try {
    const r = await client.query(
      `SELECT ok, message FROM public.receive_expected_item_with_split(
        $1::uuid,$2::uuid,$3::uuid,3,'box','sync-test',NULL,NULL,NULL::uuid,NULL::uuid[],false
      )`,
      [ORG_ID, STORE_ID, rootId],
    );
    const row = r.rows[0] as { ok: boolean; message: string };
    return {
      blocked: row.ok === false && String(row.message).includes("return_item_ids required"),
      message: row.message,
    };
  } catch (e) {
    return { blocked: false, message: e instanceof Error ? e.message : "rpc_error" };
  }
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const applyMigration = process.argv.includes("--apply-migration");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const head = execSync("git log -1 --oneline", { encoding: "utf8" }).trim();
  const blockers: string[] = [];

  const repoFiles = checkRepoFiles();
  const repoHasRepair = REPO_FILES.every((f) => repoFiles[f]?.exists);
  const itemActionsOk =
    repoFiles["app/scanner/operator-mobile/item-actions.ts"]?.has_allocate_rpc === true;

  const mainPassExists = fs.existsSync(path.join(process.cwd(), MAIN_PASS_REPORT, "manifest.json"));
  const nedaReportExists = fs.existsSync(path.join(process.cwd(), NEDA_BLOCKED_REPORT));

  let stagingFns: Record<string, boolean> = {};
  let hasExpectedItemId = false;
  let qtyCheck = { blocked: false, message: "not_run" };
  let migrationApplied = false;
  let migrationApplyError: string | null = null;

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) {
    blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  } else if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    blockers.push(`DB URL not staging ${STAGING_REF}`);
  } else if (dbUrl.includes(ORIGINAL_REF)) {
    blockers.push("DB URL targets original — forbidden");
  } else {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    await client.query("SET statement_timeout = '120s'");

    for (const fn of RPC_FUNCTIONS) {
      stagingFns[fn] = await functionExists(client, fn);
    }
    hasExpectedItemId = await columnExists(client, "return_items", "expected_item_id");

    const stagingHasCoreRpcs =
      stagingFns.allocate_expected_item_unit &&
      stagingFns.allocate_expected_items_for_return_item_ids &&
      stagingFns.release_expected_item_unit &&
      stagingFns.move_expected_item_unit;

    if (repoHasRepair && !stagingHasCoreRpcs && applyMigration) {
      try {
        await client.query(
          fs.readFileSync(path.join(process.cwd(), MIGRATION_ITEM_LEVEL), "utf8"),
        );
        migrationApplied = true;
        for (const fn of RPC_FUNCTIONS) {
          stagingFns[fn] = await functionExists(client, fn);
        }
        hasExpectedItemId = await columnExists(client, "return_items", "expected_item_id");
      } catch (e) {
        migrationApplyError = e instanceof Error ? e.message : String(e);
        blockers.push(`migration_apply_failed: ${migrationApplyError}`);
      }
    }

    if (stagingFns.receive_expected_item_with_split) {
      qtyCheck = await testQtyOnlyBlocked(client);
    }

    await client.end();
  }

  const stagingHasRpcs =
    stagingFns.allocate_expected_item_unit &&
    stagingFns.allocate_expected_items_for_return_item_ids &&
    stagingFns.release_expected_item_unit &&
    stagingFns.move_expected_item_unit;

  if (repoHasRepair && !stagingHasRpcs && !migrationApplied) {
    blockers.push("repo_has_repair_staging_missing_rpcs — run with --apply-migration or repair execute");
  }
  if (repoHasRepair && !itemActionsOk) {
    blockers.push("item-actions.ts missing allocate_expected_items_for_return_item_ids");
  }
  if (branch !== REQUIRED_BRANCH) {
    blockers.push(`branch ${branch} !== ${REQUIRED_BRANCH}`);
  }

  const contradiction =
    mainPassExists && nedaReportExists
      ? "Main PASS report present; Neda BLOCKED report present — likely branch/sync drift"
      : mainPassExists
        ? "Main PASS only"
        : nedaReportExists
          ? "Neda BLOCKED only"
          : "no_prior_reports_in_workspace";

  fs.writeFileSync(
    path.join(outDir, "branch-state.md"),
    [
      "# Branch state",
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| Branch | \`${branch}\` |`,
      `| HEAD | \`${head}\` |`,
      `| Required | \`${REQUIRED_BRANCH}\` |`,
      `| Main PASS report | ${mainPassExists ? `\`${MAIN_PASS_REPORT}\`` : "not in workspace"} |`,
      `| Neda BLOCKED report | ${nedaReportExists ? `\`${NEDA_BLOCKED_REPORT}\`` : "not in workspace"} |`,
      `| Contradiction note | ${contradiction} |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(path.join(outDir, "repo-file-check.json"), JSON.stringify({ repo_files: repoFiles, repo_has_repair: repoHasRepair, item_actions_uses_item_rpc: itemActionsOk }, null, 2));

  fs.writeFileSync(
    path.join(outDir, "staging-function-check.json"),
    JSON.stringify(
      {
        staging_ref: STAGING_REF,
        return_items_expected_item_id: hasExpectedItemId,
        functions: stagingFns,
        staging_has_core_rpcs: stagingHasRpcs,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "migration-apply-result.md"),
    [
      "# Migration apply result",
      "",
      `| Applied this run | **${migrationApplied}** |`,
      `| Flag | \`--apply-migration\` = ${applyMigration} |`,
      `| Migration file | \`${MIGRATION_ITEM_LEVEL}\` |`,
      migrationApplyError ? `| Error | ${migrationApplyError} |` : "",
      "",
      migrationApplied
        ? "Migration applied to staging in this verify run."
        : stagingHasRpcs
          ? "RPCs already present — no apply needed."
          : "RPCs missing — re-run: `npx tsx scripts/item-level-repair-branch-sync-verify.ts --apply-migration`",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "quantity-path-check.md"),
    [
      "# Quantity-only path check",
      "",
      `| receive_expected_item_with_split present | ${stagingFns.receive_expected_item_with_split ?? false} |`,
      `| Qty-only blocked (no return_item_ids) | **${qtyCheck.blocked ? "yes" : "no"}** |`,
      `| Message | \`${qtyCheck.message}\` |`,
    ].join("\n") + "\n",
  );

  const filesToSync = REPO_FILES.filter((f) => repoFiles[f]?.exists);

  fs.writeFileSync(
    path.join(outDir, "neda-branch-sync-instructions.md"),
    [
      "# Neda branch sync instructions",
      "",
      "## Root cause of contradiction",
      "",
      "Main workspace ran repair **execute** on staging DB but Neda branch may lack:",
      "",
      "1. Committed migration + app code on her checkout",
      "2. Applied migration on staging (if she points at same ref but old schema)",
      "3. Audit folder `expected-receive-split-item-row-repair-execute/` (not committed or not pulled)",
      "",
      "## Step 1 — Git sync (Neda checkout)",
      "",
      "```bash",
      "git fetch origin",
      "git checkout feature/product-canonicalization-v2",
      "git pull origin feature/product-canonicalization-v2",
      "```",
      "",
      "## Step 2 — Verify these files exist locally",
      "",
      ...filesToSync.map((f) => `- \`${f}\``),
      "",
      "**Critical:** `item-actions.ts` must call `allocate_expected_items_for_return_item_ids` (not bulk qty-only split).",
      "",
      "## Step 3 — Apply migration to staging (if RPCs missing)",
      "",
      "```bash",
      "npx tsx scripts/item-level-repair-branch-sync-verify.ts --apply-migration",
      "# or",
      "npx tsx scripts/expected-receive-split-item-row-repair-execute-staging.ts --apply",
      "```",
      "",
      "Migration only: `supabase/migrations/20260830120000_expected_receive_split_item_level.sql`",
      "",
      "## Step 4 — Re-run smokes",
      "",
      "```bash",
      "npx tsx scripts/expected-receive-split-item-row-repair-execute-staging.ts --apply",
      "npx tsx scripts/neda-item-level-receive-smoke.ts   # if present on branch after pull",
      "```",
      "",
      "## Step 5 — Browser smoke",
      "",
      "NEDA-SCANNER-RECEIVE-ITEM-ROW-SMOKE — operatorReceiveItem qty=3 → 3 return_items rows + conservation",
      "",
      "## Do not",
      "",
      "- Bulk copy staging map/products to original",
      "- Use `receive_expected_item_with_split` with NULL return_item_ids from scanner",
    ].join("\n") + "\n",
  );

  const syncOk =
    repoHasRepair &&
    itemActionsOk &&
    stagingHasRpcs &&
    hasExpectedItemId &&
    qtyCheck.blocked;

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length
      ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
      : syncOk
        ? "- None — repo and staging aligned.\n"
        : "- See staging-function-check.json and quantity-path-check.md\n",
  );

  const nextPrompt = syncOk
    ? "NEDA-ITEM-LEVEL-RECEIVE-SMOKE-RETRY — pull feature/product-canonicalization-v2 then browser proof qty=3"
    : repoHasRepair && !stagingHasRpcs
      ? "ITEM-LEVEL-REPAIR-STAGING-MIGRATION-APPLY — run --apply-migration on staging eiqfaapyumhixxoeltgu"
      : !repoHasRepair
        ? "ITEM-LEVEL-REPAIR-BRANCH-MERGE — cherry-pick repair commits onto Neda branch before smoke"
        : "ITEM-LEVEL-REPAIR-SYNC-DIAGNOSE — read blockers.md";

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt_id: "ITEM-LEVEL-REPAIR-BRANCH-SYNC-AND-VERIFY",
        run_id: runId,
        branch,
        repo_has_repair: repoHasRepair,
        item_actions_item_rpc: itemActionsOk,
        staging_has_rpcs: stagingHasRpcs,
        staging_expected_item_id: hasExpectedItemId,
        quantity_only_blocked: qtyCheck.blocked,
        migration_applied_this_run: migrationApplied,
        sync_ok: syncOk,
        blockers,
        exact_next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: syncOk && blockers.length === 0,
        outDir,
        repo_has_repair: repoHasRepair,
        staging_has_rpcs: stagingHasRpcs,
        migration_applied: migrationApplied,
        quantity_only_blocked: qtyCheck.blocked,
        next_prompt: nextPrompt,
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
