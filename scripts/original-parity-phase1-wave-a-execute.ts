/**
 * ORIGINAL-PARITY-PHASE1-WAVE-A-EXECUTE — schema/view parity on original only
 *
 *   npx tsx scripts/original-parity-phase1-wave-a-execute.ts --apply
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const APPROVAL_PATH = ".cursor/operator-approvals/original-parity-phase1-wave-a-approval.md";
const EP_RESOLVER_MIGRATION =
  "supabase/migrations/20260820120000_expected_packages_resolver_columns.sql";
const OUT_BASE = ".cursor/audit-reports/original-parity-phase1-wave-a-execute";
const VIEW_NAME = "v_inventory_item_status";

const EP_RESOLVER_COLS = [
  "resolved_product_id",
  "resolved_catalog_product_id",
  "identifier_resolution_status",
  "identifier_resolution_confidence",
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
  const waveVal = /APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_A\s*=\s*true/i.test(text);
  return {
    valid: runVal && waveVal,
    raw: {
      APPROVED_TO_RUN_ORIGINAL: runVal ? "true" : "false",
      APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_A: waveVal ? "true" : "false",
    },
  };
}

async function tableColumns(client: pg.Client, table: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set((r.rows as Array<{ column_name: string }>).map((x) => x.column_name));
}

async function viewDefinition(client: pg.Client, name: string): Promise<string | null> {
  const r = await client.query(
    `SELECT pg_get_viewdef('public.${name.replace(/'/g, "''")}'::regclass, true) AS def`,
  );
  return (r.rows[0] as { def?: string } | undefined)?.def ?? null;
}

function viewFingerprint(def: string | null): string | null {
  if (!def) return null;
  return String(def.length) + ":" + def.replace(/\s+/g, " ").slice(0, 200);
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
  if (!stagingUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset (read-only view source)");
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
      "# Approval proof — Phase 1 Wave A",
      "",
      `| Flag | Value |`,
      `|------|-------|`,
      `| APPROVED_TO_RUN_ORIGINAL | ${approval.raw.APPROVED_TO_RUN_ORIGINAL} |`,
      `| APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_A | ${approval.raw.APPROVED_ORIGINAL_PARITY_PHASE1_WAVE_A} |`,
      `| approval_file | \`${APPROVAL_PATH}\` |`,
      `| valid | **${approval.valid}** |`,
      "",
      "Original only. No data copy. No Amazon API. No products/PIM DML.",
    ].join("\n") + "\n",
  );

  let schemaGapsFixed = 0;
  let viewParityStatus: "match" | "drift" | "not_applied" = "not_applied";
  let smokePass = false;
  const preGaps: string[] = [];
  const postGaps: string[] = [];

  if (!blockers.length) {
    const staging = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    const original = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await staging.connect();
    await original.connect();
    await staging.query("SET statement_timeout = '120s'");
    await original.query("SET statement_timeout = '120s'");

    const stagingViewDef = await viewDefinition(staging, VIEW_NAME);
    if (!stagingViewDef) blockers.push(`Staging ${VIEW_NAME} missing — cannot source parity DDL`);

    const preOriginalCols = await tableColumns(original, "expected_packages");
    for (const col of EP_RESOLVER_COLS) {
      if (!preOriginalCols.has(col)) preGaps.push(`expected_packages.${col}`);
    }

    const preOriginalViewDef = await viewDefinition(original, VIEW_NAME);
    const preStagingFp = viewFingerprint(stagingViewDef);
    const preOriginalFp = viewFingerprint(preOriginalViewDef);
    if (preStagingFp !== preOriginalFp) preGaps.push(`${VIEW_NAME} view definition drift`);

    fs.writeFileSync(
      path.join(outDir, "pre-apply-state.json"),
      JSON.stringify(
        {
          expected_packages_missing_cols: EP_RESOLVER_COLS.filter((c) => !preOriginalCols.has(c)),
          view_fingerprint_staging: preStagingFp,
          view_fingerprint_original: preOriginalFp,
          view_drift: preStagingFp !== preOriginalFp,
        },
        null,
        2,
      ),
    );

    if (preOriginalViewDef) {
      fs.writeFileSync(
        path.join(outDir, "rollback-view-v_inventory_item_status.sql"),
        [`CREATE OR REPLACE VIEW public.${VIEW_NAME} AS`, preOriginalViewDef.trim().replace(/;\s*$/, "") + ";"].join(
          "\n",
        ) + "\n",
      );
    }

    const epMigrationSql = fs.readFileSync(path.join(process.cwd(), EP_RESOLVER_MIGRATION), "utf8");
    fs.writeFileSync(path.join(outDir, "expected-packages-resolver-columns.sql"), epMigrationSql);

    if (stagingViewDef) {
      const viewSql = `CREATE OR REPLACE VIEW public.${VIEW_NAME} AS\n${stagingViewDef.trim().replace(/;\s*$/, "")};`;
      fs.writeFileSync(path.join(outDir, "v_inventory_item_status-from-staging.sql"), viewSql + "\n");
    }

    fs.writeFileSync(
      path.join(outDir, "rollback-notes.md"),
      [
        "# Rollback notes",
        "",
        "## expected_packages resolver columns",
        "",
        "Additive columns only — rollback optional for Phase 1:",
        "",
        "```sql",
        "-- Only if full rollback required (drops nullable resolver quad):",
        "ALTER TABLE public.expected_packages",
        "  DROP COLUMN IF EXISTS identifier_resolution_confidence,",
        "  DROP COLUMN IF EXISTS identifier_resolution_status,",
        "  DROP COLUMN IF EXISTS resolved_catalog_product_id,",
        "  DROP COLUMN IF EXISTS resolved_product_id;",
        "DROP INDEX IF EXISTS idx_expected_packages_org_resolved;",
        "```",
        "",
        "## v_inventory_item_status",
        "",
        `Restore from \`rollback-view-v_inventory_item_status.sql\` captured pre-apply.`,
        "",
        "Or re-run prior original parity script:",
        "`scripts/main-v206-package-code-inventory-views-original-parity-apply.ts`",
      ].join("\n") + "\n",
    );

    if (apply && approval.valid && !blockers.length) {
      const missingBefore = EP_RESOLVER_COLS.filter((c) => !preOriginalCols.has(c));
      if (missingBefore.length) {
        await original.query(epMigrationSql);
        schemaGapsFixed += 1;
      }

      if (stagingViewDef && preStagingFp !== preOriginalFp) {
        await original.query(
          `CREATE OR REPLACE VIEW public.${VIEW_NAME} AS ${stagingViewDef.trim().replace(/;\s*$/, "")}`,
        );
        schemaGapsFixed += 1;
      }
    }

    const postOriginalCols = await tableColumns(original, "expected_packages");
    for (const col of EP_RESOLVER_COLS) {
      if (!postOriginalCols.has(col)) postGaps.push(`expected_packages.${col}`);
    }

    const postOriginalViewDef = await viewDefinition(original, VIEW_NAME);
    const postStagingFp = viewFingerprint(stagingViewDef);
    const postOriginalFp = viewFingerprint(postOriginalViewDef);
    viewParityStatus = postStagingFp === postOriginalFp ? "match" : "drift";

    let viewQueryOk = false;
    try {
      const q = await original.query(`SELECT COUNT(*)::int AS c FROM public.${VIEW_NAME} LIMIT 1`);
      viewQueryOk = (q.rows[0] as { c: number }).c >= 0;
    } catch {
      viewQueryOk = false;
    }

    const resolverColOk = postOriginalCols.has("resolved_product_id");
    smokePass = resolverColOk && viewParityStatus === "match" && viewQueryOk;

    fs.writeFileSync(
      path.join(outDir, "schema-view-smoke.md"),
      [
        "# Schema / view smoke",
        "",
        "| Check | Result |",
        "|-------|--------|",
        `| expected_packages.resolved_product_id | **${resolverColOk ? "PASS" : "FAIL"}** |`,
        `| All EP resolver columns present | **${EP_RESOLVER_COLS.every((c) => postOriginalCols.has(c)) ? "PASS" : "FAIL"}** |`,
        `| ${VIEW_NAME} fingerprint vs staging | **${viewParityStatus}** |`,
        `| ${VIEW_NAME} SELECT smoke | **${viewQueryOk ? "PASS" : "FAIL"}** |`,
        "",
        `**Overall:** ${smokePass ? "**PASS**" : "**FAIL**"}`,
      ].join("\n") + "\n",
    );

    fs.writeFileSync(
      path.join(outDir, "apply-result.md"),
      [
        "# Apply result",
        "",
        `| Item | Before | After |`,
        `|------|--------|-------|`,
        `| EP resolver cols missing | ${EP_RESOLVER_COLS.filter((c) => !preOriginalCols.has(c)).length} | ${EP_RESOLVER_COLS.filter((c) => !postOriginalCols.has(c)).length} |`,
        `| View drift | ${preStagingFp !== preOriginalFp ? "yes" : "no"} | ${viewParityStatus === "match" ? "no" : "yes"} |`,
        `| apply_mode | ${apply ? "apply" : "dry-run"} | |`,
        `| schema_gaps_fixed | **${schemaGapsFixed}** | |`,
      ].join("\n") + "\n",
    );

    await staging.end();
    await original.end();
  }

  const nextPrompt = smokePass
    ? "ORIGINAL-PARITY-PHASE1-WAVE-B-EXECUTE — governed product/map spine replay on original (approval-gated)"
    : blockers.length
      ? "ORIGINAL-PARITY-PHASE1-WAVE-A-EXECUTE — fix blockers and re-run"
      : "ORIGINAL-PARITY-PHASE1-WAVE-A-EXECUTE — smoke failed; review rollback-notes.md";

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None.\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "ORIGINAL-PARITY-PHASE1-WAVE-A-EXECUTE",
        run_id: runId,
        branch,
        original_ref: ORIGINAL_REF,
        staging_ref_read_only: STAGING_REF,
        status: blockers.length ? "BLOCKED" : smokePass ? "PASS" : "FAIL",
        apply,
        schema_gaps_fixed_count: schemaGapsFixed,
        view_parity_status: viewParityStatus,
        smoke_pass: smokePass,
        pre_gaps: preGaps,
        post_gaps: postGaps,
        exact_next_prompt: nextPrompt,
        no_staging_writes: true,
        no_data_copy: true,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: !blockers.length && smokePass,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        schema_gaps_fixed: schemaGapsFixed,
        view_parity_status: viewParityStatus,
        smoke_pass: smokePass,
        next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );

  if (blockers.length || (apply && !smokePass)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
