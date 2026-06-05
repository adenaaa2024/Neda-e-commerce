/**
 * VERIFY_PRODUCTION_VERCEL_ENV — read pulled Vercel production env + DB SP-API check.
 *   npx vercel env pull .cursor/audit-reports/production-warehouse-go-live/vercel-production.env --environment=production --yes
 *   npx tsx scripts/verify-production-vercel-env.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

const ORIGINAL = "kxsvedvpjldygtdbylsy";
const STAGING = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const ENV_PATH = ".cursor/audit-reports/production-warehouse-go-live/vercel-production.env";
const OUT_PATH = ".cursor/audit-reports/production-warehouse-go-live/vercel-env-audit.json";

function parseEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq);
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[k] = v;
  }
  return env;
}

function refFromUrl(url: string): string | null {
  return url.match(/https:\/\/([a-z]{20})\.supabase/)?.[1] ?? null;
}

function flagOn(v: string | undefined): boolean {
  const s = v?.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

async function main(): Promise<void> {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`Missing ${ENV_PATH} — run: npx vercel env pull ${ENV_PATH} --environment=production --yes`);
  }
  const env = parseEnvFile(ENV_PATH);

  const requiredVercel = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ENABLE_AMAZON_REPORTS_API_WORKER",
    "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER",
    "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT",
    "CRON_SECRET",
    "ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON",
  ] as const;

  const requiredScriptLocal = [
    "ORIGINAL_DIRECT_POSTGRES_URL",
    "APPROVED_PRODUCTION_WAREHOUSE_GO_LIVE_SYNC",
  ] as const;

  const optionalEnv = [
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "DIRECT_POSTGRES_URL",
    "ORIGINAL_PROJECT_REF",
    "STAGING_PROJECT_REF",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_REGION",
    "REPORTS_API_INTERNAL_BASE_URL",
    "REPORTS_API_PIPELINE_USE_HTTP",
    "NEXT_PUBLIC_SITE_URL",
  ] as const;

  const present: Record<string, boolean> = {};
  const valuesSafe: Record<string, string> = {};
  for (const k of [...requiredVercel, ...optionalEnv, ...requiredScriptLocal]) {
    present[k] = Boolean(env[k]?.trim());
    if (k === "NEXT_PUBLIC_SUPABASE_URL") {
      valuesSafe[k] = env[k] ? (refFromUrl(env[k]) ?? "unparseable") : "missing";
    } else if (/SECRET|KEY|TOKEN|PASSWORD/i.test(k)) {
      valuesSafe[k] = present[k] ? "set (redacted)" : "missing";
    } else if (k.startsWith("ENABLE_") || k.startsWith("APPROVED_")) {
      valuesSafe[k] = env[k]?.trim() ?? "missing";
    } else {
      valuesSafe[k] = present[k] ? "set" : "missing";
    }
  }

  const urlRef = env.NEXT_PUBLIC_SUPABASE_URL ? refFromUrl(env.NEXT_PUBLIC_SUPABASE_URL) : null;
  const wrongRisks: string[] = [];
  if (urlRef !== ORIGINAL) wrongRisks.push(`NEXT_PUBLIC_SUPABASE_URL ref=${urlRef ?? "missing"} expected ${ORIGINAL}`);
  if (env.ORIGINAL_PROJECT_REF?.trim() && env.ORIGINAL_PROJECT_REF.trim() !== ORIGINAL) {
    wrongRisks.push("ORIGINAL_PROJECT_REF does not match original ref");
  }
  if (env.STAGING_PROJECT_REF?.trim() === urlRef) {
    wrongRisks.push("NEXT_PUBLIC_SUPABASE_URL may be staging (matches STAGING_PROJECT_REF)");
  }

  const pgUrl = env.DIRECT_POSTGRES_URL?.trim() ?? "";
  if (pgUrl.includes(STAGING)) wrongRisks.push("DIRECT_POSTGRES_URL contains staging ref");
  if (pgUrl && !pgUrl.includes(ORIGINAL)) wrongRisks.push("DIRECT_POSTGRES_URL does not contain original ref");

  let spApiDb: Record<string, unknown> = { checked: false, reason: "no DIRECT_POSTGRES_URL" };
  if (pgUrl.includes(ORIGINAL)) {
    const c = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const store = await c.query(
      `SELECT s.id::text, s.marketplace_id::text, m.provider, (m.credentials IS NOT NULL) AS has_mp_creds
       FROM stores s LEFT JOIN marketplaces m ON m.id = s.marketplace_id
       WHERE s.id = $1::uuid`,
      [STORE_ID],
    );
    const orgKey = await c.query(
      `SELECT name, (api_key IS NOT NULL AND length(api_key::text) > 20) AS has_key
       FROM organization_api_keys
       WHERE organization_id = $1::uuid AND name = 'amazon_sp_api'`,
      [ORG_ID],
    );
    const mpCred = await c.query(
      `SELECT credentials FROM marketplaces
       WHERE organization_id = $1::uuid AND provider = 'amazon_sp_api' LIMIT 1`,
      [ORG_ID],
    );
    const cred = mpCred.rows[0]?.credentials as Record<string, unknown> | undefined;
    let lwaComplete = false;
    let awsInDb = false;
    if (cred && typeof cred === "object") {
      const lwa = cred.lwa_client_id ?? cred.lwaClientId ?? cred.client_id;
      const sec = cred.lwa_client_secret ?? cred.lwaClientSecret ?? cred.client_secret;
      const rt = cred.refresh_token ?? cred.refreshToken;
      lwaComplete = Boolean(String(lwa ?? "").trim() && String(sec ?? "").trim() && String(rt ?? "").trim());
      const ak = cred.aws_access_key ?? cred.aws_access_key_id;
      const sk = cred.aws_secret_key ?? cred.aws_secret_access_key;
      awsInDb = Boolean(String(ak ?? "").trim() && String(sk ?? "").trim());
    }
    const awsEnv = Boolean(env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim());
    spApiDb = {
      checked: true,
      store_row: store.rows[0] ?? null,
      org_api_key_present: Boolean(orgKey.rows[0]?.has_key),
      lwa_complete_in_marketplace_credentials: lwaComplete,
      aws_signing_in_db_credentials: awsInDb,
      aws_signing_in_vercel_env: awsEnv,
      sp_api_ready: lwaComplete && (awsInDb || awsEnv),
    };
    if (!spApiDb.sp_api_ready) wrongRisks.push("Amazon SP-API LWA/AWS not complete in DB or env");
    await c.end();
  }

  const missing = requiredVercel.filter((k) => !present[k]);
  const apiFlagsOk =
    flagOn(env.ENABLE_AMAZON_REPORTS_API_WORKER) &&
    flagOn(env.ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER) &&
    flagOn(env.ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT);

  const cronStatus = {
    route: "/api/cron/removal-nightly-sync",
    schedule_local_vercel_json: "30 6 * * *",
    vercel_cli_status: "not deployed (pending prod deploy per vercel crons ls)",
    cron_secret_present: present.CRON_SECRET,
    nightly_cron_flag: valuesSafe.ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON,
  };

  const safeToRun =
    missing.length === 0 &&
    urlRef === ORIGINAL &&
    apiFlagsOk &&
    Boolean(spApiDb.sp_api_ready) &&
    wrongRisks.length === 0;

  const report = {
    vercel_project: "mebrahimipargoo-9799s-projects/ecommerce-os",
    required_env_vars: {
      vercel_production: [...requiredVercel],
      script_local_only: [...requiredScriptLocal],
      amazon_worker_db_or_env: [
        "marketplaces.credentials (lwa_client_id, lwa_client_secret, refresh_token)",
        "marketplaces.credentials OR env: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
        "ENABLE_AMAZON_REPORTS_API_WORKER",
        "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER",
        "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT",
      ],
      cron_route: ["CRON_SECRET", "ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON", "NEXT_PUBLIC_SUPABASE_URL"],
    },
    vercel_production_env_status: { present, values_safe: valuesSafe },
    missing_env_vars: missing,
    wrong_env_risks: wrongRisks,
    api_flags_enabled: apiFlagsOk,
    sp_api_credentials: spApiDb,
    cron_status: cronStatus,
    SAFE_TO_RUN_PRODUCTION_SYNC: safeToRun ? "yes" : "no",
    DO_NOT_RUN_UNTIL_APPROVED: true,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
