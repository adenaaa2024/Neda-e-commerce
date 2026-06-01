/**
 * CLAIM-CASE-EVIDENCE-FOUNDATION-SCHEMA-APPLY-STAGING — staging-only case/evidence migration.
 *
 *   npx tsx scripts/claim-case-evidence-schema-apply-staging.ts --apply [--run-id=<UTC_Z>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const APPROVAL_PATH = ".cursor/operator-approvals/claim-case-evidence-foundation-schema-approval.md";
const MIGRATION_FILE = "supabase/migrations/20260901120000_claim_case_evidence_foundation.sql";
const OUT_BASE = ".cursor/audit-reports/claim-case-evidence-schema-apply-staging";

const ROLLBACK_SQL = `-- Rollback: claim case/evidence foundation (staging only)
BEGIN;
ALTER TABLE public.claim_lines DROP COLUMN IF EXISTS scanner_issue_type;
ALTER TABLE public.claim_lines DROP COLUMN IF EXISTS claim_case_id;
DROP TABLE IF EXISTS public.claim_case_events CASCADE;
DROP TABLE IF EXISTS public.claim_evidence CASCADE;
DROP TABLE IF EXISTS public.claim_company_routing_rules CASCADE;
DROP TABLE IF EXISTS public.claim_sla_rules CASCADE;
DROP TABLE IF EXISTS public.claim_cases CASCADE;
-- Restore legacy filing table if renamed during apply:
-- ALTER TABLE public.claim_cases_legacy_filing_prefoundation RENAME TO claim_cases;
COMMIT;
NOTIFY pgrst, 'reload schema';
`;

const VERIFY_TABLES = [
  "claim_cases",
  "claim_evidence",
  "claim_company_routing_rules",
  "claim_sla_rules",
  "claim_case_events",
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
  const schema = /APPROVED_CLAIM_CASE_EVIDENCE_FOUNDATION_SCHEMA\s*=\s*true/i.test(text);
  return {
    valid: staging && schema,
    flags: {
      APPROVED_TO_RUN_STAGING: staging ? "true" : "false",
      APPROVED_CLAIM_CASE_EVIDENCE_FOUNDATION_SCHEMA: schema ? "true" : "false",
    },
  };
}

function refFromConnectionUrl(url: string): string | null {
  return refFromSupabaseUrl(url) ?? url.match(/\.([a-z]{20})\./i)?.[1]?.toLowerCase() ?? null;
}

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name=$1
     ) AS ok`,
    [table],
  );
  return Boolean((r.rows[0] as { ok: boolean }).ok);
}

async function isOperatorClaimCasesSchema(client: pg.Client): Promise<boolean> {
  return columnExists(client, "claim_cases", "claim_source");
}

async function reconcileLegacyClaimCases(client: pg.Client): Promise<string | null> {
  const exists = await tableExists(client, "claim_cases");
  if (!exists) return null;
  if (await isOperatorClaimCasesSchema(client)) return null;

  const c = await client.query(`SELECT COUNT(*)::int AS c FROM public.claim_cases`);
  const rows = (c.rows[0] as { c: number }).c;
  if (rows > 0) {
    return `Legacy claim_cases has ${rows} rows and incompatible schema — manual reconcile required`;
  }

  const legacyName = "claim_cases_legacy_filing_prefoundation";
  if (await tableExists(client, legacyName)) {
    return `Legacy rename target already exists: ${legacyName}`;
  }

  await client.query(`ALTER TABLE public.claim_cases RENAME TO ${legacyName}`);
  return null;
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
    blockers.push("Approval flags not both true — STOP (no migration applied)");
  }
  if (!fs.existsSync(path.join(process.cwd(), MIGRATION_FILE))) {
    blockers.push(`Migration file missing: ${MIGRATION_FILE}`);
  }

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const ref = refFromConnectionUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push(`Staging guard failed (expected ${STAGING_REF})`);
  }
  if (ref === ORIGINAL_REF) {
    blockers.push(`BLOCKED: connection targets original ref ${ORIGINAL_REF}`);
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
      `Migration: \`${MIGRATION_FILE}\``,
      `Branch: \`${branch}\``,
      `Staging ref: \`${STAGING_REF}\``,
      `Connection ref: \`${ref ?? "unset"}\``,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(path.join(outDir, "rollback.sql"), ROLLBACK_SQL);

  if (blockers.length || !apply) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      (blockers.length ? blockers : ["Pass --apply to execute migration"]).map((b) => `- ${b}`).join("\n") +
        "\n",
    );
    fs.writeFileSync(
      path.join(outDir, "migration-apply-result.md",
      ),
      `# Migration apply result\n\nApplied: **NO**\n`,
    );
    fs.writeFileSync(
      path.join(outDir, "schema-verify.md"),
      "# Schema verify\n\nSkipped — apply not run.\n",
    );
    const manifest = {
      prompt: "CLAIM-CASE-EVIDENCE-FOUNDATION-SCHEMA-APPLY-STAGING",
      run_id: runId,
      schema_applied: false,
      staging_ref_verified: ref === STAGING_REF,
      blockers,
      rollback_path: `${OUT_BASE}/${runId}/rollback.sql`,
      next_prompt:
        "Set APPROVED_TO_RUN_STAGING=true and APPROVED_CLAIM_CASE_EVIDENCE_FOUNDATION_SCHEMA=true in approval file, then re-run",
      status: blockers.length ? "BLOCKED" : "DRY_RUN_ONLY",
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify(manifest, null, 2));
    if (blockers.length) process.exit(1);
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const claimLinesExists = await tableExists(client, "claim_lines");
  if (!claimLinesExists) {
    blockers.push("Prerequisite: public.claim_lines missing on staging");
  }

  const evidenceBefore = await tableExists(client, "claim_evidence");
  const caseIdColBefore = await columnExists(client, "claim_lines", "claim_case_id");
  const scannerColBefore = await columnExists(client, "claim_lines", "scanner_issue_type");
  const fullyAppliedBefore = evidenceBefore && caseIdColBefore && scannerColBefore;

  let applyError: string | null = null;
  let applyMode: "executed" | "idempotent_verify_only" = "executed";
  let legacyReconcileNote: string | null = null;

  if (fullyAppliedBefore) {
    applyMode = "idempotent_verify_only";
  } else if (!blockers.length) {
    const reconcileErr = await reconcileLegacyClaimCases(client);
    if (reconcileErr) {
      blockers.push(reconcileErr);
    } else if (
      !(await tableExists(client, "claim_cases")) &&
      (await tableExists(client, "claim_cases_legacy_filing_prefoundation"))
    ) {
      legacyReconcileNote = "Renamed empty legacy claim_cases → claim_cases_legacy_filing_prefoundation";
    }

    if (!blockers.length) {
      const migrationSql = fs.readFileSync(path.join(process.cwd(), MIGRATION_FILE), "utf8");
      try {
        await client.query(migrationSql);
      } catch (e) {
        applyError = e instanceof Error ? e.message : String(e);
        blockers.push(`Migration apply failed: ${applyError}`);
      }
    }
  }

  const verify: Record<string, unknown> = {
    tables: {} as Record<string, boolean>,
    claim_lines_columns: {} as Record<string, boolean>,
  };

  if (!applyError && !blockers.some((b) => b.startsWith("Prerequisite"))) {
    for (const t of VERIFY_TABLES) {
      (verify.tables as Record<string, boolean>)[t] = await tableExists(client, t);
    }
    (verify.claim_lines_columns as Record<string, boolean>).claim_case_id = await columnExists(
      client,
      "claim_lines",
      "claim_case_id",
    );
    (verify.claim_lines_columns as Record<string, boolean>).scanner_issue_type = await columnExists(
      client,
      "claim_lines",
      "scanner_issue_type",
    );

    for (const t of VERIFY_TABLES) {
      if (!(verify.tables as Record<string, boolean>)[t]) {
        blockers.push(`Missing table after apply: ${t}`);
      }
    }
    if (!(verify.claim_lines_columns as Record<string, boolean>).claim_case_id) {
      blockers.push("Missing column: claim_lines.claim_case_id");
    }
    if (!(verify.claim_lines_columns as Record<string, boolean>).scanner_issue_type) {
      blockers.push("Missing column: claim_lines.scanner_issue_type");
    }

    const rls = await client.query(
      `SELECT c.relname, c.relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [["claim_cases", "claim_evidence", "claim_company_routing_rules", "claim_sla_rules", "claim_case_events"]],
    );
    verify.rls = Object.fromEntries(
      rls.rows.map((r: { relname: string; relrowsecurity: boolean }) => [r.relname, r.relrowsecurity]),
    );

    const counts: Record<string, number> = {};
    for (const t of ["claim_cases", "claim_evidence", "claim_lines"] as const) {
      if (await tableExists(client, t)) {
        const c = await client.query(`SELECT COUNT(*)::int AS c FROM public."${t}"`);
        counts[t] = (c.rows[0] as { c: number }).c;
      }
    }
    verify.row_counts = counts;
  }

  await client.end();

  fs.writeFileSync(
    path.join(outDir, "migration-apply-result.md"),
    [
      "# Migration apply result",
      "",
      `- **Migration:** \`${MIGRATION_FILE}\``,
      `- **Applied:** ${applyError ? "**FAILED**" : applyMode === "idempotent_verify_only" ? "**IDEMPOTENT (verify only)**" : "**SUCCESS**"}`,
      `- **Apply mode:** ${applyMode}`,
      `- **Staging ref:** \`${STAGING_REF}\``,
      legacyReconcileNote ? `- **Legacy reconcile:** ${legacyReconcileNote}` : "",
      applyError ? `- **Error:** \`${applyError}\`` : "",
      "",
      "No backfill. No TRID rows.",
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
    (blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "- None") + "\n",
  );

  const nextPrompt = blockers.length
    ? "CLAIM-CASE-EVIDENCE-FOUNDATION-SCHEMA-APPLY-STAGING — resolve apply failures and re-run"
    : "SCANNER-ISSUE-TO-CLAIM-AUTO-FLOW-IMPLEMENT — wire scanner save to claim_line + claim_case + claim_evidence";

  const manifest = {
    prompt: "CLAIM-CASE-EVIDENCE-FOUNDATION-SCHEMA-APPLY-STAGING",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    staging_ref_verified: ref === STAGING_REF,
    schema_applied: !applyError && blockers.length === 0,
    apply_mode: applyMode,
    objects: verify.tables ?? {},
    claim_lines_columns: verify.claim_lines_columns ?? {},
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
