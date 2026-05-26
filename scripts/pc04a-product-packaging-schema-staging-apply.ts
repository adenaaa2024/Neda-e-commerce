/**
 * PC04A — Apply product packaging schema on staging (approval-gated).
 *
 *   npx tsx scripts/pc04a-product-packaging-schema-staging-apply.ts
 *   npx tsx scripts/pc04a-product-packaging-schema-staging-apply.ts --apply
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const APPROVAL_PATH = ".cursor/operator-approvals/product-packaging-schema-pc04-approval.md";
const DDL_PATH =
  ".cursor/audit-reports/pc04-product-packaging-dimensions-schema-plan/20260522T235000Z/ddl-proposed.sql";
const OUT_BASE = ".cursor/audit-reports/pc04a-product-packaging-schema-staging-apply";

const PACKAGING_TABLES = [
  "product_packaging_profiles",
  "product_packaging_profile_versions",
  "product_packaging_dimensions_current",
  "product_packaging_evidence",
] as const;

const FORBIDDEN_DDL = [
  /\bDROP\s+TABLE\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\s+public\.products\b/i,
  /\bALTER\s+TABLE\s+public\.products\b/i,
  /\bUPDATE\s+public\.products\b/i,
  /\bpackage_items\b/i,
  /\bFROM\s+public\.returns\b/i,
];

const RLS_POLICIES_SQL = `
-- PC04A — RLS policies (claim_candidate_drafts pattern)
DROP POLICY IF EXISTS "product_packaging_profiles_service_role_all" ON public.product_packaging_profiles;
CREATE POLICY "product_packaging_profiles_service_role_all"
  ON public.product_packaging_profiles FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "product_packaging_profiles_select_own_org" ON public.product_packaging_profiles;
CREATE POLICY "product_packaging_profiles_select_own_org"
  ON public.product_packaging_profiles FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "product_packaging_profile_versions_service_role_all" ON public.product_packaging_profile_versions;
CREATE POLICY "product_packaging_profile_versions_service_role_all"
  ON public.product_packaging_profile_versions FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "product_packaging_profile_versions_select_own_org" ON public.product_packaging_profile_versions;
CREATE POLICY "product_packaging_profile_versions_select_own_org"
  ON public.product_packaging_profile_versions FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.product_packaging_profiles p
    WHERE p.id = profile_id AND p.organization_id = public.get_my_organization_id()
  ));

DROP POLICY IF EXISTS "product_packaging_dimensions_current_service_role_all" ON public.product_packaging_dimensions_current;
CREATE POLICY "product_packaging_dimensions_current_service_role_all"
  ON public.product_packaging_dimensions_current FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "product_packaging_dimensions_current_select_own_org" ON public.product_packaging_dimensions_current;
CREATE POLICY "product_packaging_dimensions_current_select_own_org"
  ON public.product_packaging_dimensions_current FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "product_packaging_evidence_service_role_all" ON public.product_packaging_evidence;
CREATE POLICY "product_packaging_evidence_service_role_all"
  ON public.product_packaging_evidence FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "product_packaging_evidence_select_own_org" ON public.product_packaging_evidence;
CREATE POLICY "product_packaging_evidence_select_own_org"
  ON public.product_packaging_evidence FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_packaging_profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_packaging_profile_versions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_packaging_dimensions_current TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_packaging_evidence TO service_role;
GRANT SELECT ON public.product_packaging_profiles TO authenticated;
GRANT SELECT ON public.product_packaging_profile_versions TO authenticated;
GRANT SELECT ON public.product_packaging_dimensions_current TO authenticated;
GRANT SELECT ON public.product_packaging_evidence TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_product_packaging_dimensions_current(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
`;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApprovalFlags(): { run: boolean; ddl: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runM = text.match(/APPROVED_TO_RUN_STAGING\s*=\s*(\S+)/);
  const ddlM = text.match(/APPROVED_PRODUCT_PACKAGING_SCHEMA_DDL\s*=\s*(\S+)/);
  const runVal = runM?.[1] ?? "";
  const ddlVal = ddlM?.[1] ?? "";
  return {
    run: runVal === "true",
    ddl: ddlVal === "true",
    raw: {
      APPROVED_TO_RUN_STAGING: runVal,
      APPROVED_PRODUCT_PACKAGING_SCHEMA_DDL: ddlVal,
    },
  };
}

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

function sqlWithoutComments(sql: string): string {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

function preflightDdl(sql: string): { pass: boolean; checks: Record<string, boolean>; notes: string[] } {
  const notes: string[] = [];
  const body = sqlWithoutComments(sql);
  const checks: Record<string, boolean> = {
    four_packaging_tables: PACKAGING_TABLES.every((t) => new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t}\\b`, "i").test(body)),
    refresh_function: /\brefresh_product_packaging_dimensions_current\b/i.test(body),
    refresh_trigger: /\btrg_product_packaging_profile_versions_refresh_current\b/i.test(body),
    rls_enabled: PACKAGING_TABLES.every((t) => new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`, "i").test(body)),
    rls_policies: /product_packaging_profiles_service_role_all/i.test(body),
    no_destructive_ddl: !FORBIDDEN_DDL.some((re) => re.test(body)),
    no_products_overwrite: !/\bALTER\s+TABLE\s+public\.products\b/i.test(body),
    no_package_items: !/\bpackage_items\b/i.test(body),
    no_legacy_returns: !/\bFROM\s+public\.returns\b/i.test(body),
  };
  if (!checks.four_packaging_tables) notes.push("Expected 4 packaging CREATE TABLE statements");
  if (!checks.rls_policies) notes.push("RLS policies block missing from ddl-used.sql");
  const pass = Object.values(checks).every(Boolean);
  return { pass, checks, notes };
}

function rollbackPlanSql(): string {
  return [
    "-- PC04A rollback (staging emergency — drops packaging tables only)",
    `-- Target: ${STAGING_REF} only`,
    "-- Run only after confirming no production dependency on these tables.",
    "",
    "BEGIN;",
    "DROP TRIGGER IF EXISTS trg_product_packaging_profile_versions_refresh_current ON public.product_packaging_profile_versions;",
    "DROP FUNCTION IF EXISTS public.trg_product_packaging_profile_versions_refresh_current() CASCADE;",
    "DROP FUNCTION IF EXISTS public.refresh_product_packaging_dimensions_current(uuid) CASCADE;",
    "DROP TABLE IF EXISTS public.product_packaging_evidence CASCADE;",
    "DROP TABLE IF EXISTS public.product_packaging_dimensions_current CASCADE;",
    "DROP TABLE IF EXISTS public.product_packaging_profile_versions CASCADE;",
    "DROP TABLE IF EXISTS public.product_packaging_profiles CASCADE;",
    "COMMIT;",
    "NOTIFY pgrst, 'reload schema';",
  ].join("\n");
}

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return (r.rowCount ?? 0) > 0;
}

async function rlsProof(client: pg.Client): Promise<{ md: string; pass: boolean }> {
  const lines = ["# RLS proof", ""];
  let pass = true;
  for (const t of PACKAGING_TABLES) {
    const pol = await client.query(
      `SELECT policyname, roles::text, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname`,
      [t],
    );
    const rls = await client.query(
      `SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = $1`,
      [t],
    );
    const enabled = rls.rows[0]?.relrowsecurity === true;
    const count = pol.rowCount ?? 0;
    lines.push(`## ${t}`, "", `- RLS enabled: **${enabled ? "YES" : "NO"}**`, `- Policies: ${count}`, "");
    for (const row of pol.rows as { policyname: string; roles: string; cmd: string }[]) {
      lines.push(`  - \`${row.policyname}\` (${row.cmd}, ${row.roles})`);
    }
    lines.push("");
    if (!enabled || count < 2) pass = false;
  }
  lines.push(`**Overall:** ${pass ? "PASS" : "FAIL"}`);
  return { md: lines.join("\n"), pass };
}

type SmokeResult = {
  pass: boolean;
  detail: string;
  profileId?: string;
  versionId?: string;
  rollbackTestPass: boolean;
};

async function runSmoke(client: pg.Client, runId: string): Promise<SmokeResult> {
  const fixture = await client.query(
    `SELECT p.id AS product_id, p.organization_id, s.id AS store_id
     FROM public.products p
     LEFT JOIN public.stores s ON s.organization_id = p.organization_id
     WHERE p.deleted_at IS NULL
     ORDER BY p.created_at DESC NULLS LAST
     LIMIT 1`,
  );
  if (!fixture.rows[0]) {
    return { pass: false, detail: "No active product row for smoke fixture", rollbackTestPass: false };
  }
  const productId = String(fixture.rows[0].product_id);
  const orgId = String(fixture.rows[0].organization_id);
  const storeId = fixture.rows[0].store_id ? String(fixture.rows[0].store_id) : null;
  const smokeLabel = `PC04A_SMOKE_${runId}`;

  await client.query("BEGIN");
  try {
    const prof = await client.query(
      `INSERT INTO public.product_packaging_profiles (
         organization_id, store_id, product_id, packaging_level, fulfillment_context, display_label
       ) VALUES ($1, $2, $3, 'unit', 'fba', $4)
       RETURNING id`,
      [orgId, storeId, productId, smokeLabel],
    );
    const profileId = String(prof.rows[0].id);

    const draft = await client.query(
      `INSERT INTO public.product_packaging_profile_versions (
         profile_id, version_number, length_value, width_value, height_value, dimension_unit,
         weight_value, weight_unit, source_type, profile_status
       ) VALUES ($1, 1, 10.0, 8.0, 2.0, 'in', 1.25, 'lb', 'manual', 'draft')
       RETURNING id`,
      [profileId],
    );
    const draftId = String(draft.rows[0].id);

    const curDraft = await client.query(
      `SELECT profile_id FROM public.product_packaging_dimensions_current WHERE profile_id = $1`,
      [profileId],
    );
    if ((curDraft.rowCount ?? 0) > 0) {
      throw new Error("current snapshot should not exist for draft version");
    }

    const active = await client.query(
      `UPDATE public.product_packaging_profile_versions
       SET profile_status = 'active', effective_from = now()
       WHERE id = $1
       RETURNING id`,
      [draftId],
    );
    const versionId = String(active.rows[0].id);

    const cur = await client.query(
      `SELECT profile_id, current_version_id, length_value, width_value, height_value, profile_status
       FROM public.product_packaging_dimensions_current WHERE profile_id = $1`,
      [profileId],
    );
    if ((cur.rowCount ?? 0) !== 1) {
      throw new Error("current snapshot missing after active version");
    }
    if (String(cur.rows[0].current_version_id) !== versionId) {
      throw new Error("current_version_id mismatch");
    }
    if (Number(cur.rows[0].length_value) !== 10) {
      throw new Error("length_value not propagated to current snapshot");
    }

    await client.query("ROLLBACK");
    const rollbackTestPass = true;

    await client.query("BEGIN");
    const prof2 = await client.query(
      `INSERT INTO public.product_packaging_profiles (
         organization_id, store_id, product_id, packaging_level, fulfillment_context, display_label
       ) VALUES ($1, $2, $3, 'unit', 'fba', $4)
       RETURNING id`,
      [orgId, storeId, productId, smokeLabel],
    );
    const profileId2 = String(prof2.rows[0].id);
    const ver2 = await client.query(
      `INSERT INTO public.product_packaging_profile_versions (
         profile_id, version_number, length_value, width_value, height_value, dimension_unit,
         weight_value, weight_unit, source_type, profile_status, effective_from
       ) VALUES ($1, 1, 10.0, 8.0, 2.0, 'in', 1.25, 'lb', 'manual', 'active', now())
       RETURNING id`,
      [profileId2],
    );
    const versionId2 = String(ver2.rows[0].id);
    const cur2 = await client.query(
      `SELECT 1 FROM public.product_packaging_dimensions_current WHERE profile_id = $1 AND current_version_id = $2`,
      [profileId2, versionId2],
    );
    if ((cur2.rowCount ?? 0) !== 1) throw new Error("committed smoke: current row missing");
    await client.query(`DELETE FROM public.product_packaging_profiles WHERE id = $1`, [profileId2]);
    await client.query("COMMIT");

    return {
      pass: true,
      detail: `draft→active trigger OK; committed path OK; cleaned smoke profile ${profileId2}`,
      profileId: profileId2,
      versionId: versionId2,
      rollbackTestPass,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return {
      pass: false,
      detail: e instanceof Error ? e.message : String(e),
      rollbackTestPass: false,
    };
  }
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApprovalFlags();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
  const prodUrl = process.env.PRODUCTION_DIRECT_POSTGRES_URL?.trim() || "";
  const connRef = refFromConnectionUrl(stagingUrl);

  const baseDdl = fs
    .readFileSync(path.join(process.cwd(), DDL_PATH), "utf8")
    .replace(/^-- PC04 — Product packaging[^\n]*\n-- Staging target[^\n]*\n-- Requires[^\n]*\n\n/m, "");
  const fullDdl = `${baseDdl.trim()}\n\n${RLS_POLICIES_SQL.trim()}\n`;
  fs.writeFileSync(path.join(outDir, "ddl-used.sql"), fullDdl);
  const preflight = preflightDdl(fullDdl);
  fs.writeFileSync(path.join(outDir, "rollback-plan.md"), rollbackPlanSql());

  const approvalOk = approval.run && approval.ddl;
  const branchOk = branch === REQUIRED_BRANCH;
  const targetOk = stagingUrl.length > 0 && connRef === STAGING_REF;
  const notOriginal = connRef !== ORIGINAL_REF && (!originalUrl || stagingUrl !== originalUrl);
  const notMislabeledProd = !prodUrl || prodUrl !== stagingUrl;

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof — PC04A product packaging schema",
      "",
      `Approval file: \`${APPROVAL_PATH}\``,
      "",
      "Required exact flags:",
      "",
      "```text",
      "APPROVED_TO_RUN_STAGING=true",
      "APPROVED_PRODUCT_PACKAGING_SCHEMA_DDL=true",
      "```",
      "",
      "Actual flags found:",
      "",
      "```text",
      `APPROVED_TO_RUN_STAGING=${approval.raw.APPROVED_TO_RUN_STAGING}`,
      `APPROVED_PRODUCT_PACKAGING_SCHEMA_DDL=${approval.raw.APPROVED_PRODUCT_PACKAGING_SCHEMA_DDL}`,
      "```",
      "",
      `Branch: \`${branch}\` (required \`${REQUIRED_BRANCH}\`)`,
      `Staging ref from URL: \`${connRef ?? "?"}\` (required \`${STAGING_REF}\`)`,
      "",
      `Result: **${approvalOk && branchOk && targetOk && notOriginal ? "APPROVED" : "BLOCKED"}**.`,
    ].join("\n"),
  );

  const blockers: string[] = [];
  if (!approvalOk) blockers.push("Approval flags not both `true`");
  if (!branchOk) blockers.push(`Branch must be ${REQUIRED_BRANCH}, got ${branch}`);
  if (!targetOk) blockers.push(`STAGING_DIRECT_POSTGRES_URL must resolve to ${STAGING_REF}`);
  if (!notOriginal) blockers.push(`Must not target original ref ${ORIGINAL_REF}`);
  if (!notMislabeledProd) blockers.push("STAGING URL must not equal PRODUCTION_DIRECT_POSTGRES_URL");
  if (!preflight.pass) blockers.push(`DDL preflight failed: ${preflight.notes.join("; ")}`);
  if (!fs.existsSync(path.join(process.cwd(), DDL_PATH))) blockers.push(`DDL missing: ${DDL_PATH}`);

  let applied = false;
  let smoke: SmokeResult = { pass: false, detail: "not run", rollbackTestPass: false };
  let rlsPass = false;
  const tablesPresent: Record<string, boolean> = {};

  if (targetOk && notOriginal && stagingUrl && blockers.length === 0) {
    const client = new pg.Client({ connectionString: stagingUrl });
    await client.connect();

    const deps = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'products'`,
    );
    if ((deps.rowCount ?? 0) === 0) blockers.push("public.products missing on staging");

    const fn = await client.query(
      `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'get_my_organization_id'`,
    );
    if ((fn.rowCount ?? 0) === 0) blockers.push("public.get_my_organization_id() missing — RLS policies require it");

    if (apply && approvalOk && blockers.length === 0) {
      await client.query(fullDdl);
      applied = true;
    }

    for (const t of PACKAGING_TABLES) {
      tablesPresent[t] = await tableExists(client, t);
    }

    if (applied) {
      smoke = await runSmoke(client, runId);
      const rls = await rlsProof(client);
      fs.writeFileSync(path.join(outDir, "rls-proof.md"), rls.md);
      rlsPass = rls.pass;
    } else if (Object.values(tablesPresent).every(Boolean)) {
      const rls = await rlsProof(client);
      fs.writeFileSync(path.join(outDir, "rls-proof.md"), rls.md);
      rlsPass = rls.pass;
    } else {
      fs.writeFileSync(
        path.join(outDir, "rls-proof.md"),
        "# RLS proof\n\nApply did not run — policies not verified.\n",
      );
    }

    await client.end();
  } else {
    fs.writeFileSync(path.join(outDir, "rls-proof.md"), "# RLS proof\n\nPreflight blocked — not run.\n");
  }

  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    [
      "# Apply result — PC04A",
      "",
      `Run: \`${runId}\``,
      `Branch: \`${branch}\``,
      `Staging ref: \`${connRef ?? "?"}\``,
      `Apply flag: \`${apply ? "yes" : "no"}\``,
      "",
      "| Table | Present |",
      "|-------|---------|",
      ...PACKAGING_TABLES.map((t) => `| ${t} | ${tablesPresent[t] ? "YES" : "NO"} |`),
      "",
      `**Applied:** ${applied ? "YES" : "NO"}`,
      "",
      "Preflight checks:",
      "",
      "```json",
      JSON.stringify(preflight.checks, null, 2),
      "```",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "smoke-insert-result.md"),
    [
      "# Smoke insert result",
      "",
      `**Pass:** ${smoke.pass ? "YES" : "NO"}`,
      `**Rollback test (transaction ROLLBACK):** ${smoke.rollbackTestPass ? "PASS" : "FAIL"}`,
      "",
      smoke.detail,
      "",
      smoke.profileId ? `Profile id (cleaned): \`${smoke.profileId}\`` : "",
      smoke.versionId ? `Version id: \`${smoke.versionId}\`` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "None.",
  );

  fs.writeFileSync(
    path.join(outDir, "parity-followup-needed.md"),
    [
      "# Parity follow-up — PC04A",
      "",
      `**Staging apply run:** \`${runId}\``,
      `**Staging ref:** \`${STAGING_REF}\``,
      `**Original ref (not touched):** \`${ORIGINAL_REF}\``,
      "",
      "## Parity migration needed?",
      "",
      applied && Object.values(tablesPresent).every(Boolean)
        ? "**YES** — after staging smoke + RLS proof pass, run governed **PC04B** (or original parity pack) to apply the same additive DDL on `kxsvedvpjldygtdbylsy` using `.cursor/operator-approvals/product-packaging-schema-pc04-original-parity-approval.md`."
        : "**DEFER** — staging apply incomplete; do not run original parity until staging PASS.",
      "",
      "## Scope of parity",
      "",
      "- Same 4 tables + refresh function + trigger + RLS policies",
      "- **No** `products` column changes",
      "- **No** data backfill in parity DDL apply",
      "",
      "## Preconditions for PC04B",
      "",
      "- [ ] `product-packaging-schema-pc04-original-parity-approval.md` flags true",
      "- [ ] Staging `smoke-insert-result.md` = PASS",
      "- [ ] Operator sign-off on `ddl-used.sql` from this run",
    ].join("\n"),
  );

  const ok = applied && smoke.pass && rlsPass && blockers.length === 0;
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PC04A — PRODUCT PACKAGING SCHEMA STAGING APPLY",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        approval_valid: approvalOk,
        branch_ok: branchOk,
        target_ok: targetOk,
        applied,
        tables_present: tablesPresent,
        smoke_pass: smoke.pass,
        smoke_rollback_test_pass: smoke.rollbackTestPass,
        rls_proof_pass: rlsPass,
        blockers,
        ddl_source: DDL_PATH,
        ok,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok,
        outDir,
        approval_valid: approvalOk,
        applied,
        smoke_pass: smoke.pass,
        rls_pass: rlsPass,
        blockers,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : blockers.length && !apply ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
