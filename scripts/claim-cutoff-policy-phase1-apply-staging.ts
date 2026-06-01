/**
 * CLAIM-CUTOFF-POLICY-PHASE1-APPLY-STAGING — staging-only organization_settings.claim_policy DDL.
 *
 *   npx tsx scripts/claim-cutoff-policy-phase1-apply-staging.ts --apply [--run-id=<UTC_Z>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v3";
const APPROVAL_PATH = ".cursor/operator-approvals/claim-cutoff-policy-phase1-staging-approval.md";
const PLAN_DIR = ".cursor/audit-reports/claim-cutoff-policy-phase1-plan/20260529T200000Z";
const DDL_FILE = path.join(PLAN_DIR, "ddl-staging-draft.sql");
const OUT_BASE = ".cursor/audit-reports/claim-cutoff-policy-phase1-apply-staging";

const ROLLBACK_SQL = `-- Rollback: claim_policy column (staging only)
ALTER TABLE public.organization_settings DROP COLUMN IF EXISTS claim_policy;
NOTIFY pgrst, 'reload schema';
`;

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
  const cutoff = /APPROVED_CLAIM_CUTOFF_POLICY_PHASE1_STAGING\s*=\s*true/i.test(text);
  const targetRef = text.match(/TARGET_SUPABASE_REF\s*=\s*([a-z]{20})/i)?.[1]?.toLowerCase();
  const refOk = !targetRef || targetRef === STAGING_REF;
  return {
    valid: staging && cutoff && refOk,
    flags: {
      APPROVED_TO_RUN_STAGING: staging ? "true" : "false",
      APPROVED_CLAIM_CUTOFF_POLICY_PHASE1_STAGING: cutoff ? "true" : "false",
      TARGET_SUPABASE_REF: targetRef ?? "(not set)",
      TARGET_REF_MATCHES_STAGING: refOk ? "true" : "false",
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

  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH} (got ${branch})`);
  if (!approval.valid) blockers.push("Approval flags not satisfied — STOP");
  if (!fs.existsSync(path.join(process.cwd(), DDL_FILE))) blockers.push(`DDL missing: ${DDL_FILE}`);

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const ref = refFromConnectionUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    blockers.push(`Staging guard failed (expected ${STAGING_REF})`);
  }
  if (ref === ORIGINAL_REF) blockers.push(`BLOCKED: connection targets original ${ORIGINAL_REF}`);

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      `Path: \`${APPROVAL_PATH}\``,
      "",
      ...Object.entries(approval.flags).map(([k, v]) => `- ${k}: **${v}**`),
      "",
      `DDL: \`${DDL_FILE}\``,
      `Branch: \`${branch}\``,
    ].join("\n") + "\n",
  );
  fs.writeFileSync(path.join(outDir, "rollback.sql"), ROLLBACK_SQL);

  if (blockers.length || !apply) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      (blockers.length ? blockers : ["Pass --apply to execute DDL"]).map((b) => `- ${b}`).join("\n") + "\n",
    );
    fs.writeFileSync(path.join(outDir, "ddl-apply-result.md"), "# DDL apply result\n\nApplied: **NO**\n");
    fs.writeFileSync(path.join(outDir, "verification-result.md"), "# Verification\n\nSkipped.\n");
    const manifest = {
      prompt: "CLAIM-CUTOFF-POLICY-PHASE1-APPLY-STAGING",
      run_id: runId,
      ddl_applied: false,
      verification_pass: false,
      blockers: blockers.length ? blockers : ["dry_run_only"],
      exact_app_implement_prompt: "CLAIM-CUTOFF-POLICY-PHASE1-IMPLEMENT-APP",
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify(manifest, null, 2));
    process.exit(blockers.length ? 1 : 0);
  }

  const ddl = fs.readFileSync(path.join(process.cwd(), DDL_FILE), "utf8");
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const countsBefore: Record<string, number> = {};
  for (const t of ["claim_lines", "claim_cases", "claim_evidence", "expected_packages"] as const) {
    const reg = await client.query(`SELECT to_regclass($1) AS oid`, [`public.${t}`]);
    if (reg.rows[0]?.oid) {
      const c = await client.query(`SELECT COUNT(*)::bigint AS c FROM public.${t}`);
      countsBefore[t] = Number((c.rows[0] as { c: string }).c);
    }
  }

  const colBefore = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='organization_settings' AND column_name='claim_policy'
     ) AS ok`,
  );
  const hadColumn = Boolean((colBefore.rows[0] as { ok: boolean }).ok);

  let applyError: string | null = null;
  let applyMode: "executed" | "idempotent_verify_only" = hadColumn ? "idempotent_verify_only" : "executed";

  if (!hadColumn) {
    try {
      await client.query(ddl);
    } catch (e) {
      applyError = e instanceof Error ? e.message : String(e);
      blockers.push(`DDL apply failed: ${applyError}`);
    }
  }

  const verify: Record<string, unknown> = {};

  if (!applyError) {
    const col = await client.query(
      `SELECT column_name, data_type, column_default, is_nullable
       FROM information_schema.columns
       WHERE table_schema='public' AND table_name='organization_settings' AND column_name='claim_policy'`,
    );
    verify.column = col.rows[0] ?? null;

    const policies = await client.query(
      `SELECT organization_id, claim_policy, jsonb_typeof(claim_policy) AS policy_type
       FROM public.organization_settings
       ORDER BY organization_id
       LIMIT 20`,
    );
    verify.sample_policies = policies.rows;

    const allEmpty = await client.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE claim_policy = '{}'::jsonb) AS empty_count,
              COUNT(*) FILTER (WHERE claim_policy ? 'scan_go_live_date') AS with_scan_date,
              COUNT(*) FILTER (WHERE claim_policy ? 'claim_start_date') AS with_claim_date
       FROM public.organization_settings`,
    );
    verify.policy_distribution = allEmpty.rows[0];

    const constraint = await client.query(
      `SELECT conname FROM pg_constraint
       WHERE conname = 'organization_settings_claim_policy_is_object'`,
    );
    verify.check_constraint = constraint.rows.length > 0;

    const countsAfter: Record<string, number> = {};
    for (const t of Object.keys(countsBefore)) {
      const c = await client.query(`SELECT COUNT(*)::bigint AS c FROM public.${t}`);
      countsAfter[t] = Number((c.rows[0] as { c: string }).c);
    }
    verify.claim_table_counts_unchanged = Object.fromEntries(
      Object.entries(countsBefore).map(([t, before]) => [t, { before, after: countsAfter[t], delta: countsAfter[t] - before }]),
    );

    if (!verify.column) blockers.push("claim_policy column missing after apply");
    if (!verify.check_constraint) blockers.push("organization_settings_claim_policy_is_object constraint missing");
    const dist = verify.policy_distribution as { with_scan_date?: number; with_claim_date?: number };
    if ((dist.with_scan_date ?? 0) > 0 || (dist.with_claim_date ?? 0) > 0) {
      blockers.push("Unexpected seeded dates in claim_policy — should remain {} until app configure");
    }
    for (const [t, v] of Object.entries(verify.claim_table_counts_unchanged as Record<string, { delta: number }>)) {
      if (v.delta !== 0) blockers.push(`${t} row count changed during DDL (delta=${v.delta})`);
    }
  }

  await client.end();

  const verificationPass = blockers.length === 0 && !applyError;

  fs.writeFileSync(
    path.join(outDir, "ddl-apply-result.md"),
    [
      "# DDL apply result",
      "",
      `- **Applied:** ${applyError ? "**FAILED**" : applyMode === "idempotent_verify_only" ? "**IDEMPOTENT (verify only)**" : "**SUCCESS**"}`,
      `- **Mode:** ${applyMode}`,
      `- **Staging ref:** \`${STAGING_REF}\``,
      `- **Object:** \`organization_settings.claim_policy\` JSONB NOT NULL DEFAULT \`{}\``,
      applyError ? `- **Error:** \`${applyError}\`` : "",
      "",
      "No claim_lines/cases created. No expected_packages changes.",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "verification-result.md"),
    [
      "# Verification result",
      "",
      `**Pass:** ${verificationPass ? "YES" : "NO"}`,
      "",
      "## Checks",
      "",
      "- `claim_policy` column exists on `organization_settings`",
      "- Default `{}` for existing org rows (unset dates → auto-claims blocked at storage layer until app enforces)",
      "- CHECK `jsonb_typeof(claim_policy) = 'object'`",
      "- `claim_lines` / `claim_cases` / `claim_evidence` / `expected_packages` row counts unchanged",
      "- No `scan_go_live_date` / `claim_start_date` pre-seeded by DDL",
      "",
      "## Policy shape (app phase — not stored until Settings UI)",
      "",
      "Documented keys per plan: `schema_version`, `scan_go_live_date`, `claim_start_date`, `claim_eligibility_window_days`, `claim_grouping_policy`, `claim_hold_policy`",
      "",
      "```json",
      JSON.stringify(verify, null, 2),
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    (blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "- None") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "exact-next-prompts.md"),
    [
      "# Exact next prompt",
      "",
      "```",
      "CLAIM-CUTOFF-POLICY-PHASE1-IMPLEMENT-APP — wire organization_settings.claim_policy read/write in Settings + enforce cutoff in scanner promote / claim detection paths (staging deploy); do not enable CLAIM_SCANNER_AUTO_PROMOTE_ENABLED until operator sets scan_go_live_date and claim_start_date",
      "```",
    ].join("\n") + "\n",
  );

  const manifest = {
    prompt: "CLAIM-CUTOFF-POLICY-PHASE1-APPLY-STAGING",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    ddl_applied: !applyError,
    apply_mode: applyMode,
    verification_pass: verificationPass,
    blockers,
    rollback_path: `${OUT_BASE}/${runId}/rollback.sql`,
    exact_app_implement_prompt:
      "CLAIM-CUTOFF-POLICY-PHASE1-IMPLEMENT-APP — wire organization_settings.claim_policy read/write in Settings + enforce cutoff in scanner promote / claim detection paths (staging deploy); do not enable CLAIM_SCANNER_AUTO_PROMOTE_ENABLED until operator sets scan_go_live_date and claim_start_date",
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(verificationPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
