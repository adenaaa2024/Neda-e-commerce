/**
 * PHASE-8B-ORIGINAL-BACKUP-REVOKE-GRANTS-EXECUTE
 *
 *   npx tsx scripts/phase8b-original-backup-revoke-grants-execute.ts --run-id=<UTC>
 *   npx tsx scripts/phase8b-original-backup-revoke-grants-execute.ts --run-id=<UTC> --skip-rerun-audit
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const APPROVAL_PATH = ".cursor/operator-approvals/phase8b-original-backup-revoke-grants-approval.md";
const PREREQ_MANIFEST =
  ".cursor/audit-reports/phase8b-original-backup-tables-rls-cleanup-audit/20260604T220000Z/manifest.json";
const OUT_BASE = ".cursor/audit-reports/phase8b-original-backup-revoke-grants-execute";
const AUDIT_SCRIPT = "scripts/phase8b-original-backup-tables-rls-cleanup-audit.ts";

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
  const phase = /APPROVED_PHASE8B_BACKUP_REVOKE_GRANTS\s*=\s*true/i.test(text);
  const ref = text.match(/TARGET_SUPABASE_REF\s*=\s*(\S+)/)?.[1] ?? "";
  return {
    ok: run && phase && ref === ORIGINAL_REF,
    detail: `run=${run} phase=${phase} ref=${ref || "(unset)"}`,
  };
}

async function listBackupTables(client: pg.Client): Promise<string[]> {
  const res = await client.query(
    `SELECT c.relname AS table_name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND (c.relname LIKE '\\_backup\\_%' ESCAPE '\\'
            OR c.relname LIKE '\\_audit\\_original\\_demo\\_schema\\_parity\\_%' ESCAPE '\\')
     ORDER BY c.relname`,
  );
  return (res.rows as { table_name: string }[]).map((r) => r.table_name);
}

function buildRevokeSql(tables: string[]): string {
  const parts = [
    "-- PHASE-8B backup/audit grant revoke (original)",
    "BEGIN;",
  ];
  for (const t of tables) {
    parts.push(
      `REVOKE ALL ON TABLE public."${t}" FROM anon;`,
      `REVOKE ALL ON TABLE public."${t}" FROM authenticated;`,
      `REVOKE ALL ON TABLE public."${t}" FROM PUBLIC;`,
      `GRANT ALL ON TABLE public."${t}" TO service_role;`,
    );
  }
  parts.push("COMMIT;", "NOTIFY pgrst, 'reload schema';");
  return parts.join("\n");
}

async function tableGrants(client: pg.Client, table: string): Promise<Record<string, string[]>> {
  const res = await client.query(
    `SELECT grantee, privilege_type
     FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = $1
       AND grantee IN ('anon', 'authenticated', 'service_role', 'public', 'postgres')
     ORDER BY grantee, privilege_type`,
    [table],
  );
  const out: Record<string, string[]> = {};
  for (const row of res.rows as { grantee: string; privilege_type: string }[]) {
    out[row.grantee] ??= [];
    out[row.grantee].push(row.privilege_type);
  }
  return out;
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

function scanRuntimeAppRefs(): string[] {
  const hits: string[] = [];
  for (const dir of ["app", "lib", "components"]) {
    const abs = path.join(process.cwd(), dir);
    if (!fs.existsSync(abs)) continue;
    try {
      const out = execSync(
        `rg -l --glob "*.{ts,tsx}" "\\.from\\([\\"'](_backup_|_audit_)" "${abs}"`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
      ).trim();
      if (out) hits.push(...out.split("\n").map((f) => path.relative(process.cwd(), f)));
    } catch {
      /* none */
    }
  }
  return [...new Set(hits)];
}

async function verifyRoleBlocked(
  client: ReturnType<typeof createClient>,
  table: string,
  ops: ("select" | "insert" | "update" | "delete")[],
): Promise<{ blocked: boolean; checks: Record<string, boolean> }> {
  const checks: Record<string, boolean> = {};
  for (const op of ops) {
    let blocked = false;
    if (op === "select") {
      const r = await client.from(table).select("*").limit(1);
      blocked = !!(r.error?.message && r.error.message.length > 0);
    } else if (op === "insert") {
      const r = await client.from(table).insert({}).select("id");
      blocked = !!r.error?.message;
    } else if (op === "update") {
      const r = await client.from(table).update({}).eq("id", "00000000-0000-0000-0000-000000000000");
      blocked = !!r.error?.message;
    } else {
      const r = await client.from(table).delete().eq("id", "00000000-0000-0000-0000-000000000000");
      blocked = !!r.error?.message;
    }
    checks[op] = blocked;
  }
  return { blocked: Object.values(checks).every(Boolean), checks };
}

