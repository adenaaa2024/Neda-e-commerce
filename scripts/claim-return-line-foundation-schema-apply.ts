/**
 * CLAIM-RETURN-LINE-FOUNDATION-SCHEMA-APPLY — staging-only claim_lines migration.
 *
 *   npx tsx scripts/claim-return-line-foundation-schema-apply.ts --apply [--run-id=<UTC_Z>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const APPROVAL_PATH = ".cursor/operator-approvals/claim-return-line-foundation-schema-approval.md";
const DRYRUN_RUN_ID = "20260528T140000Z";
const DRYRUN_SQL = `.cursor/audit-reports/claim-return-line-foundation-schema-dryrun/${DRYRUN_RUN_ID}/claim-lines-migration-draft.sql`;
const OUT_BASE = ".cursor/audit-reports/claim-return-line-foundation-schema-apply";

const ROLLBACK_SQL = `-- Rollback: claim_lines foundation (staging only)
BEGIN;
DROP TRIGGER IF EXISTS trg_claim_lines_set_updated_at ON public.claim_lines;
DROP POLICY IF EXISTS "claim_lines_select_own_org" ON public.claim_lines;
DROP POLICY IF EXISTS "claim_lines_service_role_all" ON public.claim_lines;
DROP TABLE IF EXISTS public.claim_lines CASCADE;
COMMIT;
NOTIFY pgrst, 'reload schema';
`;

const EXPECTED_INDEXES = [
  "idx_claim_lines_org_store_status",
  "idx_claim_lines_org_return_item",
  "idx_claim_lines_org_expected_package",
  "idx_claim_lines_org_expected_root",
  "idx_claim_lines_claim_candidate",
  "idx_claim_lines_org_source",
  "idx_claim_lines_org_resolved_product",
] as const;

const EXPECTED_COLUMNS = [
  "id",
  "organization_id",
  "store_id",
  "claim_candidate_id",
  "claim_candidate_draft_id",
  "return_item_id",
  "expected_package_id",
  "expected_package_root_id",
  "product_id",
  "resolved_product_id",
  "package_id",
  "pallet_id",
  "slip_content_id",
  "tracking_number",
  "order_id",
  "sku",
  "fnsku",
  "asin",
  "source_table",
  "source_row_id",
  "source_detail_row_id",
  "source_shipment_row_id",
  "line_grain",
  "discrepancy_kind",
  "quantity_basis",
  "count_basis",
  "quantity_expected",
  "quantity_actual",
  "quantity_delta",
  "status",
  "status_reason",
  "idempotency_key",
  "metadata",
  "created_at",
  "updated_at",
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

function readApproval(): { valid: boolean; flags: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const staging = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const schema = /APPROVED_CLAIM_RETURN_LINE_FOUNDATION_SCHEMA\s*=\s*true/i.test(text);
  return {
    valid: staging && schema,
    flags: {
      APPROVED_TO_RUN_STAGING: staging ? "true" : "false",
      APPROVED_CLAIM_RETURN_LINE_FOUNDATION_SCHEMA: schema ? "true" : "false",
    },
  };
}

function refFromConnectionUrl(url: string): string | null {
  return refFromSupabaseUrl(url) ?? url.match(/\.([a-z]{20})\./i)?.[1]?.toLowerCase() ?? null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) {
    blockers.push(`Branch must be ${REQUIRED_BRANCH} (got ${branch})`);
  }
  if (!approval.valid) {
    blockers.push("Approval flags not both true — STOP");
  }
  if (!fs.existsSync(path.join(process.cwd(), DRYRUN_SQL))) {
    blockers.push(`Dry-run SQL missing: ${DRYRUN_SQL}`);
  }

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromConnectionUrl(dbUrl) || refFromSupabaseUrl(publicUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push(`Staging guard failed (expected ${STAGING_REF})`);
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      `Path: \`${APPROVAL_PATH}\``,
      "",
      "| Flag | Value |",
      "|------|-------|",
      ...Object.entries(approval.flags).map(([k, v]) => `| ${k} | ${v} |`),
      "",
      `Dry-run SQL: \`${DRYRUN_SQL}\``,
      `Branch: \`${branch}\``,
      `Staging: \`${STAGING_REF}\``,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(path.join(outDir, "rollback.sql"), ROLLBACK_SQL);

  if (blockers.length || !apply) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      (blockers.length ? blockers : ["Pass --apply to execute migration"]).map((b) => `- ${b}`).join("\n") + "\n",
    );
    const manifest = {
      prompt: "CLAIM-RETURN-LINE-FOUNDATION-SCHEMA-APPLY",
      run_id: runId,
      status: blockers.length ? "BLOCKED" : "DRY_RUN_ONLY",
      blockers,
      claim_lines_exists: null,
      rollback_path: `${OUT_BASE}/${runId}/rollback.sql`,
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify(manifest, null, 2));
    if (blockers.length) process.exit(1);
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const tableCountBefore = await client.query(
    `SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_schema='public'`,
  );
  const claimLinesBefore = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name='claim_lines'
     ) AS ok`,
  );
  const existedBefore = Boolean((claimLinesBefore.rows[0] as { ok: boolean }).ok);

  const migrationSql = fs.readFileSync(path.join(process.cwd(), DRYRUN_SQL), "utf8");
  let applyError: string | null = null;
  let applyMode: "executed" | "idempotent_verify_only" = "executed";
  if (existedBefore) {
    applyMode = "idempotent_verify_only";
  } else {
    try {
      await client.query(migrationSql);
    } catch (e) {
      applyError = e instanceof Error ? e.message : String(e);
      blockers.push(`Migration apply failed: ${applyError}`);
    }
  }

  const verify: Record<string, unknown> = {};
  if (!applyError) {
    const exists = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema='public' AND table_name='claim_lines'
       ) AS ok`,
    );
    verify.table_exists = Boolean((exists.rows[0] as { ok: boolean }).ok);

    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='claim_lines' ORDER BY ordinal_position`,
    );
    const colNames = cols.rows.map((r: { column_name: string }) => r.column_name);
    verify.columns = colNames;
    verify.missing_columns = EXPECTED_COLUMNS.filter((c) => !colNames.includes(c));

    const idx = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='claim_lines'`,
    );
    const indexNames = idx.rows.map((r: { indexname: string }) => r.indexname);
    verify.indexes = indexNames;
    verify.missing_indexes = EXPECTED_INDEXES.filter((i) => !indexNames.includes(i));

    const rls = await client.query(
      `SELECT relrowsecurity FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relname='claim_lines'`,
    );
    verify.rls_enabled = Boolean((rls.rows[0] as { relrowsecurity?: boolean })?.relrowsecurity);

    const policies = await client.query(
      `SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='claim_lines'`,
    );
    verify.policies = policies.rows.map((r: { policyname: string }) => r.policyname);

    const rowCount = await client.query(`SELECT COUNT(*)::int AS c FROM public.claim_lines`);
    verify.row_count = (rowCount.rows[0] as { c: number }).c;

    const fks = await client.query(
      `SELECT conname FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname='public' AND t.relname='claim_lines' AND c.contype='f'`,
    );
    verify.fk_count = fks.rowCount ?? 0;

    if (!verify.table_exists) blockers.push("claim_lines table not found after apply");
    if ((verify.missing_columns as string[]).length) {
      blockers.push(`Missing columns: ${(verify.missing_columns as string[]).join(", ")}`);
    }
    if ((verify.missing_indexes as string[]).length) {
      blockers.push(`Missing indexes: ${(verify.missing_indexes as string[]).join(", ")}`);
    }
    if (!verify.rls_enabled) blockers.push("RLS not enabled on claim_lines");
    if (verify.row_count !== 0) blockers.push(`Unexpected rows in claim_lines: ${verify.row_count}`);
  }

  const tableCountAfter = await client.query(
    `SELECT COUNT(*)::int AS c FROM information_schema.tables WHERE table_schema='public'`,
  );
  verify.tables_public_before = (tableCountBefore.rows[0] as { c: number }).c;
  verify.tables_public_after = (tableCountAfter.rows[0] as { c: number }).c;
  verify.claim_lines_existed_before = existedBefore;
  verify.destructive_delta =
    verify.tables_public_after < verify.tables_public_before
      ? "possible table drops"
      : "none detected (public table count non-decreasing)";

  await client.end();

  fs.writeFileSync(
    path.join(outDir, "migration-apply-result.md"),
    [
      "# Migration apply result",
      "",
      `- **SQL source:** \`${DRYRUN_SQL}\``,
      `- **Applied:** ${applyError ? "**FAILED**" : applyMode === "idempotent_verify_only" ? "**IDEMPOTENT (verify only)**" : "**SUCCESS**"}`,
      `- **claim_lines existed before:** ${existedBefore}`,
      `- **Apply mode:** ${applyMode}`,
      applyError ? `- **Error:** \`${applyError}\`` : "",
      "",
      "No backfill executed in this prompt.",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "schema-verify.md"),
    ["# Schema verify", "", "```json", JSON.stringify(verify, null, 2), "```"].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    (blockers.length
      ? ["# Blockers", "", ...blockers.map((b) => `- ${b}`)]
      : ["# Blockers", "", "- None"]
    ).join("\n") + "\n",
  );

  const nextPrompt = blockers.length
    ? "CLAIM-RETURN-LINE-FOUNDATION-SCHEMA-APPLY-RETRY — resolve apply failures"
    : applyMode === "idempotent_verify_only"
      ? "CLAIM-RETURN-LINE-BACKFILL-EXECUTE — governed staging INSERT after approval"
      : "CLAIM-RETURN-LINE-FOUNDATION-BACKFILL-DRYRUN — governed backfill census + execute plan (separate approval)";

  const manifest = {
    prompt: "CLAIM-RETURN-LINE-FOUNDATION-SCHEMA-APPLY-REVISED",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    dryrun_run_id: DRYRUN_RUN_ID,
    migration_applied: !applyError,
    claim_lines_exists: verify.table_exists ?? false,
    row_count: verify.row_count ?? null,
    blockers,
    rollback_path: `${OUT_BASE}/${runId}/rollback.sql`,
    next_prompt: nextPrompt,
    status: blockers.length ? "FAIL" : "PASS",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
  if (blockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
