/**
 * PHASE-4E-VERCEL-CRON-ENV-FIX-AND-SMOKE
 * Run with production env injected:
 *   npx vercel env run --environment production -- npx tsx scripts/phase4e-vercel-cron-env-smoke.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const PRODUCTION_URLS = [
  process.env.VERCEL_PRODUCTION_URL?.trim(),
  "https://menorix.com",
  "https://ecommerce-os-psi.vercel.app",
].filter(Boolean) as string[];
const OUT_BASE = ".cursor/audit-reports/phase4e-vercel-cron-smoke";

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromUrl(url: string): string | null {
  return url.match(/https:\/\/([a-z]{20})\.supabase/)?.[1] ?? null;
}

function jwtRef(key: string): string | null {
  try {
    const parts = key.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { ref?: string };
    return payload.ref ?? null;
  } catch {
    return null;
  }
}

function flagOn(v: string | undefined): boolean {
  const s = v?.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

async function main(): Promise<void> {
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const cronSecret = process.env.CRON_SECRET?.trim() ?? "";
  const nightlyFlag = process.env.ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON?.trim() ?? "";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const urlRef = refFromUrl(supabaseUrl);
  const keyRef = jwtRef(serviceKey);

  const envChecks = {
    ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON: flagOn(nightlyFlag),
    ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON_raw: nightlyFlag ? (nightlyFlag.length > 0 ? "set" : "empty") : "missing",
    NEXT_PUBLIC_SUPABASE_URL_original: urlRef === ORIGINAL_REF,
    NEXT_PUBLIC_SUPABASE_URL_ref: urlRef,
    SUPABASE_SERVICE_ROLE_KEY_original: keyRef === ORIGINAL_REF,
    SUPABASE_SERVICE_ROLE_KEY_ref: keyRef,
    CRON_SECRET_present: cronSecret.length > 0,
  };

  const envOk =
    envChecks.ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON &&
    envChecks.NEXT_PUBLIC_SUPABASE_URL_original &&
    envChecks.SUPABASE_SERVICE_ROLE_KEY_original &&
    envChecks.CRON_SECRET_present;

  const blockers: string[] = [];
  if (!envChecks.ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON) {
    blockers.push(`ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON not true (raw=${envChecks.ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON_raw})`);
  }
  if (!envChecks.NEXT_PUBLIC_SUPABASE_URL_original) {
    blockers.push(`NEXT_PUBLIC_SUPABASE_URL ref=${urlRef ?? "missing"} expected ${ORIGINAL_REF}`);
  }
  if (!envChecks.SUPABASE_SERVICE_ROLE_KEY_original) {
    blockers.push(`SUPABASE_SERVICE_ROLE_KEY ref=${keyRef ?? "missing"} expected ${ORIGINAL_REF}`);
  }
  if (!envChecks.CRON_SECRET_present) blockers.push("CRON_SECRET missing");

  let cronRouteStatus: number | null = null;
  let cronRouteBody: unknown = null;
  let cronUrlUsed: string | null = null;
  const smokeStarted = new Date().toISOString();

  if (cronSecret) {
    for (const base of PRODUCTION_URLS) {
      const url = `${base.replace(/\/$/, "")}/api/cron/removal-nightly-sync`;
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${cronSecret}` },
        });
        const text = await res.text();
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          /* keep text */
        }
        cronRouteStatus = res.status;
        cronRouteBody = body;
        cronUrlUsed = url;
        if (res.status !== 404) break;
      } catch (e) {
        cronRouteBody = { error: e instanceof Error ? e.message : String(e), url };
      }
    }
  }

  const pgUrl = process.env.DIRECT_POSTGRES_URL?.trim() ?? "";
  const dbUrl =
    pgUrl.includes(ORIGINAL_REF)
      ? pgUrl
      : process.env.ORIGINAL_DIRECT_POSTGRES_URL?.includes(ORIGINAL_REF)
        ? process.env.ORIGINAL_DIRECT_POSTGRES_URL!
        : "";

  let auditTickWritten = false;
  let auditRows: unknown[] = [];
  let uploadsBefore = 0;
  let uploadsAfter = 0;
  let cronRuntimeNext: string | null = null;

  if (dbUrl) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    const ub = await client.query(
      `SELECT count(*)::int AS c FROM raw_report_uploads
       WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
         AND created_at >= date_trunc('day', now() AT TIME ZONE 'utc')`,
      [ORG],
    );
    uploadsBefore = ub.rows[0]?.c ?? 0;

    if (cronRouteStatus != null) {
      await new Promise((r) => setTimeout(r, 2000));
    }

    const audit = await client.query(
      `SELECT id::text, automation_type, action, created_at::text,
              after_json->>'reason' AS reason, after_json->>'skipped' AS skipped,
              metadata->>'source' AS source
       FROM platform_automation_audit_log
       WHERE organization_id=$1::uuid AND action='cron_tick'
         AND created_at >= $2::timestamptz
       ORDER BY created_at DESC LIMIT 5`,
      [ORG, smokeStarted],
    );
    auditRows = audit.rows;
    auditTickWritten = audit.rows.length > 0;

    const ua = await client.query(
      `SELECT count(*)::int AS c FROM raw_report_uploads
       WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
         AND created_at >= date_trunc('day', now() AT TIME ZONE 'utc')`,
      [ORG],
    );
    uploadsAfter = ua.rows[0]?.c ?? 0;

    const ps = await client.query(`SELECT automation_settings FROM platform_settings WHERE id=true`);
    const scopeKey = `${ORG}:509ee1f6-622c-46a5-8110-7b889ba46c2c`;
    const automationDoc = ps.rows[0]?.automation_settings as Record<string, unknown> | undefined;
    const scopes = automationDoc?.scopes as Record<string, { removal_api_sync?: { cron_runtime?: { next_run_at?: string } } }> | undefined;
    cronRuntimeNext = scopes?.[scopeKey]?.removal_api_sync?.cron_runtime?.next_run_at ?? null;

    await client.end();
  }

  const not503 = cronRouteStatus != null && cronRouteStatus !== 503;
  const safeForCron =
    envOk && not503 && (cronRouteStatus === 200 || cronRouteStatus === 401) && auditTickWritten;

  const result = {
    phase: "4E-VERCEL-CRON-ENV-FIX-AND-SMOKE",
    run_id: rid,
    env_ok: envOk ? "yes" : "no",
    env_checks: envChecks,
    cron_route_url: cronUrlUsed,
    cron_route_status: cronRouteStatus,
    cron_route_body: cronRouteBody,
    audit_tick_written: auditTickWritten,
    audit_rows_since_smoke: auditRows,
    raw_uploads_today_before: uploadsBefore,
    raw_uploads_today_after: uploadsAfter,
    uploads_unchanged: uploadsBefore === uploadsAfter,
    next_run_at_from_db: cronRuntimeNext,
    SAFE_FOR_PRODUCTION_REMOVAL_CRON: safeForCron ? "yes" : "no",
    blockers: [
      ...blockers,
      ...(cronRouteStatus === 503 ? ["cron route returned 503 — check ENABLE flag or DB ref on Vercel runtime"] : []),
      ...(cronRouteStatus === 401 ? ["cron route 401 — CRON_SECRET mismatch between Vercel env and request"] : []),
      ...(!auditTickWritten && cronRouteStatus === 200 ? ["200 but no cron_tick in audit — audit write path broken"] : []),
      ...(!auditTickWritten && not503 && cronRouteStatus !== 401 ? ["no cron_tick after smoke — may be skipped response without audit"] : []),
    ],
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
