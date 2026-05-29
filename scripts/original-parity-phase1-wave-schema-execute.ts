/**
 * ORIGINAL-PARITY-PHASE1-WAVE-SCHEMA-EXECUTE — post-item-level migration pack on original
 *
 *   npx tsx scripts/original-parity-phase1-wave-schema-execute.ts --apply
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const APPROVAL_PATH = ".cursor/operator-approvals/original-parity-phase1-wave-schema-approval.md";
const OUT_BASE = ".cursor/audit-reports/original-parity-phase1-wave-schema-execute";

const MIGRATIONS = [
  "supabase/migrations/20260827160000_expected_packages_tracking_group_allocation.sql",
  "supabase/migrations/20260828120000_removal_carrier_normalization_views.sql",
  "supabase/migrations/20260829120000_expected_receive_split.sql",
  "supabase/migrations/20260830120000_expected_receive_split_item_level.sql",
] as const;

const REQUIRED_FUNCTIONS = [
  "normalize_removal_tracking_operational",
  "normalize_removal_carrier_operational",
  "rebuild_expected_packages_from_removals",
  "receive_expected_item_with_split",
  "allocate_expected_item_unit",
  "allocate_expected_items_for_return_item_ids",
  "release_expected_item_unit",
  "move_expected_item_unit",
] as const;

const VIEWS = ["v_inventory_item_status", "v_scanned_items_counted", "v_inventory_status"] as const;

const EP_COLS = [
  "allocation_group_key",
  "source_shipment_row_ids",
  "parent_expected_package_id",
  "receive_scope_key",
  "receive_entity_type",
] as const;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

function readApproval(): { valid: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runVal = /APPROVED_TO_RUN_ORIGINAL\s*=\s*true/i.test(text);
  const schemaVal = /APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_SCHEMA\s*=\s*true/i.test(text);
  return {
    valid: runVal && schemaVal,
    raw: {
      APPROVED_TO_RUN_ORIGINAL: runVal ? "true" : "false",
      APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_SCHEMA: schemaVal ? "true" : "false",
    },
  };
}

async function functionExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname=$1
     ) AS ok`,
    [name],
  );
  return Boolean((r.rows[0] as { ok: boolean }).ok);
}

async function functionBody(client: pg.Client, name: string): Promise<string | null> {
  const r = await client.query(
    `SELECT pg_get_functiondef(p.oid) AS def
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname=$1 ORDER BY p.oid LIMIT 1`,
    [name],
  );
  return (r.rows[0] as { def?: string } | undefined)?.def ?? null;
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

async function viewDef(client: pg.Client, name: string): Promise<string | null> {
  const r = await client.query(
    `SELECT pg_get_viewdef('public.${name.replace(/'/g, "''")}'::regclass, true) AS def`,
  );
  return (r.rows[0] as { def?: string } | undefined)?.def ?? null;
}

function viewFingerprint(def: string | null): string | null {
  if (!def) return null;
  return `${def.length}:${def.replace(/\s+/g, " ").slice(0, 160)}`;
}

async function probeMigrationNeeded(client: pg.Client, file: string): Promise<boolean> {
  if (file.includes("20260827160000")) {
    const body = await functionBody(client, "rebuild_expected_packages_from_removals");
    return !body?.includes("allocation_group_key");
  }
  if (file.includes("20260828120000")) {
    return !(await functionExists(client, "normalize_removal_carrier_operational"));
  }
  if (file.includes("20260829120000")) {
    return !(await columnExists(client, "expected_packages", "parent_expected_package_id"));
  }
  if (file.includes("20260830120000")) {
    return !(await functionExists(client, "allocate_expected_item_unit"));
  }
  return true;
}

async function captureViewRollback(client: pg.Client): Promise<string> {
  const parts = ["-- Rollback: restore pre-apply inventory views", ""];
  for (const v of VIEWS) {
    const def = await viewDef(client, v);
    if (def) {
      parts.push(`CREATE OR REPLACE VIEW public.${v} AS`, def.trim().replace(/;\s*$/, "") + ";", "");
    }
  }
  return parts.join("\n");
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

  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!originalUrl) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL unset");
  if (!stagingUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset (view parity compare)");
  if (originalUrl && refFromConnectionUrl(originalUrl) !== ORIGINAL_REF) {
    blockers.push(`ORIGINAL URL must target ${ORIGINAL_REF}`);
  }
  if (stagingUrl && refFromConnectionUrl(stagingUrl) !== STAGING_REF) {
    blockers.push(`STAGING URL must target ${STAGING_REF}`);
  }
  if (originalUrl && stagingUrl && originalUrl === stagingUrl) {
    blockers.push("ORIGINAL and STAGING URLs must differ");
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof — Phase 1 Wave schema",
      "",
      "| Flag | Value |",
      "|------|-------|",
      `| APPROVED_TO_RUN_ORIGINAL | ${approval.raw.APPROVED_TO_RUN_ORIGINAL} |`,
      `| APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_SCHEMA | ${approval.raw.APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_SCHEMA} |`,
      `| approval_file | \`${APPROVAL_PATH}\` |`,
      `| valid | **${approval.valid}** |`,
      "",
      "Original only. No staging data copy. No Amazon API. No products/PIM DML.",
    ].join("\n") + "\n",
  );

  const applyResults: Array<{ file: string; needed: boolean; applied: boolean; error?: string }> = [];
  let migrationsApplied = 0;
  let functionCheck: Record<string, boolean> = {};
  let groupedRebuild = false;
  let hasExpectedItemId = false;
  let viewParity = false;
  let smokePass = false;

  if (!blockers.length) {
    const original = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    const staging = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    await original.connect();
    await staging.connect();
    await original.query("SET statement_timeout = '300s'");
    await staging.query("SET statement_timeout = '120s'");

    const preRollback = await captureViewRollback(original);
    fs.writeFileSync(path.join(outDir, "rollback.sql"), preRollback + "\n");

    const preRebuildBody = await functionBody(original, "rebuild_expected_packages_from_removals");
    if (preRebuildBody) {
      fs.writeFileSync(path.join(outDir, "pre-rebuild_expected_packages_from_removals.sql"), preRebuildBody + "\n");
    }

    for (const rel of MIGRATIONS) {
      const full = path.join(process.cwd(), rel);
      const needed = await probeMigrationNeeded(original, rel);
      let applied = false;
      let error: string | undefined;
      if (apply && approval.valid && needed) {
        try {
          const sql = fs.readFileSync(full, "utf8");
          await original.query(sql);
          applied = true;
          migrationsApplied += 1;
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
          blockers.push(`Migration failed ${rel}: ${error}`);
        }
      }
      applyResults.push({ file: rel, needed, applied, error });
    }

    for (const fn of REQUIRED_FUNCTIONS) {
      functionCheck[fn] = await functionExists(original, fn);
    }

    const rebuildBody = await functionBody(original, "rebuild_expected_packages_from_removals");
    groupedRebuild = rebuildBody?.includes("allocation_group_key") ?? false;
    hasExpectedItemId = await columnExists(original, "return_items", "expected_item_id");

    const epColCheck: Record<string, boolean> = {};
    for (const col of EP_COLS) {
      epColCheck[col] = await columnExists(original, "expected_packages", col);
    }

    const viewCheck: Record<string, { original_fp: string | null; staging_fp: string | null; match: boolean }> = {};
    let allViewsMatch = true;
    for (const v of VIEWS) {
      const oDef = await viewDef(original, v);
      const sDef = await viewDef(staging, v);
      const oFp = viewFingerprint(oDef);
      const sFp = viewFingerprint(sDef);
      const match = oFp === sFp && oFp != null;
      viewCheck[v] = { original_fp: oFp, staging_fp: sFp, match };
      if (!match) allViewsMatch = false;
    }
    viewParity = allViewsMatch;

    let viewSelectOk = true;
    for (const v of VIEWS) {
      try {
        await original.query(`SELECT 1 FROM public.${v} LIMIT 1`);
      } catch {
        viewSelectOk = false;
      }
    }

    const allFunctions = Object.values(functionCheck).every(Boolean);
    const allEpCols = Object.values(epColCheck).every(Boolean);
    smokePass =
      allFunctions &&
      groupedRebuild &&
      hasExpectedItemId &&
      allEpCols &&
      viewParity &&
      viewSelectOk;

    fs.writeFileSync(path.join(outDir, "original-function-check.json"), JSON.stringify({
      functions: functionCheck,
      grouped_rebuild: groupedRebuild,
      return_items_expected_item_id: hasExpectedItemId,
      expected_packages_columns: epColCheck,
      all_functions_present: allFunctions,
    }, null, 2));

    fs.writeFileSync(
      path.join(outDir, "original-view-check.md"),
      [
        "# Original view parity vs staging",
        "",
        "| View | Match |",
        "|------|-------|",
        ...VIEWS.map((v) => `| ${v} | **${viewCheck[v]?.match ? "yes" : "no"}** |`),
        "",
        `**Overall view parity:** ${viewParity ? "**yes**" : "**no**"}`,
      ].join("\n") + "\n",
    );

    fs.writeFileSync(
      path.join(outDir, "migration-apply-result.md"),
      [
        "# Migration apply result",
        "",
        `| # | Migration | Needed | Applied |`,
        "|---|-----------|--------|---------|",
        ...applyResults.map((r, i) =>
          `| ${i + 1} | \`${path.basename(r.file)}\` | ${r.needed ? "yes" : "no"} | ${r.applied ? "**yes**" : r.error ? `FAIL: ${r.error}` : "skipped"} |`,
        ),
        "",
        `**Migrations applied this run:** ${migrationsApplied}`,
        "",
        "Note: `20260827160000` includes duplicate detail_remainder cleanup on original (not staging data copy).",
      ].join("\n") + "\n",
    );

    fs.writeFileSync(
      path.join(outDir, "smoke-schema-proof.md"),
      [
        "# Schema smoke proof",
        "",
        "| Gate | Result |",
        "|------|--------|",
        `| All required functions | **${allFunctions ? "PASS" : "FAIL"}** |`,
        `| Grouped rebuild (allocation_group_key) | **${groupedRebuild ? "PASS" : "FAIL"}** |`,
        `| return_items.expected_item_id | **${hasExpectedItemId ? "PASS" : "FAIL"}** |`,
        `| Receive split EP columns | **${allEpCols ? "PASS" : "FAIL"}** |`,
        `| View parity vs staging | **${viewParity ? "PASS" : "FAIL"}** |`,
        `| View SELECT smoke | **${viewSelectOk ? "PASS" : "FAIL"}** |`,
        "",
        `**Overall:** ${smokePass ? "**PASS**" : "**FAIL**"}`,
      ].join("\n") + "\n",
    );

    await original.end();
    await staging.end();
  }

  const nextPrompt = smokePass
    ? "ORIGINAL-PARITY-PHASE1-WAVE-DATA-EXECUTE — governed removal domain + rebuild on original (approval-gated)"
    : blockers.length
      ? "ORIGINAL-PARITY-PHASE1-WAVE-SCHEMA-EXECUTE — fix blockers and re-run"
      : "ORIGINAL-PARITY-PHASE1-WAVE-SCHEMA-EXECUTE — smoke failed; review rollback.sql";

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None.\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({
      prompt: "ORIGINAL-PARITY-PHASE1-WAVE-SCHEMA-EXECUTE",
      run_id: runId,
      branch,
      original_ref: ORIGINAL_REF,
      status: blockers.length ? "BLOCKED" : smokePass ? "PASS" : "FAIL",
      apply,
      migrations_applied_count: migrationsApplied,
      functions_present: Object.values(functionCheck).every(Boolean),
      grouped_rebuild: groupedRebuild,
      view_parity: viewParity,
      smoke_pass: smokePass,
      exact_next_prompt: nextPrompt,
      no_staging_writes: true,
      no_data_copy: true,
    }, null, 2),
  );

  console.log(JSON.stringify({
    ok: !blockers.length && smokePass,
    outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
    migrations_applied: migrationsApplied,
    functions_present: Object.values(functionCheck).every(Boolean),
    view_parity: viewParity,
    smoke_pass: smokePass,
    next_prompt: nextPrompt,
  }, null, 2));

  if (blockers.length || (apply && !smokePass)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