async function verifyRoleBlockedPg(
  client: pg.Client,
  role: "anon" | "authenticated",
  table: string,
): Promise<{ blocked: boolean; checks: Record<string, boolean> }> {
  const checks: Record<string, boolean> = {};
  const ops = ["select", "insert", "update", "delete"] as const;
  for (const op of ops) {
    let blocked = false;
    try {
      await client.query(`SET ROLE ${role}`);
      if (op === "select") {
        await client.query(`SELECT 1 FROM public."${table}" LIMIT 1`);
      } else if (op === "insert") {
        await client.query(`INSERT INTO public."${table}" DEFAULT VALUES`);
      } else if (op === "update") {
        await client.query(`UPDATE public."${table}" SET tableoid = tableoid WHERE false`);
      } else {
        await client.query(`DELETE FROM public."${table}" WHERE false`);
      }
      blocked = false;
    } catch {
      blocked = true;
    } finally {
      await client.query("RESET ROLE").catch(() => {});
    }
    checks[op] = blocked;
  }
  return { blocked: Object.values(checks).every(Boolean), checks };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const skipRerunAudit = process.argv.includes("--skip-rerun-audit");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const blockers: string[] = [];
  const approval = readApproval();
  if (!approval.ok) blockers.push(`Approval blocked: ${approval.detail}`);

  if (!fs.existsSync(path.join(process.cwd(), PREREQ_MANIFEST))) {
    blockers.push(`Prerequisite manifest missing: ${PREREQ_MANIFEST}`);
  }

  const dbUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const supabaseUrl = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  const anon = process.env.ORIGINAL_ANON_KEY?.trim() ?? "";
  const serviceKey = process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ?? "";

  if (refFromDbUrl(dbUrl) !== ORIGINAL_REF) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL must target original ref");
  if (refFromSupabaseUrl(supabaseUrl) !== ORIGINAL_REF) blockers.push("ORIGINAL_SUPABASE_URL must target original ref");
  if (dbUrl.includes(STAGING_REF)) blockers.push("Refusing — staging ref in DB URL");

  let revokedTables: string[] = [];
  let applyError: string | null = null;

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  revokedTables = await listBackupTables(client);

  if (revokedTables.length !== 18) {
    blockers.push(`Expected 18 backup/audit tables, found ${revokedTables.length}`);
  }

  if (blockers.length === 0) {
    const sql = buildRevokeSql(revokedTables);
    fs.writeFileSync(path.join(outDir, "01_revoke_grants.sql"), sql);
    try {
      await client.query(sql);
    } catch (e) {
      applyError = e instanceof Error ? e.message : String(e);
      blockers.push(`Apply failed: ${applyError}`);
    }
  }

  const anonClient = createClient(supabaseUrl, anon, { auth: { persistSession: false } });
  const adminClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const userClient = await buildUserClient(supabaseUrl, anon, serviceKey);

  const sampleTables = revokedTables.slice(0, 3);
  const anonChecks: Record<string, unknown> = {};
  const authChecks: Record<string, unknown> = {};
  const srChecks: Record<string, unknown> = {};

  for (const t of sampleTables) {
    anonChecks[t] = await verifyRoleBlocked(anonClient, t, ["select", "insert", "update", "delete"]);
    if (userClient) {
      authChecks[t] = await verifyRoleBlocked(userClient, t, ["select", "insert", "update", "delete"]);
    } else {
      authChecks[t] = await verifyRoleBlockedPg(client, "authenticated", t);
    }
    const sr = await adminClient.from(t).select("*").limit(1);
    srChecks[t] = { ok: !sr.error, rows: sr.data?.length ?? 0, error: sr.error?.message ?? null };
  }

  const grantSnapshot: Record<string, Record<string, string[]>> = {};
  for (const t of revokedTables) {
    grantSnapshot[t] = await tableGrants(client, t);
  }
  await client.end();

  const anonAccessBlocked =
    blockers.length === 0 &&
    sampleTables.every((t) => (anonChecks[t] as { blocked: boolean }).blocked);
  const authenticatedAccessBlocked =
    blockers.length === 0 &&
    sampleTables.every((t) => (authChecks[t] as { blocked: boolean }).blocked);
  const serviceRoleAccessOk =
    blockers.length === 0 && sampleTables.every((t) => (srChecks[t] as { ok: boolean }).ok);

  const runtimeRefs = scanRuntimeAppRefs();
  const appRefsBroken = runtimeRefs.length > 0;

  let auditRerun: Record<string, unknown> | null = null;
  if (!skipRerunAudit && blockers.length === 0) {
    try {
      const auditRunId = `${runId}-post`;
      execSync(`npx tsx ${AUDIT_SCRIPT} --run-id=${auditRunId}`, {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: "pipe",
        timeout: 300_000,
      });
      const auditPath = path.join(
        process.cwd(),
        ".cursor/audit-reports/phase8b-original-backup-tables-rls-cleanup-audit",
        auditRunId,
        "manifest.json",
      );
      if (fs.existsSync(auditPath)) {
        auditRerun = JSON.parse(fs.readFileSync(auditPath, "utf8")) as Record<string, unknown>;
      }
    } catch (e) {
      blockers.push(`8B audit rerun failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    }
  }

  const backupReport = (auditRerun?.backup_tables_report as { table_name: string; public_permissions: Record<string, string[]> }[]) ?? [];
  const anyPublicSelect = backupReport.some(
    (t) =>
      t.public_permissions?.anon?.includes("SELECT") ||
      t.public_permissions?.authenticated?.includes("SELECT"),
  );

  const safeExposureClosed =
    blockers.length === 0 &&
    !applyError &&
    anonAccessBlocked &&
    authenticatedAccessBlocked &&
    serviceRoleAccessOk &&
    !appRefsBroken &&
    (skipRerunAudit || (!anyPublicSelect && backupReport.length === 18));

  const summary = {
    prompt: "PHASE-8B-ORIGINAL-BACKUP-REVOKE-GRANTS-EXECUTE",
    run_id: runId,
    target_ref: ORIGINAL_REF,
    revoked_tables_count: revokedTables.length,
    revoked_tables: revokedTables,
    apply_error: applyError,
    anon_access_blocked: anonAccessBlocked ? "yes" : blockers.length ? "skipped" : "no",
    authenticated_access_blocked: authenticatedAccessBlocked ? "yes" : blockers.length ? "skipped" : "no",
    service_role_access_ok: serviceRoleAccessOk ? "yes" : blockers.length ? "skipped" : "no",
    anon_checks_sample: anonChecks,
    auth_checks_sample: authChecks,
    service_role_checks_sample: srChecks,
    grants_after: grantSnapshot,
    app_refs_broken: appRefsBroken ? "yes" : "no",
    runtime_app_refs: runtimeRefs,
    audit_rerun_run_id: skipRerunAudit ? null : `${runId}-post`,
    audit_rerun_public_select_remaining: anyPublicSelect,
    SAFE_BACKUP_TABLES_EXPOSURE_CLOSED: safeExposureClosed ? "yes" : "no",
    blockers,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(outDir, "implementation-summary.md"),
    [
      "# Phase 8B backup revoke grants execute",
      "",
      `| Field | Value |`,
      `|-------|-------|`,
      `| revoked_tables_count | ${revokedTables.length} |`,
      `| anon_access_blocked | ${summary.anon_access_blocked} |`,
      `| authenticated_access_blocked | ${summary.authenticated_access_blocked} |`,
      `| service_role_access_ok | ${summary.service_role_access_ok} |`,
      `| app_refs_broken | ${summary.app_refs_broken} |`,
      `| SAFE_BACKUP_TABLES_EXPOSURE_CLOSED | ${summary.SAFE_BACKUP_TABLES_EXPOSURE_CLOSED} |`,
    ].join("\n") + "\n",
  );

  console.log(JSON.stringify(summary, null, 2));
  if (!safeExposureClosed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
