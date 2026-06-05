/**
 * Safe runtime check — run INSIDE Vercel production env:
 *   npx vercel env run --environment production -- npx tsx scripts/verify-production-vercel-env-runtime.ts
 */
import pg from "pg";

const ORIGINAL = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function refFromUrl(url: string): string | null {
  return url.match(/https:\/\/([a-z]{20})\.supabase/)?.[1] ?? null;
}

function flagOn(v: string | undefined): boolean {
  const s = v?.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

async function main(): Promise<void> {
  const keys = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ENABLE_AMAZON_REPORTS_API_WORKER",
    "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER",
    "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT",
    "CRON_SECRET",
    "ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON",
    "DIRECT_POSTGRES_URL",
    "ORIGINAL_PROJECT_REF",
    "STAGING_PROJECT_REF",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ] as const;

  const present: Record<string, boolean> = {};
  const safe: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k]?.trim() ?? "";
    present[k] = Boolean(v);
    if (k === "NEXT_PUBLIC_SUPABASE_URL") safe[k] = v ? (refFromUrl(v) ?? "unparseable") : "missing";
    else if (/SECRET|KEY/i.test(k) && k !== "NEXT_PUBLIC_SUPABASE_URL") safe[k] = present[k] ? "set" : "missing";
    else if (k.startsWith("ENABLE_")) safe[k] = v || "missing";
    else if (k.endsWith("_REF")) safe[k] = v || "missing";
    else safe[k] = present[k] ? "set" : "missing";
  }

  const urlRef = process.env.NEXT_PUBLIC_SUPABASE_URL ? refFromUrl(process.env.NEXT_PUBLIC_SUPABASE_URL) : null;
  const wrong: string[] = [];
  if (urlRef !== ORIGINAL) wrong.push(`NEXT_PUBLIC_SUPABASE_URL ref=${urlRef ?? "missing"}`);
  if (process.env.STAGING_PROJECT_REF?.trim() === urlRef) wrong.push("URL matches STAGING_PROJECT_REF");

  let spApi: Record<string, unknown> = { checked: false };
  const pgUrl = process.env.DIRECT_POSTGRES_URL?.trim() ?? "";
  if (pgUrl.includes(ORIGINAL)) {
    const c = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const mpCred = await c.query(
      `SELECT credentials FROM marketplaces WHERE organization_id=$1::uuid AND provider='amazon_sp_api' LIMIT 1`,
      [ORG_ID],
    );
    const cred = mpCred.rows[0]?.credentials as Record<string, unknown> | undefined;
    let lwa = false;
    let awsDb = false;
    if (cred && typeof cred === "object") {
      lwa = Boolean(
        String(cred.lwa_client_id ?? cred.lwaClientId ?? cred.client_id ?? "").trim() &&
          String(cred.lwa_client_secret ?? cred.lwaClientSecret ?? cred.client_secret ?? "").trim() &&
          String(cred.refresh_token ?? cred.refreshToken ?? "").trim(),
      );
      awsDb = Boolean(
        String(cred.aws_access_key ?? cred.aws_access_key_id ?? "").trim() &&
          String(cred.aws_secret_key ?? cred.aws_secret_access_key ?? "").trim(),
      );
    }
    const awsEnv = Boolean(process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim());
    spApi = { checked: true, lwa_complete: lwa, aws_in_db: awsDb, aws_in_env: awsEnv, ready: lwa && (awsDb || awsEnv) };
    if (!spApi.ready) wrong.push("SP-API credentials incomplete in DB/env");
    await c.end();
  } else {
    wrong.push("DIRECT_POSTGRES_URL missing or not original");
  }

  const apiOk =
    flagOn(process.env.ENABLE_AMAZON_REPORTS_API_WORKER) &&
    flagOn(process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER) &&
    flagOn(process.env.ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT);

  const missing = keys.filter((k) => !present[k]);
  const safeToRun = missing.length === 0 && urlRef === ORIGINAL && apiOk && Boolean(spApi.ready) && wrong.length === 0;

  console.log(
    JSON.stringify(
      {
        source: "vercel_env_run_production",
        present,
        safe,
        missing_env_vars: missing,
        wrong_env_risks: wrong,
        api_flags_enabled: apiOk,
        sp_api: spApi,
        SAFE_TO_RUN_PRODUCTION_SYNC: safeToRun ? "yes" : "no",
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
