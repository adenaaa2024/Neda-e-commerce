/**
 * PRODUCTION_SYNC_FINAL_VERIFICATION — read-only, original/live only.
 */
import { createRequire, type Module } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { PRODUCTION_REF } from "../lib/production-db-bind";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const ORIGINAL = PRODUCTION_REF;
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function refFromUrl(url: string): string | null {
  return url.match(/https:\/\/([a-z]{20})\.supabase/)?.[1] ?? null;
}

function jwtRef(token: string): string | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { ref?: string };
    return json.ref ?? null;
  } catch {
    return null;
  }
}

function daysStale(iso: string | null, today = new Date()): number | null {
  if (!iso) return null;
  const d = new Date(iso.slice(0, 10) + "T12:00:00Z");
  const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return Math.floor((t.getTime() - d.getTime()) / 86_400_000);
}

function searchEnvKeys(env: Record<string, string>, patterns: RegExp[]): Record<string, "found" | "missing"> {
  const out: Record<string, "found" | "missing"> = {};
  for (const p of patterns) {
    const label = p.source.replace(/\\b/g, "").replace(/[()]/g, "");
    const hit = Object.keys(env).some((k) => p.test(k) && Boolean(env[k]?.trim()));
    out[label] = hit ? "found" : "missing";
  }
  return out;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();

  const vercelEnvNames: string[] = [];
  try {
    const ls = execSync("npx vercel env ls production", { encoding: "utf8", cwd: process.cwd() });
    for (const line of ls.split(/\r?\n/)) {
      const m = line.match(/^\s+([A-Z0-9_]+)\s+/);
      if (m) vercelEnvNames.push(m[1]!);
    }
  } catch {
    /* optional */
  }

  let cronCli = "unknown";
  try {
    cronCli = execSync("npx vercel crons ls", { encoding: "utf8", cwd: process.cwd() });
  } catch {
    /* optional */
  }

  let prodBundleRef: string | null = null;
  try {
    const chunk = execSync(
      'powershell -NoProfile -Command "(Invoke-WebRequest -Uri \'https://menorix.com/_next/static/chunks/455c4d7c72c88ba0.js\' -UseBasicParsing).Content"',
      { encoding: "utf8", cwd: process.cwd(), timeout: 30_000 },
    );
    if (chunk.includes(ORIGINAL)) prodBundleRef = ORIGINAL;
    else if (chunk.includes("eiqfaapyumhixxoeltgu")) prodBundleRef = "eiqfaapyumhixxoeltgu";
  } catch {
    /* optional */
  }

  const localEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k && v) localEnv[k] = v;
  }

  const originalUrl = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  const originalKey = process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ?? "";
  const pgUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";

  const urlRefLocal = refFromUrl(originalUrl);
  const keyRefLocal = jwtRef(originalKey);

  const required = {
    amazon_report_workers: [
      "ENABLE_AMAZON_REPORTS_API_WORKER",
      "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER",
      "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT",
      "NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL (runtime)",
      "SUPABASE_SERVICE_ROLE_KEY",
      "AWS_ACCESS_KEY_ID (optional if in DB)",
      "AWS_SECRET_ACCESS_KEY (optional if in DB)",
      "AWS_REGION (optional)",
      "REPORTS_API_INTERNAL_BASE_URL (optional)",
      "REPORTS_API_PIPELINE_USE_HTTP (optional)",
    ],
    removal_sync_script: [
      "ORIGINAL_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL → original ref",
      "ORIGINAL_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY → same ref",
      "ORIGINAL_DIRECT_POSTGRES_URL → original ref",
      "APPROVED_PRODUCTION_WAREHOUSE_GO_LIVE_SYNC=true (apply only)",
    ],
    nightly_cron: [
      "CRON_SECRET",
      "ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON=true",
      "NEXT_PUBLIC_SUPABASE_URL → original ref",
      "ORIGINAL_DIRECT_POSTGRES_URL (required by runProductionRemovalSync)",
      "ENABLE_AMAZON_REPORTS_API_* (forced true in sync run, but not in cron path before bind)",
    ],
    db_credentials: [
      "stores.marketplaces.credentials: lwa_client_id, lwa_client_secret, refresh_token, aws_access_key, aws_secret_key",
    ],
  };

  const vercelPresent = (name: string) => vercelEnvNames.includes(name);

  const amazonEnvSearch = searchEnvKeys(localEnv, [
    /AMAZON/i,
    /SP_API/i,
    /LWA/i,
    /^AWS_/i,
    /REFRESH_TOKEN/i,
  ]);

  const vercelAmazonSearch: Record<string, "found" | "missing"> = {
    AMAZON: vercelEnvNames.some((k) => /AMAZON/i.test(k)) ? "found" : "missing",
    SP_API: vercelEnvNames.some((k) => /SP_API/i.test(k)) ? "found" : "missing",
    LWA: vercelEnvNames.some((k) => /LWA/i.test(k)) ? "found" : "missing",
    AWS: vercelEnvNames.some((k) => /^AWS_/i.test(k)) ? "found" : "missing",
    REFRESH_TOKEN: vercelEnvNames.some((k) => /REFRESH_TOKEN/i.test(k)) ? "found" : "missing",
  };

  const c = new pg.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();

  const imports = await c.query(
    `SELECT report_type, status, max(created_at)::text AS last_at
     FROM raw_report_uploads
     WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT')
     GROUP BY report_type, status
     ORDER BY report_type, status`,
    [ORG_ID],
  );

  const lastSuccess = await c.query(
    `SELECT report_type, max(created_at)::text AS last_at
     FROM raw_report_uploads
     WHERE organization_id=$1::uuid AND report_type IN ('REMOVAL_ORDER','REMOVAL_SHIPMENT') AND status='success'
     GROUP BY report_type`,
    [ORG_ID],
  );

  const latestShipment = await c.query(
    `SELECT max(shipment_date)::text AS d FROM amazon_removal_shipments WHERE organization_id=$1::uuid`,
    [ORG_ID],
  );
  const latestOrder = await c.query(
    `SELECT max(request_date)::text AS d FROM amazon_removals WHERE organization_id=$1::uuid`,
    [ORG_ID],
  );
  const epDerived = await c.query(
    `SELECT max(updated_at)::text AS d, count(*)::bigint AS n
     FROM expected_packages WHERE organization_id=$1::uuid
       AND build_source IN ('detail_shipment','detail_remainder')`,
    [ORG_ID],
  );

  const storeCred = await c.query(
    `SELECT m.credentials FROM stores s
     JOIN marketplaces m ON m.id = s.marketplace_id
     WHERE s.id=$1::uuid AND s.organization_id=$2::uuid`,
    [STORE_ID, ORG_ID],
  );
  const cred = storeCred.rows[0]?.credentials as Record<string, unknown> | undefined;
  const credKeys = cred && typeof cred === "object" ? Object.keys(cred).sort() : [];
  const credFound = {
    lwa_client_id: Boolean(String(cred?.lwa_client_id ?? cred?.lwaClientId ?? "").trim()),
    lwa_client_secret: Boolean(String(cred?.lwa_client_secret ?? cred?.lwaClientSecret ?? "").trim()),
    refresh_token: Boolean(String(cred?.refresh_token ?? cred?.refreshToken ?? "").trim()),
    aws_access_key: Boolean(String(cred?.aws_access_key ?? cred?.aws_access_key_id ?? "").trim()),
    aws_secret_key: Boolean(String(cred?.aws_secret_key ?? cred?.aws_secret_access_key ?? "").trim()),
    seller_id: Boolean(String(cred?.seller_id ?? "").trim()),
    marketplace_id: Boolean(String(cred?.marketplace_id ?? "").trim()),
  };

  await c.end();

  const { resolveReportsApiContext } = await import("../lib/amazon/reports-api-credentials");
  process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  process.env.SUPABASE_URL = originalUrl;
  const spApi = await resolveReportsApiContext(ORG_ID, STORE_ID);

  const vercelJson = fs.existsSync(path.join(process.cwd(), "vercel.json"))
    ? JSON.parse(fs.readFileSync(path.join(process.cwd(), "vercel.json"), "utf8"))
    : {};

  const cronDeployed = /not deployed/i.test(cronCli);
  const cronRouteInRepo = Boolean(
    fs.existsSync(path.join(process.cwd(), "app/api/cron/removal-nightly-sync/route.ts")),
  );

  const localOriginalReady =
    urlRefLocal === ORIGINAL &&
    keyRefLocal === ORIGINAL &&
    pgUrl.includes(ORIGINAL) &&
    spApi.ok;

  const vercelUrlOk = prodBundleRef === ORIGINAL;
  const vercelCronVars =
    vercelPresent("CRON_SECRET") &&
    vercelPresent("ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON") &&
    vercelPresent("ENABLE_AMAZON_REPORTS_API_WORKER") &&
    vercelPresent("ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER") &&
    vercelPresent("ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT");

  const safeLocalScript = localOriginalReady;
  const safeVercelCron = vercelUrlOk && vercelCronVars && !cronDeployed === false && vercelPresent("ORIGINAL_DIRECT_POSTGRES_URL");

  const today = new Date();
  const successMap = Object.fromEntries(
    lastSuccess.rows.map((r) => [r.report_type as string, r.last_at as string]),
  );

  const report = {
    target_ref: ORIGINAL,
    required_env_vars: required,
    supabase_url: {
      local_ORIGINAL_SUPABASE_URL_ref: urlRefLocal,
      vercel_production_build_bundle_ref: prodBundleRef,
      belongs_to_kxsvedvpjldygtdbylsy: urlRefLocal === ORIGINAL && vercelUrlOk,
    },
    service_role_key: {
      local_ORIGINAL_SERVICE_ROLE_KEY_jwt_ref: keyRefLocal,
      matches_original_project: keyRefLocal === ORIGINAL,
      vercel_SUPABASE_SERVICE_ROLE_KEY: vercelPresent("SUPABASE_SERVICE_ROLE_KEY") ? "name_present_encrypted" : "missing",
    },
    amazon_credentials: {
      env_var_name_search_local: amazonEnvSearch,
      env_var_name_search_vercel: vercelAmazonSearch,
      note: "SP-API lives in DB for production store; env AMAZON_* not required when DB complete",
      db_store_credential_fields: credFound,
      resolveReportsApiContext: spApi.ok ? "ok_token_obtained" : { error: spApi.error },
    },
    vercel_production_env_names: {
      present: vercelEnvNames.filter((k) =>
        [
          "NEXT_PUBLIC_SUPABASE_URL",
          "SUPABASE_SERVICE_ROLE_KEY",
          "DIRECT_POSTGRES_URL",
          "ORIGINAL_DIRECT_POSTGRES_URL",
          "ENABLE_AMAZON_REPORTS_API_WORKER",
          "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER",
          "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT",
          "CRON_SECRET",
          "ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON",
        ].includes(k),
      ),
      missing_on_vercel: [
        "NEXT_PUBLIC_SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "DIRECT_POSTGRES_URL",
        "ORIGINAL_DIRECT_POSTGRES_URL",
        "ENABLE_AMAZON_REPORTS_API_WORKER",
        "ENABLE_AMAZON_REPORTS_API_REMOVAL_ORDER",
        "ENABLE_AMAZON_REPORTS_API_REMOVAL_SHIPMENT",
        "CRON_SECRET",
        "ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON",
      ].filter((k) => !vercelPresent(k)),
    },
    cron: {
      route: "/api/cron/removal-nightly-sync",
      route_file_in_repo: cronRouteInRepo,
      vercel_json_schedule: vercelJson?.crons?.[0]?.schedule ?? null,
      vercel_cli_status: cronCli.trim().split(/\r?\n/).slice(-4).join(" | "),
      deployed: !cronDeployed,
    },
    data_freshness: {
      as_of_utc: today.toISOString(),
      REMOVAL_ORDER_last_success_import: successMap.REMOVAL_ORDER ?? null,
      REMOVAL_ORDER_stale_days: daysStale(successMap.REMOVAL_ORDER ?? null, today),
      REMOVAL_SHIPMENT_last_success_import: successMap.REMOVAL_SHIPMENT ?? null,
      REMOVAL_SHIPMENT_stale_days: daysStale(successMap.REMOVAL_SHIPMENT ?? null, today),
      import_status_breakdown: imports.rows,
      latest_amazon_removal_order_date: (latestOrder.rows[0] as { d?: string })?.d ?? null,
      latest_amazon_removal_shipment_date: (latestShipment.rows[0] as { d?: string })?.d ?? null,
      expected_packages_derived_max_updated_at: (epDerived.rows[0] as { d?: string })?.d ?? null,
      expected_packages_derived_count: Number((epDerived.rows[0] as { n?: string })?.n ?? 0),
      shipment_domain_stale_days: daysStale(
        (latestShipment.rows[0] as { d?: string })?.d ?? null,
        today,
      ),
    },
    manual_sync: {
      option_b_local_script_ready: safeLocalScript,
      option_a_vercel_ui_needs_flags: vercelCronVars,
      option_c_cron_ready: safeVercelCron,
    },
    SAFE_TO_RUN_SYNC_NOW: safeLocalScript ? "yes" : "no",
    exact_command_if_yes: safeLocalScript
      ? "APPROVED_PRODUCTION_WAREHOUSE_GO_LIVE_SYNC=true npx tsx scripts/production-removal-sync-through-today.ts --apply"
      : null,
    exact_ui_path_if_yes: safeLocalScript
      ? "https://menorix.com/platform/settings/automation → Removal → manual window through today → Run removal order + removal shipment (partial: no expected_packages rebuild)"
      : null,
    recommended: safeLocalScript ? "Option B script (full fetch + import + rebuild)" : null,
  };

  const outDir = path.join(process.cwd(), ".cursor/audit-reports/production-warehouse-go-live");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `final-verification-${today.toISOString().replace(/[:.]/g, "").slice(0, 15)}Z.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
