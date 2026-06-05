/**
 * Read .env.vercel-production (from `vercel env pull`) — safe metadata only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

const ORIGINAL = "kxsvedvpjldygtdbylsy";
const STAGING = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2] ?? "";
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]!] = v;
  }
  return out;
}

function refFromUrl(url: string): string | null {
  return url.match(/https:\/\/([a-z]{20})\.supabase/)?.[1] ?? null;
}

function refFromPg(url: string): string | null {
  if (url.includes(ORIGINAL)) return ORIGINAL;
  if (url.includes(STAGING)) return STAGING;
  const m = url.match(/postgres\.([a-z]{20})/);
  return m?.[1] ?? null;
}

function flagOn(v: string | undefined): boolean {
  const s = v?.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

function safeVal(key: string, v: string): string {
  if (!v) return "missing";
  if (key === "NEXT_PUBLIC_SUPABASE_URL") return refFromUrl(v) ?? "unparseable";
  if (key === "DIRECT_POSTGRES_URL" || key === "ORIGINAL_DIRECT_POSTGRES_URL") return refFromPg(v) ?? "set_unparsed";
  if (key === "ORIGINAL_PROJECT_REF" || key === "STAGING_PROJECT_REF") return v;
  if (key.startsWith("ENABLE_")) return v;
  if (/SECRET|KEY|PASSWORD|TOKEN/i.test(key)) return v.length > 0 ? "set" : "missing";
  return v.length > 0 ? "set" : "missing";
}

async function checkSpApi(pgUrl: string): Promise<Record<string, unknown>> {
  if (!pgUrl.includes(ORIGINAL)) return { checked: false, reason: "pg_not_original" };
  const c = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const mp = await c.query(
    `SELECT credentials FROM marketplaces WHERE organization_id=$1::uuid AND provider='amazon_sp_api' LIMIT 1`,
    [ORG_ID],
  );
  const cred = mp.rows[0]?.credentials as Record<string, unknown> | undefined;
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
  await c.end();
  return { checked: true, lwa_complete: lwa, aws_in_db: awsDb };
}

async function main(): Promise<void> {
  const file = path.join(process.cwd(), ".env.vercel-production");
  const env = parseEnvFile(file);

  const required = {
    vercel_runtime: [
      "NEXT_PUBLIC_SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "ENABLE_AMAZON_REPORTS_API_WORKER",
      "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER",
      "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT",
      "CRON_SECRET",
      "ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON",
      "DIRECT_POSTGRES_URL",
    ],
    local_script_apply: [
      "ORIGINAL_DIRECT_POSTGRES_URL",
      "ORIGINAL_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL",
      "ORIGINAL_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY",
      "APPROVED_PRODUCTION_WAREHOUSE_GO_LIVE_SYNC=true",
    ],
    amazon_worker_optional_env: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
    amazon_worker_db: ["marketplaces.credentials (LWA + refresh + AWS) or organization_api_keys"],
  };

  const keys = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ENABLE_AMAZON_REPORTS_API_WORKER",
    "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER",
    "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT",
    "CRON_SECRET",
    "ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON",
    "DIRECT_POSTGRES_URL",
    "ORIGINAL_DIRECT_POSTGRES_URL",
    "ORIGINAL_PROJECT_REF",
    "STAGING_PROJECT_REF",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ] as const;

  const present: Record<string, boolean> = {};
  const safe: Record<string, string> = {};
  for (const k of keys) {
    const v = env[k]?.trim() ?? "";
    present[k] = Boolean(v);
    safe[k] = safeVal(k, v);
  }

  const urlRef = env.NEXT_PUBLIC_SUPABASE_URL ? refFromUrl(env.NEXT_PUBLIC_SUPABASE_URL) : null;
  const pgRef = env.DIRECT_POSTGRES_URL ? refFromPg(env.DIRECT_POSTGRES_URL) : null;
  const originalPgRef = env.ORIGINAL_DIRECT_POSTGRES_URL
    ? refFromPg(env.ORIGINAL_DIRECT_POSTGRES_URL)
    : null;
  const productionPgOk = originalPgRef === ORIGINAL || pgRef === ORIGINAL;
  const wrong: string[] = [];
  if (urlRef !== ORIGINAL) wrong.push(`NEXT_PUBLIC_SUPABASE_URL ref=${urlRef ?? "missing"} (need ${ORIGINAL})`);
  if (!productionPgOk) {
    wrong.push(
      `production postgres ref missing (DIRECT=${pgRef ?? "missing"}, ORIGINAL_DIRECT=${originalPgRef ?? "missing"})`,
    );
  }
  if (urlRef === STAGING) wrong.push("NEXT_PUBLIC_SUPABASE_URL points at STAGING");
  if (env.ORIGINAL_PROJECT_REF?.trim() && env.ORIGINAL_PROJECT_REF.trim() !== ORIGINAL) {
    wrong.push(`ORIGINAL_PROJECT_REF=${env.ORIGINAL_PROJECT_REF}`);
  }

  const apiOk =
    flagOn(env.ENABLE_AMAZON_REPORTS_API_WORKER) &&
    flagOn(env.ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER) &&
    flagOn(env.ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT);

  const missing = keys.filter((k) => !present[k]);
  const awsEnv = Boolean(env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim());
  let spApi = await checkSpApi(env.DIRECT_POSTGRES_URL ?? "");
  const spReady = Boolean(
    spApi.checked && spApi.lwa_complete && (spApi.aws_in_db || awsEnv),
  );
  if (spApi.checked && !spReady) wrong.push("SP-API credentials incomplete in original DB (and no AWS env fallback)");

  const safeToRun =
    missing.length === 0 &&
    urlRef === ORIGINAL &&
    productionPgOk &&
    apiOk &&
    flagOn(env.ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON) &&
    present.CRON_SECRET &&
    spReady &&
    wrong.length === 0;

  console.log(
    JSON.stringify(
      {
        env_file: file,
        env_file_exists: fs.existsSync(file),
        required_env_vars: required,
        present,
        safe,
        missing_env_vars: missing,
        wrong_env_risks: wrong,
        api_flags_enabled: apiOk,
        sp_api: { ...spApi, aws_in_env: awsEnv, ready: spReady },
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
