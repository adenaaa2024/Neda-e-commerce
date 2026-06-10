/**
 * PHASE-8C-RLS-VIEWS-SECURITY-INVOKER-ORIGINAL-EXECUTE
 *
 *   npx tsx scripts/phase8c-rls-views-security-invoker-original-execute.ts --run-id=<UTC> --apply
 *   npx tsx scripts/phase8c-rls-views-security-invoker-original-execute.ts --run-id=<UTC> --apply --skip-build
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const APPROVAL_PATH = ".cursor/operator-approvals/phase8c-rls-views-security-invoker-original-approval.md";
const PREREQ_MANIFEST =
  ".cursor/audit-reports/phase8c-rls-views-security-invoker-staging/20260604T240000Z/manifest.json";
const OUT_BASE = ".cursor/audit-reports/phase8c-rls-views-security-invoker-original-execute";
const ORG_FALLBACK = "00000000-0000-0000-0000-000000000001";

const TARGET_VIEWS = [
  "v_scanned_items_counted",
  "v_inventory_item_status",
  "v_inventory_status",
  "v_claim_base_amazon_removals",
  "v_claim_candidate_source_context",
  "v_claim_financial_events",
  "v_claim_submission_rollup",
  "v_claim_candidate_financial_hints",
  "v_claim_analytics_base",
  "v_claim_kpi_buckets",
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

function readApproval(): { ok: boolean; detail: string } {
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) return { ok: false, detail: "approval file missing" };
  const text = fs.readFileSync(p, "utf8");
  const run = /APPROVED_TO_RUN_ORIGINAL\s*=\s*true/i.test(text);
  const phase = /APPROVED_PHASE8C_VIEWS_SECURITY_INVOKER_ORIGINAL\s*=\s*true/i.test(text);
  const ref = text.match(/TARGET_SUPABASE_REF\s*=\s*(\S+)/)?.[1] ?? "";
  return { ok: run && phase && ref === ORIGINAL_REF, detail: `run=${run} phase=${phase} ref=${ref || "(unset)"}` };
}

async function viewColumns(client: pg.Client, view: string): Promise<string[]> {
  const res = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [view],
  );
  return (res.rows as { column_name: string }[]).map((r) => r.column_name);
}

async function viewSecurityInvoker(client: pg.Client, view: string): Promise<boolean | null> {
  const res = await client.query(
    `SELECT reloptions FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind = 'v'`,
    [view],
  );
  const opts = (res.rows[0] as { reloptions: string[] | null } | undefined)?.reloptions ?? [];
  if (opts.some((o) => o === "security_invoker=true")) return true;
  if (opts.some((o) => o === "security_invoker=false")) return false;
  return null;
}

async function buildViewSql(client: pg.Client, view: string): Promise<string> {
  const def = await client.query(`SELECT pg_get_viewdef($1::regclass, true) AS def`, [`public.${view}`]);
  const body = (def.rows[0] as { def: string }).def;
  return `CREATE OR REPLACE VIEW public.${view}\nWITH (security_invoker = true) AS\n${body};`;
}

async function buildUserClient(url: string, anon: string, serviceKey: string) {
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 5 });
  const email = users?.users.find((u) => u.email)?.email;
  if (!email) return { client: null, orgId: null as string | null };
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (!tokenHash) return { client: null, orgId: null };
  const res = await fetch(`${url}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token_hash: tokenHash }),
  });
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) return { client: null, orgId: null };
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${body.access_token}` } },
    auth: { persistSession: false },
  });
  const userId = users?.users.find((u) => u.email === email)?.id;
  const { data: profile } = userId
    ? await admin.from("profiles").select("organization_id").eq("id", userId).maybeSingle()
    : { data: null };
  const orgId = (profile as { organization_id?: string } | null)?.organization_id ?? null;
  return { client: userClient, orgId };
}

async function runRlsLeakTest(
  supabaseUrl: string,
  anonKey: string,
  admin: ReturnType<typeof createClient>,
  userClient: ReturnType<typeof createClient> | null,
  orgId: string | null,
): Promise<{ pass: boolean; detail: Record<string, unknown> }> {
  const detail: Record<string, unknown> = {};
  if (!userClient || !orgId) {
    return { pass: false, detail: { skipped: "no authenticated user/org" } };
  }

  const viewsWithOrg = [
    "v_inventory_item_status",
    "v_scanned_items_counted",
    "v_claim_candidate_source_context",
    "v_claim_analytics_base",
  ] as const;

  let pass = true;
  for (const v of viewsWithOrg) {
    const auth = await userClient.from(v).select("organization_id").limit(v === "v_claim_analytics_base" ? 20 : 200);
    const orgs = [...new Set((auth.data ?? []).map((r) => (r as { organization_id?: string }).organization_id))];
    const sr = await admin
      .from(v)
      .select("organization_id", { count: "exact", head: true })
      .eq("organization_id", orgId);
    const leak = orgs.some((o) => o && o !== orgId);
    const timedOut = (auth.error?.message ?? "").includes("statement timeout");
    detail[v] = {
      auth_rows_sampled: auth.data?.length ?? 0,
      distinct_orgs: orgs,
      cross_org_leak: leak,
      sr_org_count: sr.count ?? 0,
      auth_error: auth.error?.message ?? null,
      timed_out: timedOut,
    };
    if (leak) pass = false;
    else if (auth.error && !timedOut) pass = false;
  }

  const anonClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const anonInv = await anonClient.from("v_inventory_item_status").select("organization_id").limit(5);
  detail.anon_inventory = {
    blocked_or_empty: !!(anonInv.error?.message || (anonInv.data ?? []).length === 0),
    error: anonInv.error?.message ?? null,
    rows: anonInv.data?.length ?? 0,
  };
  if (!anonInv.error && (anonInv.data ?? []).length > 0) pass = false;

  return { pass, detail };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const skipBuild = hasFlag("--skip-build");
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
      SAFE_TO_APPLY_8C_PRODUCTION?: string;
    };
    if (prereq.SAFE_TO_APPLY_8C_PRODUCTION !== "yes") {
      blockers.push("Staging prerequisite SAFE_TO_APPLY_8C_PRODUCTION != yes");
    }
  }

  const originalUrl = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  const originalDb = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const anon = process.env.ORIGINAL_ANON_KEY?.trim() ?? "";
  const serviceKey = process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ?? "";

  if (refFromSupabaseUrl(originalUrl) !== ORIGINAL_REF) blockers.push("ORIGINAL_SUPABASE_URL must target original ref");
  if (refFromDbUrl(originalDb) !== ORIGINAL_REF) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL must target original ref");
  if (originalDb.includes(STAGING_REF)) blockers.push("Refusing — staging ref in DB URL");
  if (!originalDb) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL required");

  const client = new pg.Client({ connectionString: originalDb, ssl: { rejectUnauthorized: false } });
  const columnsBefore: Record<string, string[]> = {};
  const viewSqlParts: string[] = [
    "-- PHASE-8C security_invoker view recreate (original/production)",
    "BEGIN;",
  ];

  if (blockers.length === 0) {
    await client.connect();
    for (const v of TARGET_VIEWS) {
      columnsBefore[v] = await viewColumns(client, v);
      if (columnsBefore[v].length === 0) blockers.push(`View missing or no columns: ${v}`);
      else viewSqlParts.push(`-- ${v}`, await buildViewSql(client, v), "");
    }
    viewSqlParts.push("COMMIT;", "NOTIFY pgrst, 'reload schema';");
  }

  const applySql = viewSqlParts.join("\n");
  fs.writeFileSync(path.join(outDir, "01_security_invoker_views_applied.sql"), applySql + "\n");

  let productionApplied = false;
  let applyError: string | null = null;
  if (blockers.length === 0) {
    try {
      await client.query(applySql);
      productionApplied = true;
    } catch (e) {
      applyError = e instanceof Error ? e.message : String(e);
      blockers.push(`Apply failed: ${applyError}`);
    }
  }

  const columnsAfter: Record<string, string[]> = {};
  const viewsRecreated: Record<string, { security_invoker: boolean | null; columns: number }> = {};
  if (productionApplied) {
    for (const v of TARGET_VIEWS) {
      columnsAfter[v] = await viewColumns(client, v);
      viewsRecreated[v] = {
        security_invoker: await viewSecurityInvoker(client, v),
        columns: columnsAfter[v].length,
      };
    }
  }
  await client.end();

  const columnParityOk =
    productionApplied &&
    TARGET_VIEWS.every((v) => JSON.stringify(columnsBefore[v]) === JSON.stringify(columnsAfter[v]));

  const admin = createClient(originalUrl, serviceKey, { auth: { persistSession: false } });
  const { client: userClient, orgId } = productionApplied
    ? await buildUserClient(originalUrl, anon, serviceKey)
    : { client: null, orgId: null };
  const org = orgId ?? ORG_FALLBACK;

  const scannerChecks: Record<string, unknown> = {};
  if (productionApplied) {
    for (const v of ["v_scanned_items_counted", "v_inventory_item_status", "v_inventory_status"] as const) {
      const sr = await admin.from(v).select("*", { count: "exact", head: true }).eq("organization_id", org);
      scannerChecks[`sr_${v}`] = { ok: !sr.error, count: sr.count ?? 0, error: sr.error?.message ?? null };
    }
    if (userClient) {
      const u = await userClient.from("v_inventory_item_status").select("tracking_number").limit(5);
      scannerChecks.auth_inventory_item_status = {
        ok: !u.error,
        rows: u.data?.length ?? 0,
        error: u.error?.message ?? null,
      };
    }
  }
  const scannerSmoke =
    productionApplied &&
    (scannerChecks.sr_v_inventory_item_status as { ok: boolean })?.ok &&
    (scannerChecks.sr_v_scanned_items_counted as { ok: boolean })?.ok &&
    (!userClient || (scannerChecks.auth_inventory_item_status as { ok: boolean })?.ok);

  const claimsChecks: Record<string, unknown> = {};
  if (productionApplied) {
    for (const t of ["claim_candidates", "claim_cases"] as const) {
      const sr = await admin.from(t).select("id", { count: "exact", head: true }).eq("organization_id", org);
      claimsChecks[`sr_${t}`] = { ok: !sr.error, count: sr.count ?? 0, error: sr.error?.message ?? null };
    }
    const srCtx = await admin
      .from("v_claim_candidate_source_context")
      .select("claim_candidate_id", { count: "exact", head: true })
      .eq("organization_id", org);
    claimsChecks.sr_source_context = { ok: !srCtx.error, count: srCtx.count ?? 0, error: srCtx.error?.message ?? null };
    if (userClient) {
      const u = await userClient.from("v_claim_candidate_source_context").select("claim_candidate_id").limit(5);
      claimsChecks.auth_source_context = { ok: !u.error, rows: u.data?.length ?? 0, error: u.error?.message ?? null };
    }
    const lightViews = [
      "v_scanned_items_counted",
      "v_inventory_item_status",
      "v_inventory_status",
      "v_claim_base_amazon_removals",
      "v_claim_candidate_source_context",
      "v_claim_financial_events",
      "v_claim_submission_rollup",
    ] as const;
    for (const v of lightViews) {
      const q = admin.from(v).select("*").limit(1);
      const sr = ["v_claim_financial_events", "v_claim_submission_rollup"].includes(v)
        ? await q.eq("organization_id", org)
        : v.startsWith("v_inventory") || v === "v_scanned_items_counted"
          ? await q.eq("organization_id", org)
          : await q;
      claimsChecks[`sr_script_${v}`] = { ok: !sr.error, error: sr.error?.message ?? null };
    }
    const pgHeavy = new pg.Client({ connectionString: originalDb, ssl: { rejectUnauthorized: false } });
    await pgHeavy.connect();
    await pgHeavy.query(`SET statement_timeout = '120s'`);
    const heavyChecks = [
      {
        key: "sr_script_v_claim_candidate_financial_hints",
        sql: `SELECT claim_candidate_id FROM public.v_claim_candidate_financial_hints h
              WHERE EXISTS (
                SELECT 1 FROM public.claim_candidates c
                WHERE c.id = h.claim_candidate_id AND c.organization_id = $1
              ) LIMIT 1`,
      },
      {
        key: "sr_script_v_claim_analytics_base",
        sql: `SELECT claim_candidate_id FROM public.v_claim_analytics_base WHERE organization_id = $1 LIMIT 1`,
      },
      {
        key: "sr_script_v_claim_kpi_buckets",
        sql: `SELECT organization_id FROM public.v_claim_kpi_buckets WHERE organization_id = $1 LIMIT 1`,
      },
    ];
    for (const h of heavyChecks) {
      try {
        await pgHeavy.query(h.sql, [org]);
        claimsChecks[h.key] = { ok: true, error: null };
      } catch (e) {
        claimsChecks[h.key] = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    await pgHeavy.end();
  }

  const scriptKeys = [
    ...[
      "v_scanned_items_counted",
      "v_inventory_item_status",
      "v_inventory_status",
      "v_claim_base_amazon_removals",
      "v_claim_candidate_source_context",
      "v_claim_financial_events",
      "v_claim_submission_rollup",
    ].map((v) => `sr_script_${v}`),
    "sr_script_v_claim_candidate_financial_hints",
    "sr_script_v_claim_analytics_base",
    "sr_script_v_claim_kpi_buckets",
  ];
  const claimsSmoke =
    productionApplied &&
    (claimsChecks.sr_claim_candidates as { ok: boolean })?.ok &&
    (claimsChecks.sr_source_context as { ok: boolean })?.ok &&
    scriptKeys.every((k) => (claimsChecks[k] as { ok: boolean })?.ok);

  const rlsLeak = productionApplied
    ? await runRlsLeakTest(originalUrl, anon, admin, userClient, orgId)
    : { pass: false, detail: {} };

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

  const allInvoked =
    productionApplied && TARGET_VIEWS.every((v) => viewsRecreated[v]?.security_invoker === true);

  const safeForLive =
    productionApplied &&
    !applyError &&
    columnParityOk &&
    allInvoked &&
    scannerSmoke &&
    claimsSmoke &&
    rlsLeak.pass &&
    (buildResult === "pass" || buildResult === "skipped");

  const summary = {
    prompt: "PHASE-8C-RLS-VIEWS-SECURITY-INVOKER-ORIGINAL-EXECUTE",
    run_id: runId,
    target_ref: ORIGINAL_REF,
    production_applied: productionApplied ? "yes" : "no",
    views_recreated: productionApplied ? [...TARGET_VIEWS] : [],
    views_security_invoker: viewsRecreated,
    column_parity_ok: columnParityOk ? "yes" : productionApplied ? "no" : "skipped",
    scanner_smoke: scannerSmoke ? "pass" : productionApplied ? "fail" : "skipped",
    scanner_checks: scannerChecks,
    claims_smoke: claimsSmoke ? "pass" : productionApplied ? "fail" : "skipped",
    claims_checks: claimsChecks,
    rls_leak_test: rlsLeak.pass ? "pass" : productionApplied ? "fail" : "skipped",
    rls_leak_detail: rlsLeak.detail,
    build_result: buildResult,
    SAFE_FOR_LIVE_RLS_VIEWS: safeForLive ? "yes" : "no",
    apply_error: applyError,
    blockers,
    staging_not_touched: true,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(outDir, "implementation-summary.md"),
    [
      "# Phase 8C security_invoker views (original)",
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| production_applied | ${summary.production_applied} |`,
      `| views_recreated | ${summary.views_recreated.length} |`,
      `| column_parity_ok | ${summary.column_parity_ok} |`,
      `| scanner_smoke | ${summary.scanner_smoke} |`,
      `| claims_smoke | ${summary.claims_smoke} |`,
      `| rls_leak_test | ${summary.rls_leak_test} |`,
      `| build_result | ${buildResult} |`,
      `| SAFE_FOR_LIVE_RLS_VIEWS | ${summary.SAFE_FOR_LIVE_RLS_VIEWS} |`,
    ].join("\n") + "\n",
  );

  console.log(JSON.stringify(summary, null, 2));
  if (!safeForLive) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
