/**
 * PHASE-8R-RLS-PHASE1-ORIGINAL-EXECUTE
 *
 *   npx tsx scripts/phase8r-rls-phase1-original-execute.ts --run-id=<UTC>
 *   npx tsx scripts/phase8r-rls-phase1-original-execute.ts --run-id=<UTC> --skip-build
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const APPROVAL_PATH = ".cursor/operator-approvals/phase8r-rls-phase1-original-approval.md";
const PREREQ_MANIFEST =
  ".cursor/audit-reports/phase8r-rls-phase1-staging-policy-dryrun/20260604T200000Z/manifest.json";
const POLICY_SQL_PATH =
  ".cursor/audit-reports/phase8r-rls-phase1-staging-policy-dryrun/20260604T200000Z/01_phase1_policies.sql";
const OUT_BASE = ".cursor/audit-reports/phase8r-rls-phase1-original-execute";

const TABLES_APPLIED = [
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

function refFromDbUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

function readApproval(): { ok: boolean; detail: string } {
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) return { ok: false, detail: "approval file missing" };
  const text = fs.readFileSync(p, "utf8");
  const run = /APPROVED_TO_RUN_ORIGINAL\s*=\s*true/i.test(text);
  const phase = /APPROVED_PHASE8R_RLS_PHASE1_ORIGINAL\s*=\s*true/i.test(text);
  const ref = text.match(/TARGET_SUPABASE_REF\s*=\s*(\S+)/)?.[1] ?? "";
  return {
    ok: run && phase && ref === ORIGINAL_REF,
    detail: `run=${run} phase=${phase} ref=${ref || "(unset)"}`,
  };
}

async function buildUserClient(url: string, anon: string, serviceKey: string) {
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 5 });
  const email = users?.users.find((u) => u.email)?.email;
  if (!email) return null;
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (!tokenHash) return null;
  const res = await fetch(`${url}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token_hash: tokenHash, email }),
  });
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) return null;
  return createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${body.access_token}` } },
    auth: { persistSession: false },
  });
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const skipBuild = process.argv.includes("--skip-build");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const blockers: string[] = [];
  const approval = readApproval();
  if (!approval.ok) blockers.push(`Approval blocked: ${approval.detail}`);

  const prereqPath = path.join(process.cwd(), PREREQ_MANIFEST);
  if (!fs.existsSync(prereqPath)) {
    blockers.push(`Prerequisite manifest missing: ${PREREQ_MANIFEST}`);
  } else {
    const prereq = JSON.parse(fs.readFileSync(prereqPath, "utf8")) as {
      SAFE_TO_APPLY_RLS_PHASE1_ORIGINAL?: string;
    };
    if (prereq.SAFE_TO_APPLY_RLS_PHASE1_ORIGINAL !== "yes") {
      blockers.push("Staging prerequisite SAFE_TO_APPLY_RLS_PHASE1_ORIGINAL != yes");
    }
  }

  const dbUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const supabaseUrl = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  const anon = process.env.ORIGINAL_ANON_KEY?.trim() ?? "";
  const serviceKey = process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ?? "";

  if (refFromDbUrl(dbUrl) !== ORIGINAL_REF) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL must target original ref");
  if (refFromSupabaseUrl(supabaseUrl) !== ORIGINAL_REF) blockers.push("ORIGINAL_SUPABASE_URL must target original ref");
  if (dbUrl.includes(STAGING_REF)) blockers.push("Refusing — staging ref in DB URL");

  const policyPath = path.join(process.cwd(), POLICY_SQL_PATH);
  if (!fs.existsSync(policyPath)) blockers.push(`Policy SQL missing: ${POLICY_SQL_PATH}`);

  let productionApplied = false;
  let applyError: string | null = null;

  if (blockers.length === 0) {
    let sql = fs.readFileSync(policyPath, "utf8");
    sql = sql.replace(/staging only \(eiqfaapyumhixxoeltgu\)/i, `original/production (${ORIGINAL_REF})`);
    fs.writeFileSync(path.join(outDir, "01_phase1_policies_applied.sql"), sql);

    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    try {
      await client.connect();
      await client.query(sql);
      productionApplied = true;
      await client.end();
    } catch (e) {
      applyError = e instanceof Error ? e.message : String(e);
      blockers.push(`Apply failed: ${applyError}`);
      await client.end().catch(() => {});
    }
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const userClient = productionApplied ? await buildUserClient(supabaseUrl, anon, serviceKey) : null;
  const orgId = "00000000-0000-0000-0000-000000000001";

  const scannerChecks: Record<string, unknown> = {};
  if (productionApplied) {
    for (const t of ["slip_contents", "return_items", "expected_packages", "packages"] as const) {
      const sr = await admin.from(t).select("*", { count: "exact", head: true }).eq("organization_id", orgId);
      scannerChecks[`sr_${t}`] = { ok: !sr.error, count: sr.count ?? 0, error: sr.error?.message ?? null };
    }
    if (userClient) {
      const u = await userClient.from("slip_contents").select("id", { count: "exact", head: true });
      scannerChecks.auth_slip_contents = { ok: !u.error, count: u.count ?? 0, error: u.error?.message ?? null };
    }
  }
  const scannerSmoke =
    productionApplied &&
    ["slip_contents", "return_items", "expected_packages"].every(
      (t) => (scannerChecks[`sr_${t}`] as { ok: boolean })?.ok,
    );

  const claimsChecks: Record<string, unknown> = {};
  if (productionApplied) {
    for (const t of ["claim_candidates", "claim_cases"] as const) {
      const sr = await admin.from(t).select("id", { count: "exact", head: true }).eq("organization_id", orgId);
      claimsChecks[`sr_${t}`] = { ok: !sr.error, count: sr.count ?? 0, error: sr.error?.message ?? null };
      if (userClient) {
        const u = await userClient.from(t).select("id", { count: "exact", head: true });
        claimsChecks[`auth_${t}`] = { ok: !u.error, count: u.count ?? 0, error: u.error?.message ?? null };
      }
    }
  }
  const claimsSmoke =
    productionApplied &&
    (claimsChecks.sr_claim_candidates as { ok: boolean })?.ok &&
    (claimsChecks.sr_claim_cases as { ok: boolean })?.ok;

  const importChecks: Record<string, unknown> = {};
  if (productionApplied) {
    for (const t of ["raw_report_uploads", "vendors", "product_prices", "amazon_staging"] as const) {
      const q = admin.from(t).select("*", { count: "exact", head: true });
      const sr = t === "amazon_staging" ? await q : await q.eq("organization_id", orgId);
      importChecks[t] = { ok: !sr.error, count: sr.count ?? 0, error: sr.error?.message ?? null };
    }
  }
  const importSmoke =
    productionApplied &&
    ["raw_report_uploads", "vendors", "product_prices"].every((t) => (importChecks[t] as { ok: boolean })?.ok);

  const automationChecks: Record<string, unknown> = {};
  if (productionApplied) {
    const srPlatform = await admin
      .from("platform_settings")
      .select("app_name, automation_settings, logo_url")
      .eq("id", true)
      .maybeSingle();
    automationChecks.sr_platform_settings = {
      ok: !srPlatform.error && !!srPlatform.data,
      error: srPlatform.error?.message ?? null,
      has_automation_settings: srPlatform.data?.automation_settings != null,
    };
    if (userClient) {
      const authPlatform = await userClient.from("platform_settings").select("app_name, automation_settings").eq("id", true).maybeSingle();
      automationChecks.auth_platform_settings = {
        ok: !authPlatform.error && !!authPlatform.data,
        error: authPlatform.error?.message ?? null,
      };
    }
    const srRoles = await admin.from("roles").select("id", { count: "exact", head: true });
    automationChecks.sr_roles = { ok: !srRoles.error, count: srRoles.count ?? 0 };
  }
  const automationSettingsSmoke =
    productionApplied &&
    (automationChecks.sr_platform_settings as { ok: boolean })?.ok &&
    (!userClient || (automationChecks.auth_platform_settings as { ok: boolean })?.ok);

  let buildResult = skipBuild ? "skipped" : "fail";
  if (productionApplied && !skipBuild) {
    try {
      execSync("npm run build", { cwd: process.cwd(), encoding: "utf8", stdio: "pipe", timeout: 600_000 });
      buildResult = "pass";
    } catch (e) {
      blockers.push(`Build failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
      buildResult = "fail";
    }
  }

  const safeForLive =
    productionApplied &&
    !applyError &&
    scannerSmoke &&
    claimsSmoke &&
    importSmoke &&
    automationSettingsSmoke &&
    (buildResult === "pass" || buildResult === "skipped");

  const summary = {
    prompt: "PHASE-8R-RLS-PHASE1-ORIGINAL-EXECUTE",
    run_id: runId,
    target_ref: ORIGINAL_REF,
    production_applied: productionApplied ? "yes" : "no",
    tables_applied: productionApplied ? [...TABLES_APPLIED] : [],
    apply_error: applyError,
    scanner_smoke: scannerSmoke ? "pass" : productionApplied ? "fail" : "skipped",
    scanner_checks: scannerChecks,
    claims_smoke: claimsSmoke ? "pass" : productionApplied ? "fail" : "skipped",
    claims_checks: claimsChecks,
    import_smoke: importSmoke ? "pass" : productionApplied ? "fail" : "skipped",
    import_checks: importChecks,
    automation_settings_smoke: automationSettingsSmoke ? "pass" : productionApplied ? "fail" : "skipped",
    automation_checks: automationChecks,
    build_result: buildResult,
    SAFE_FOR_LIVE_RLS_PHASE1: safeForLive ? "yes" : "no",
    blockers,
    staging_not_touched: true,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(outDir, "implementation-summary.md"),
    [
      "# Phase 8R Phase 1 original execute",
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| production_applied | ${productionApplied ? "yes" : "no"} |`,
      `| scanner_smoke | ${summary.scanner_smoke} |`,
      `| claims_smoke | ${summary.claims_smoke} |`,
      `| import_smoke | ${summary.import_smoke} |`,
      `| automation_settings_smoke | ${summary.automation_settings_smoke} |`,
      `| build_result | ${buildResult} |`,
      `| SAFE_FOR_LIVE_RLS_PHASE1 | ${safeForLive ? "yes" : "no"} |`,
    ].join("\n") + "\n",
  );

  console.log(JSON.stringify(summary, null, 2));
  if (!safeForLive) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
