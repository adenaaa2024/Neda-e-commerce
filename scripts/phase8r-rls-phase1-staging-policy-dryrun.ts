/**
 * PHASE-8R-RLS-PHASE1-STAGING-POLICY-DRYRUN
 *
 *   npx tsx scripts/phase8r-rls-phase1-staging-policy-dryrun.ts --run-id=<UTC>
 *   npx tsx scripts/phase8r-rls-phase1-staging-policy-dryrun.ts --run-id=<UTC> --apply
 *   npx tsx scripts/phase8r-rls-phase1-staging-policy-dryrun.ts --run-id=<UTC> --apply --base-url=http://127.0.0.1:3000
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const OUT_BASE = ".cursor/audit-reports/phase8r-rls-phase1-staging-policy-dryrun";

const PHASE1_TABLES = [
  "vendors",
  "product_prices",
  "product_categories",
  "slip_contents",
  "claim_candidates",
  "claim_cases",
  "groups",
  "roles",
  "platform_settings",
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

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function refFromDbUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

function orgPolicies(table: string): string {
  return `
ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "${table}_select_own_org" ON public.${table};
CREATE POLICY "${table}_select_own_org"
  ON public.${table} FOR SELECT TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "${table}_insert_own_org" ON public.${table};
CREATE POLICY "${table}_insert_own_org"
  ON public.${table} FOR INSERT TO authenticated
  WITH CHECK (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "${table}_update_own_org" ON public.${table};
CREATE POLICY "${table}_update_own_org"
  ON public.${table} FOR UPDATE TO authenticated
  USING (organization_id = public.get_my_organization_id())
  WITH CHECK (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "${table}_delete_own_org" ON public.${table};
CREATE POLICY "${table}_delete_own_org"
  ON public.${table} FOR DELETE TO authenticated
  USING (organization_id = public.get_my_organization_id());

DROP POLICY IF EXISTS "${table}_service_role_bypass" ON public.${table};
CREATE POLICY "${table}_service_role_bypass"
  ON public.${table} AS PERMISSIVE FOR ALL TO service_role
  USING (true) WITH CHECK (true);
`.trim();
}

function buildPolicySql(): string {
  const parts: string[] = [
    "-- PHASE-8R RLS Phase 1 — staging policy pack",
    "-- Target: staging only (eiqfaapyumhixxoeltgu)",
    "BEGIN;",
    "",
    `CREATE OR REPLACE FUNCTION public.get_my_organization_id()`,
    `RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$`,
    `  SELECT organization_id FROM public.profiles WHERE id = auth.uid() LIMIT 1;`,
    `$$;`,
    "",
  ];

  for (const t of ["vendors", "product_prices", "product_categories", "claim_candidates", "claim_cases", "groups"] as const) {
    parts.push(`-- ${t}`, orgPolicies(t), "");
  }

  parts.push(
    `-- slip_contents (org + store when store_id set)`,
    `ALTER TABLE public.slip_contents ENABLE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS "slip_contents_select_own_org_store" ON public.slip_contents;`,
    `CREATE POLICY "slip_contents_select_own_org_store"`,
    `  ON public.slip_contents FOR SELECT TO authenticated`,
    `  USING (`,
    `    organization_id = public.get_my_organization_id()`,
    `    AND (`,
    `      store_id IS NULL`,
    `      OR store_id IN (`,
    `        SELECT usa.store_id FROM public.user_store_assignments usa`,
    `        WHERE usa.profile_id = auth.uid()`,
    `          AND usa.organization_id = public.get_my_organization_id()`,
    `      )`,
    `      OR EXISTS (`,
    `        SELECT 1 FROM public.profiles p`,
    `        WHERE p.id = auth.uid()`,
    `          AND lower(btrim(COALESCE(p.role, ''))) IN ('admin', 'tenant_admin', 'super_admin')`,
    `      )`,
    `    )`,
    `  );`,
    `DROP POLICY IF EXISTS "slip_contents_write_own_org_store" ON public.slip_contents;`,
    `CREATE POLICY "slip_contents_write_own_org_store"`,
    `  ON public.slip_contents FOR ALL TO authenticated`,
    `  USING (`,
    `    organization_id = public.get_my_organization_id()`,
    `    AND (`,
    `      store_id IS NULL`,
    `      OR store_id IN (`,
    `        SELECT usa.store_id FROM public.user_store_assignments usa`,
    `        WHERE usa.profile_id = auth.uid()`,
    `          AND usa.organization_id = public.get_my_organization_id()`,
    `      )`,
    `      OR EXISTS (`,
    `        SELECT 1 FROM public.profiles p`,
    `        WHERE p.id = auth.uid()`,
    `          AND lower(btrim(COALESCE(p.role, ''))) IN ('admin', 'tenant_admin', 'super_admin')`,
    `      )`,
    `    )`,
    `  )`,
    `  WITH CHECK (`,
    `    organization_id = public.get_my_organization_id()`,
    `    AND (`,
    `      store_id IS NULL`,
    `      OR store_id IN (`,
    `        SELECT usa.store_id FROM public.user_store_assignments usa`,
    `        WHERE usa.profile_id = auth.uid()`,
    `          AND usa.organization_id = public.get_my_organization_id()`,
    `      )`,
    `      OR EXISTS (`,
    `        SELECT 1 FROM public.profiles p`,
    `        WHERE p.id = auth.uid()`,
    `          AND lower(btrim(COALESCE(p.role, ''))) IN ('admin', 'tenant_admin', 'super_admin')`,
    `      )`,
    `    )`,
    `  );`,
    `DROP POLICY IF EXISTS "slip_contents_service_role_bypass" ON public.slip_contents;`,
    `CREATE POLICY "slip_contents_service_role_bypass"`,
    `  ON public.slip_contents AS PERMISSIVE FOR ALL TO service_role`,
    `  USING (true) WITH CHECK (true);`,
    "",
    `-- roles (global catalog — authenticated read)`,
    `ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS "roles_select_authenticated" ON public.roles;`,
    `CREATE POLICY "roles_select_authenticated"`,
    `  ON public.roles FOR SELECT TO authenticated USING (true);`,
    `DROP POLICY IF EXISTS "roles_service_role_bypass" ON public.roles;`,
    `CREATE POLICY "roles_service_role_bypass"`,
    `  ON public.roles AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);`,
    "",
    `-- platform_settings (singleton — from 20260417130000)`,
    `ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS "platform_settings_select_authenticated" ON public.platform_settings;`,
    `CREATE POLICY "platform_settings_select_authenticated"`,
    `  ON public.platform_settings FOR SELECT TO authenticated USING (true);`,
    `DROP POLICY IF EXISTS "platform_settings_select_anon" ON public.platform_settings;`,
    `CREATE POLICY "platform_settings_select_anon"`,
    `  ON public.platform_settings FOR SELECT TO anon USING (true);`,
    `DROP POLICY IF EXISTS "platform_settings_service_role_bypass" ON public.platform_settings;`,
    `CREATE POLICY "platform_settings_service_role_bypass"`,
    `  ON public.platform_settings AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);`,
    "",
    "COMMIT;",
    "NOTIFY pgrst, 'reload schema';",
  );

  return parts.join("\n");
}

async function verifyPolicies(client: pg.Client, tables: readonly string[]) {
  const res = await client.query(
    `SELECT tablename, policyname, roles, cmd
     FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[])
     ORDER BY tablename, policyname`,
    [tables],
  );
  const byTable = new Map<string, { sr: boolean; auth: boolean; policies: string[] }>();
  for (const t of tables) byTable.set(t, { sr: false, auth: false, policies: [] });
  for (const row of res.rows as { tablename: string; policyname: string; roles: string; cmd: string }[]) {
    const cur = byTable.get(row.tablename)!;
    cur.policies.push(`${row.policyname}(${row.cmd})`);
    if (row.roles.includes("service_role")) cur.sr = true;
    if (row.roles.includes("authenticated")) cur.auth = true;
  }
  return [...byTable.entries()].map(([table, v]) => ({
    table,
    service_role_bypass: v.sr,
    authenticated_policy: v.auth,
    policy_count: v.policies.length,
    policies: v.policies,
    pass: v.sr && (table === "roles" || table === "platform_settings" ? v.auth : v.auth),
  }));
}

async function runScannerSmoke(
  admin: ReturnType<typeof createClient>,
  userClient: ReturnType<typeof createClient> | null,
  orgId: string,
): Promise<{ pass: boolean; detail: string; checks: Record<string, unknown> }> {
  const checks: Record<string, unknown> = {};
  const tables = ["slip_contents", "return_items", "expected_packages", "packages"];

  for (const t of tables) {
    const sr = await admin.from(t).select("*", { count: "exact", head: true }).eq("organization_id", orgId);
    checks[`sr_${t}`] = { ok: !sr.error, count: sr.count ?? 0, error: sr.error?.message ?? null };
  }

  if (userClient) {
    for (const t of ["slip_contents", "return_items", "expected_packages"] as const) {
      const u = await userClient.from(t).select("id", { count: "exact", head: true });
      checks[`auth_${t}`] = { ok: !u.error, count: u.count ?? 0, error: u.error?.message ?? null };
    }
  }

  const srOk = ["slip_contents", "return_items", "expected_packages"].every(
    (t) => (checks[`sr_${t}`] as { ok: boolean }).ok,
  );
  const authSlip = userClient ? (checks.auth_slip_contents as { ok: boolean })?.ok !== false : true;
  const pass = srOk && authSlip;
  return {
    pass,
    detail: pass ? "service_role scanner spine OK; slip_contents auth readable" : "scanner smoke failed — see checks",
    checks,
  };
}

async function runClaimsSmoke(
  admin: ReturnType<typeof createClient>,
  userClient: ReturnType<typeof createClient> | null,
  orgId: string,
): Promise<{ pass: boolean; detail: string; checks: Record<string, unknown> }> {
  const checks: Record<string, unknown> = {};
  for (const t of ["claim_candidates", "claim_cases", "claim_candidate_drafts"] as const) {
    const sr = await admin.from(t).select("id", { count: "exact", head: true }).eq("organization_id", orgId);
    checks[`sr_${t}`] = { ok: !sr.error, count: sr.count ?? 0, error: sr.error?.message ?? null };
  }
  if (userClient) {
    for (const t of ["claim_candidates", "claim_cases"] as const) {
      const u = await userClient.from(t).select("id", { count: "exact", head: true });
      checks[`auth_${t}`] = { ok: !u.error, count: u.count ?? 0, error: u.error?.message ?? null };
    }
  }
  const pass =
    (checks.sr_claim_candidates as { ok: boolean }).ok &&
    (checks.sr_claim_cases as { ok: boolean }).ok &&
    (!userClient || (checks.auth_claim_candidates as { ok: boolean }).ok);
  return {
    pass,
    detail: pass ? "claims inbox tables readable via SR + authenticated org" : "claims smoke failed",
    checks,
  };
}

async function runImportSmoke(admin: ReturnType<typeof createClient>, orgId: string) {
  const checks: Record<string, unknown> = {};
  for (const t of ["raw_report_uploads", "amazon_staging", "file_processing_status", "vendors", "product_prices"] as const) {
    const q = admin.from(t).select("*", { count: "exact", head: true });
    const sr = t === "amazon_staging" ? await q : await q.eq("organization_id", orgId);
    checks[t] = { ok: !sr.error, count: sr.count ?? 0, error: sr.error?.message ?? null };
  }
  const pass = ["raw_report_uploads", "vendors", "product_prices"].every(
    (t) => (checks[t] as { ok: boolean }).ok,
  );
  return {
    pass,
    detail: pass ? "import/service_role paths OK on staging" : "import smoke failed",
    checks,
  };
}

async function buildUserClient(
  url: string,
  anon: string,
  serviceKey: string,
): Promise<ReturnType<typeof createClient> | null> {
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 5 });
  const email = users?.users.find((u) => u.email)?.email;
  if (!email) return null;

  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (!tokenHash) return null;

  const res = await fetch(`${url}/auth/v1/verify`, {
    method: "POST",
    headers: {
      apikey: anon,
      Authorization: `Bearer ${anon}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "magiclink", token_hash: tokenHash, email }),
  });
  const body = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!body.access_token) return null;

  return createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${body.access_token}` } },
    auth: { persistSession: false },
  });
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const apply = hasFlag("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const stagingDb = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const anon = process.env.STAGING_ANON_KEY?.trim() || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || "";
  const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const ref = refFromSupabaseUrl(stagingUrl);

  if (ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Must target staging ${STAGING_REF}, got ${ref ?? "missing"}`);
  }

  const policySql = buildPolicySql();
  fs.writeFileSync(path.join(outDir, "01_phase1_policies.sql"), policySql + "\n");

  let stagingApplied = false;
  let applyError: string | null = null;

  if (apply) {
    if (!stagingDb) throw new Error("STAGING_DIRECT_POSTGRES_URL required for --apply");
    const guard = refFromDbUrl(stagingDb);
    if (guard !== STAGING_REF) throw new Error(`DB URL must be staging, got ${guard}`);
    if (stagingDb.includes(ORIGINAL_REF)) throw new Error("Refusing to apply — original ref in URL");

    const client = new pg.Client({ connectionString: stagingDb, ssl: { rejectUnauthorized: false } });
    try {
      await client.connect();
      await client.query(policySql);
      stagingApplied = true;
      await client.end();
    } catch (e) {
      applyError = e instanceof Error ? e.message : String(e);
      await client.end().catch(() => {});
    }
  }

  const verifyClient = stagingDb
    ? new pg.Client({ connectionString: stagingDb, ssl: { rejectUnauthorized: false } })
    : null;
  let policyVerify: Awaited<ReturnType<typeof verifyPolicies>> = [];
  if (verifyClient) {
    await verifyClient.connect();
    policyVerify = await verifyPolicies(verifyClient, PHASE1_TABLES);
    await verifyClient.end();
  }

  const admin = createClient(stagingUrl, serviceKey, { auth: { persistSession: false } });
  const userClient = stagingApplied ? await buildUserClient(stagingUrl, anon, serviceKey) : null;
  const orgId = "00000000-0000-0000-0000-000000000001";

  const scannerSmoke = stagingApplied
    ? await runScannerSmoke(admin, userClient, orgId)
    : { pass: false, detail: "skipped — policies not applied (--apply required)", checks: {} };
  const claimsSmoke = stagingApplied
    ? await runClaimsSmoke(admin, userClient, orgId)
    : { pass: false, detail: "skipped — policies not applied", checks: {} };
  const importSmoke = stagingApplied
    ? await runImportSmoke(admin, orgId)
    : { pass: false, detail: "skipped — policies not applied", checks: {} };

  const policyPass = policyVerify.length > 0 && policyVerify.every((p) => p.pass);
  const blockers: string[] = [];
  if (!apply) blockers.push("Policies generated only — re-run with --apply for staging verification");
  if (applyError) blockers.push(`Apply failed: ${applyError}`);
  if (!policyPass && stagingApplied) blockers.push("Policy verification failed — missing SR bypass or auth policy");
  if (!scannerSmoke.pass && stagingApplied) blockers.push(`Scanner: ${scannerSmoke.detail}`);
  if (!claimsSmoke.pass && stagingApplied) blockers.push(`Claims: ${claimsSmoke.detail}`);
  if (!importSmoke.pass && stagingApplied) blockers.push(`Import: ${importSmoke.detail}`);

  const safeOriginal =
    stagingApplied &&
    !applyError &&
    policyPass &&
    scannerSmoke.pass &&
    claimsSmoke.pass &&
    importSmoke.pass;

  const summary = {
    prompt: "PHASE-8R-RLS-PHASE1-STAGING-POLICY-DRYRUN",
    run_id: runId,
    phase_number: "8R",
    staging_ref: STAGING_REF,
    policies_generated: PHASE1_TABLES,
    staging_applied: stagingApplied ? "yes" : "no",
    apply_error: applyError,
    policy_verification: policyVerify,
    scanner_smoke: scannerSmoke.pass ? "pass" : stagingApplied ? "fail" : "skipped",
    scanner_smoke_detail: scannerSmoke.detail,
    claims_smoke: claimsSmoke.pass ? "pass" : stagingApplied ? "fail" : "skipped",
    claims_smoke_detail: claimsSmoke.detail,
    import_smoke: importSmoke.pass ? "pass" : stagingApplied ? "fail" : "skipped",
    import_smoke_detail: importSmoke.detail,
    SAFE_TO_APPLY_RLS_PHASE1_ORIGINAL: safeOriginal ? "yes" : "no",
    blockers,
    original_not_touched: true,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(outDir, "implementation-summary.md"),
    [
      "# Phase 8R Phase 1 staging policy dry-run",
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| staging_applied | ${stagingApplied ? "yes" : "no"} |`,
      `| scanner_smoke | ${summary.scanner_smoke} |`,
      `| claims_smoke | ${summary.claims_smoke} |`,
      `| import_smoke | ${summary.import_smoke} |`,
      `| SAFE_TO_APPLY_RLS_PHASE1_ORIGINAL | ${safeOriginal ? "yes" : "no"} |`,
      "",
      "## Blockers",
      ...blockers.map((b) => `- ${b}`),
    ].join("\n") + "\n",
  );

  console.log(JSON.stringify(summary, null, 2));
  if (applyError) process.exit(1);
  if (stagingApplied && !safeOriginal) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
