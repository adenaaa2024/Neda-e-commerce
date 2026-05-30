/**
 * DELETE-CASCADE-UNDO-V2-STAGING-DRYRUN — validate v2 packet vs staging (no apply)
 *
 *   npx tsx scripts/delete-cascade-undo-v2-staging-dryrun.ts --run-id=<UTC_Z>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v3";
const V2_PACKET = ".cursor/audit-reports/delete-cascade-draft-rpc-fix-plan/20260521T234500Z/fixed-draft-migration.sql";
const FIX_PLAN_RUN = "20260521T234500Z";
const ITEM_LEVEL_MIGRATION = "supabase/migrations/20260830120000_expected_receive_split_item_level.sql";
const OUT_BASE = ".cursor/audit-reports/delete-cascade-undo-v2-staging-dryrun";

const V2_OBJECTS = [
  "audit_events",
  "undo_snapshots",
  "restore_conflicts",
  "delete_pallet_cascade",
  "delete_package_cascade",
  "delete_return_item_with_expected_release",
  "move_return_item_parent",
  "restore_deleted_entity",
  "preview_restore_undo_batch",
  "apply_restore_undo_batch",
] as const;

const V2_HELPERS = [
  "_ops_undo_batch_start",
  "_ops_undo_capture",
  "_ops_expected_allocation_snapshot",
  "_ops_slip_refs_for_package",
  "_ops_active_claims_for_return_item",
  "_ops_require_permission",
  "_ops_log_audit_event",
] as const;

const V2_PERMISSIONS = [
  "ops.delete_pallet_cascade",
  "ops.delete_package_cascade",
  "ops.delete_return_item",
  "ops.move_return_item_parent",
  "ops.restore_deleted_entity",
  "ops.view_undo_history",
  "ops.preview_restore_undo_batch",
  "ops.apply_restore_undo_batch",
] as const;

const EXPECTED_RELEASE_ARGS =
  "p_return_item_id uuid, p_organization_id uuid, p_soft_delete boolean";
const EXPECTED_MOVE_PREFIX =
  "p_return_item_id uuid, p_organization_id uuid, p_store_id uuid, p_new_package_id uuid, p_new_receive_scope_key text";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function staticSqlChecks(sql: string): { pass: boolean; checks: Record<string, boolean>; warnings: string[] } {
  const warnings: string[] = [];
  const checks: Record<string, boolean> = {
    release_call_order: /release_expected_item_unit\(p_return_item_id,\s*p_organization_id,\s*false\)/.test(
      sql,
    ),
    move_call_includes_scope_key: sql.includes("p_new_receive_scope_key") && sql.includes("move_expected_item_unit("),
    preview_restore_defined: sql.includes("CREATE OR REPLACE FUNCTION public.preview_restore_undo_batch"),
    apply_restore_defined: sql.includes("CREATE OR REPLACE FUNCTION public.apply_restore_undo_batch"),
    retention_column: sql.includes("undo_snapshot_retention_days"),
    no_v1_wrong_release: !/release_expected_item_unit\(p_organization_id,\s*p_return_item_id\)/.test(sql),
    soft_delete_false_on_cascade_item: /delete_return_item_with_expected_release[\s\S]*?release_expected_item_unit\([\s\S]*?false\)/.test(
      sql,
    ),
  };
  if (sql.includes("ON CONFLICT DO NOTHING") && !sql.includes("UNIQUE INDEX") && !sql.includes("ON CONFLICT (")) {
    warnings.push(
      "preview_restore_undo_batch INSERT uses ON CONFLICT DO NOTHING without unique constraint on restore_conflicts — inserts may duplicate",
    );
  }
  if (!sql.includes("ops.preview_restore_undo_batch")) {
    warnings.push("missing permission seed ops.preview_restore_undo_batch");
  }
  const pass = Object.values(checks).every(Boolean);
  return { pass, checks, warnings };
}

async function stagingChecks(): Promise<{
  connected: boolean;
  checks: Record<string, string>;
  rpc_signatures: Array<{ proname: string; args: string; result: string }>;
}> {
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const checks: Record<string, string> = {};
  if (!dbUrl) {
    return { connected: false, checks: { db: "skipped" }, rpc_signatures: [] };
  }

  const ref = refFromSupabaseUrl(dbUrl);
  checks.db_ref = ref ?? "unknown";
  if (ref !== STAGING_REF) {
    checks.db_ref = `MISMATCH expected ${STAGING_REF} got ${ref}`;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const rpcRes = await client.query(
    `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
            pg_get_function_result(p.oid) AS result
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('release_expected_item_unit', 'move_expected_item_unit')
     ORDER BY 1, 2`,
  );

  for (const name of [...V2_OBJECTS, ...V2_HELPERS]) {
    const r = await client.query(
      `SELECT 1 FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = $1`,
      [name],
    );
    checks[`fn:${name}`] = r.rowCount ? "exists_already" : "not_present_ok";
  }

  for (const tbl of ["audit_events", "undo_snapshots", "restore_conflicts"] as const) {
    const r = await client.query(
      `SELECT 1 FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind = 'r'`,
      [tbl],
    );
    checks[`tbl:${tbl}`] = r.rowCount ? "exists_already" : "not_present_ok";
  }

  for (const col of ["deleted_at", "deleted_by", "undo_batch_id"] as const) {
    for (const tbl of ["pallets", "packages", "return_items"] as const) {
      const r = await client.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [tbl, col],
      );
      const key = `col:${tbl}.${col}`;
      if (!r.rowCount && col === "deleted_at") checks[key] = "MISSING_BLOCKER";
      else if (!r.rowCount) checks[key] = "migration_will_add";
      else checks[key] = col === "deleted_at" ? "present" : "present_or_add_if_not_exists";
    }
  }

  const ret = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organization_settings'
       AND column_name = 'undo_snapshot_retention_days'`,
  );
  checks["col:organization_settings.undo_snapshot_retention_days"] = ret.rowCount
    ? "present"
    : "migration_will_add_default_30";

  const cl = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'claim_lines'`,
  );
  checks.claim_lines = cl.rowCount ? "present" : "missing_warn_fallback_claim_submissions_only";

  const perms: string[] = [];
  for (const k of V2_PERMISSIONS) {
    const r = await client.query(`SELECT 1 FROM public.permissions WHERE key = $1`, [k]);
    checks[`perm:${k}`] = r.rowCount ? "exists" : "migration_seeds";
    if (!r.rowCount) perms.push(k);
  }

  const relRows = rpcRes.rows.filter((r) => (r as { proname: string }).proname === "release_expected_item_unit");
  const movRows = rpcRes.rows.filter((r) => (r as { proname: string }).proname === "move_expected_item_unit");

  const relMatch = relRows.find((r) => (r as { args: string }).args === EXPECTED_RELEASE_ARGS);
  const movMatch = movRows.find((r) => (r as { args: string }).args.startsWith(EXPECTED_MOVE_PREFIX));

  checks.release_overload_count = String(relRows.length);
  checks.move_overload_count = String(movRows.length);
  if (relMatch) checks.release_signature_match = "PASS (item-level overload present)";
  else {
    checks.release_signature_match = `FAIL — v2 needs ${EXPECTED_RELEASE_ARGS}; found: ${relRows.map((r) => (r as { args: string }).args).join(" | ") || "none"}`;
  }
  if (movMatch) checks.move_signature_match = "PASS (item-level overload present)";
  else {
    checks.move_signature_match = `FAIL — v2 needs prefix ${EXPECTED_MOVE_PREFIX}; found: ${movRows.map((r) => (r as { args: string }).args).join(" | ") || "none"}`;
  }
  if (relRows.length > 1) {
    checks.release_legacy_overload = "present (legacy overload coexists — v2 uses item-level only)";
  }

  await client.end();
  return {
    connected: true,
    checks,
    rpc_signatures: rpcRes.rows as Array<{ proname: string; args: string; result: string }>,
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const blockers: string[] = [];
  const warnings: string[] = [];

  let branch = "unknown";
  try {
    branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  } catch {
    blockers.push("Could not read git branch");
  }
  if (branch !== REQUIRED_BRANCH) {
    blockers.push(`Branch ${branch} !== ${REQUIRED_BRANCH}`);
  }

  const urlRef = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "");
  if (urlRef && urlRef !== STAGING_REF) {
    blockers.push(`NEXT_PUBLIC_SUPABASE_URL ref ${urlRef} !== staging ${STAGING_REF}`);
  }

  const v2Path = path.join(process.cwd(), V2_PACKET);
  if (!fs.existsSync(v2Path)) {
    blockers.push(`V2 packet missing: ${V2_PACKET}`);
  }
  if (!fs.existsSync(path.join(process.cwd(), ITEM_LEVEL_MIGRATION))) {
    blockers.push(`Prerequisite file missing: ${ITEM_LEVEL_MIGRATION}`);
  }

  const v2Sql = fs.readFileSync(v2Path, "utf8");
  fs.copyFileSync(v2Path, path.join(outDir, "fixed-draft-migration.sql"));

  const staticChecks = staticSqlChecks(v2Sql);
  fs.writeFileSync(path.join(outDir, "static-sql-checks.json"), JSON.stringify(staticChecks, null, 2));
  if (!staticChecks.pass) blockers.push("Static SQL signature pattern checks failed");
  warnings.push(...staticChecks.warnings);

  const staging = await stagingChecks();
  fs.writeFileSync(path.join(outDir, "staging-preflight.json"), JSON.stringify(staging, null, 2));

  if (!staging.connected) {
    warnings.push("STAGING_DIRECT_POSTGRES_URL unset — live preflight skipped");
  } else {
    if (staging.checks.release_signature_match?.startsWith("FAIL")) {
      blockers.push(`release_expected_item_unit signature: ${staging.checks.release_signature_match}`);
    }
    if (staging.checks.move_signature_match?.startsWith("FAIL")) {
      blockers.push(`move_expected_item_unit signature: ${staging.checks.move_signature_match}`);
    }
    if (staging.checks["fn:release_expected_item_unit"] === "exists_already") {
      /* prerequisite ok */
    } else if (staging.checks.release_signature_match?.includes("missing")) {
      blockers.push("release_expected_item_unit not on staging");
    }

    for (const tbl of ["audit_events", "undo_snapshots", "restore_conflicts"]) {
      if (staging.checks[`tbl:${tbl}`] === "exists_already") {
        warnings.push(`${tbl} already exists — partial v1 apply? review before v2 apply`);
      }
    }

    for (const key of Object.keys(staging.checks)) {
      if (staging.checks[key] === "MISSING_BLOCKER") blockers.push(`${key} missing on staging`);
    }
    if (staging.checks.claim_lines?.includes("missing")) {
      warnings.push("claim_lines table missing — claim gate uses claim_submissions fallback only");
    }
  }

  const approvalNeeded = [
    "Create `.cursor/operator-approvals/delete-cascade-undo-audit-v2-staging-approval.md` from fix-plan approval-template.md",
    "Set APPROVED_DELETE_CASCADE_UNDO_AUDIT_V2_MIGRATION=true in approval file",
    "Confirm no partial apply of v1 migration 20260901120000 on staging",
    "Post-apply: wire server actions to cascade RPCs (optional Phase 2 — app already soft-voids in TS)",
  ];

  const dryrunPass = blockers.length === 0;

  fs.writeFileSync(
    path.join(outDir, "DELETE_CASCADE_UNDO_V2_STAGING_DRYRUN.md"),
    [
      "# DELETE-CASCADE-UNDO-V2-STAGING-DRYRUN",
      "",
      `Run: \`${runId}\` · Branch: \`${branch}\` · Staging: \`${STAGING_REF}\``,
      "",
      "## Dry-run result",
      "",
      `**${dryrunPass ? "PASS" : "FAIL"}** (no migration applied)`,
      "",
      "## V2 packet",
      "",
      `- Source plan: \`delete-cascade-draft-rpc-fix-plan/${FIX_PLAN_RUN}/\``,
      `- SQL: \`fixed-draft-migration.sql\` (${v2Sql.length} bytes)`,
      `- Proposed apply path: \`supabase/migrations/20260902120000_delete_cascade_undo_audit_foundation_v2.sql\``,
      "",
      "## RPC signature validation (staging live)",
      "",
      "| RPC | Expected | Staging |",
      "|-----|----------|---------|",
      `| release_expected_item_unit | \`${EXPECTED_RELEASE_ARGS}\` | ${staging.checks.release_signature_match ?? "n/a"} |`,
      `| move_expected_item_unit | prefix \`${EXPECTED_MOVE_PREFIX}...\` | ${staging.checks.move_signature_match ?? "n/a"} |`,
      "",
      staging.rpc_signatures.length
        ? staging.rpc_signatures
            .map(
              (r) =>
                `- **${r.proname}**: \`${r.args}\` → \`${r.result}\``,
            )
            .join("\n")
        : "- (no DB connection)",
      "",
      "## Required objects preflight",
      "",
      "| Object | Pre-migration state |",
      "|--------|---------------------|",
      ...[...V2_OBJECTS, ...V2_HELPERS].map((o) => {
        const k = o.startsWith("_ops") || o.includes("cascade") || o.includes("restore") || o.includes("delete_") || o.includes("move_") || o.includes("preview") || o.includes("apply")
          ? `fn:${o}`
          : `fn:${o}`;
        return `| \`${o}\` | ${staging.checks[k] ?? "n/a"} |`;
      }),
      "",
      "| Table | State |",
      "|-------|-------|",
      ...["audit_events", "undo_snapshots", "restore_conflicts"].map(
        (t) => `| \`${t}\` | ${staging.checks[`tbl:${t}`] ?? "n/a"} |`,
      ),
      "",
      "## Retention",
      "",
      `- Column: \`organization_settings.undo_snapshot_retention_days\` → **${staging.checks["col:organization_settings.undo_snapshot_retention_days"] ?? "n/a"}**`,
      "- Default in v2 DDL: **30** days (constraint 1–365)",
      "",
      "## Static SQL checks",
      "",
      ...Object.entries(staticChecks.checks).map(([k, v]) => `- ${k}: **${v ? "ok" : "FAIL"}**`),
      "",
      "## Blockers",
      "",
      ...(blockers.length ? blockers.map((b) => `- ${b}`) : ["- None"]),
      "",
      "## Warnings",
      "",
      ...(warnings.length ? warnings.map((w) => `- ${w}`) : ["- None"]),
      "",
      "## Approval needed",
      "",
      ...approvalNeeded.map((a) => `- [ ] ${a}`),
      "",
      "## Exact staging apply prompt",
      "",
      "```text",
      "DELETE-CASCADE-UNDO-V2-STAGING-APPLY-EXECUTE",
      "```",
      "",
      "Prerequisites: this dryrun PASS + signed approval + copy packet to `supabase/migrations/20260902120000_delete_cascade_undo_audit_foundation_v2.sql`",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "approval-checklist.md"),
    [
      "# Approval checklist — delete cascade undo v2 (staging)",
      "",
      "## Preconditions",
      "",
      "- [ ] Dry-run PASS: `delete-cascade-undo-v2-staging-dryrun/" + runId + "`",
      "- [ ] `20260830120000_expected_receive_split_item_level` applied on staging",
      "- [ ] `NEDA-DELETE-MOVE-ALLOCATION-WIRE-PHASE1` complete (app soft-void paths)",
      "- [ ] No partial v1 undo tables from `20260901120000_delete_cascade_undo_audit_foundation.sql`",
      "",
      "## Sign-off",
      "",
      "```text",
      "APPROVED_DELETE_CASCADE_UNDO_AUDIT_V2_MIGRATION=true",
      "Approved by:",
      "UTC date:",
      "```",
      "",
      "## Post-apply verification",
      "",
      "- [ ] `npx tsx scripts/delete-cascade-undo-v2-staging-dryrun.ts` — objects show exists",
      "- [ ] Smoke: `delete_package_cascade` on disposable package → `undo_batch_id` set",
      "- [ ] `preview_restore_undo_batch` → `can_restore` / conflicts",
      "- [ ] `npm run test:expected-receive-delete-release` regression PASS",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    (blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "- None") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "DELETE-CASCADE-UNDO-V2-STAGING-DRYRUN",
        run_id: runId,
        dryrun_pass: dryrunPass,
        fix_plan_run: FIX_PLAN_RUN,
        staging_ref: STAGING_REF,
        branch,
        blockers,
        warnings,
        static_sql: staticChecks,
        staging_preflight: staging,
        approval_needed: approvalNeeded,
        exact_next_prompt: "DELETE-CASCADE-UNDO-V2-STAGING-APPLY-EXECUTE",
        db_mutated: false,
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ ok: dryrunPass, outDir, blockers, warnings }, null, 2));
  if (!dryrunPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
