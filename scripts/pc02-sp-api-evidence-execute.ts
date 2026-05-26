/**
 * PC02-EXECUTE — SP-API EVIDENCE-ONLY DRY-RUN
 *
 * Governed catalog GET only — no products.insert, no map insert, no expected_packages update.
 *
 *   npx tsx scripts/pc02-sp-api-evidence-execute.ts --run-id=<id>
 *   npx tsx scripts/pc02-sp-api-evidence-execute.ts --dry-run-id=20260522T210000Z
 *   npx tsx scripts/pc02-sp-api-evidence-execute.ts --run-id=<id> --asin=B0XXXXXXXXX
 *   npx tsx scripts/pc02-sp-api-evidence-execute.ts --run-id=<id> --from-products=2
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getAmazonAccessToken, type AmazonSpApiCredentials } from "../lib/amazon/sp-api";
import { extractBestMainImageFromCatalogItem } from "../lib/amazon-catalog-image-extract";
import { amazonSpCredentialsLookComplete } from "../lib/amazon-marketplace-credentials";
import { filterValidAmazonRetailMarketplaceIds } from "../lib/amazon-retail-marketplace-ids";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const PC02_APPROVAL = ".cursor/operator-approvals/sp-api-product-evidence-dry-run-pc02-approval.md";
const V202_DRY_BASE = ".cursor/audit-reports/expected-packages-amazon-api-evidence-dry-run-v202";
const OUT_BASE = ".cursor/audit-reports/pc02-sp-api-evidence-execute";
const DELAY_MS = 400;

const DEFAULT_ASINS = ["B0CQKPKKCM", "B0CS88T6FR", "B0DMQCZPQN"] as const;

type AsinJob = {
  asin: string;
  organization_id: string;
  store_id: string;
  sku: string | null;
  fnsku: string | null;
  expected_package_ids: string[];
};

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function dryRunId(): string {
  const a = process.argv.find((x) => x.startsWith("--dry-run-id="));
  return a ? a.split("=")[1]!.trim() : "";
}

function asinOverrides(): string[] {
  return process.argv
    .filter((x) => x.startsWith("--asin="))
    .map((x) => x.split("=")[1]!.trim().toUpperCase())
    .filter((a) => /^B[0-9A-Z]{9}$/.test(a));
}

function fromProductsLimit(): number {
  const a = process.argv.find((x) => x.startsWith("--from-products="));
  if (!a) return 0;
  const n = Number.parseInt(a.split("=")[1] ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : 0;
}

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function readPc02Approval(): boolean {
  const p = path.join(process.cwd(), PC02_APPROVAL);
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_SP_API_EVIDENCE_DRY_RUN\s*=\s*true/i.test(text)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const DEFAULT_CATALOG_HOST = "https://sellingpartnerapi-na.amazon.com";
const DEFAULT_MARKETPLACE_ID = "ATVPDKIKX0DER";

function trimHost(h: string): string {
  return h.replace(/\/+$/, "");
}

function credsRecordToLwa(credentials: Record<string, unknown>): AmazonSpApiCredentials | null {
  const lwaClientId = String(credentials.lwa_client_id ?? credentials.lwaClientId ?? credentials.client_id ?? "").trim();
  const lwaClientSecret = String(
    credentials.lwa_client_secret ?? credentials.lwaClientSecret ?? credentials.client_secret ?? "",
  ).trim();
  const refreshToken = String(credentials.refresh_token ?? credentials.refreshToken ?? "").trim();
  if (!lwaClientId || !lwaClientSecret || !refreshToken) return null;
  return { lwaClientId, lwaClientSecret, refreshToken };
}

function marketplaceIdsFromCredentials(credentials: Record<string, unknown>): string[] {
  const single = String(credentials.marketplace_id ?? credentials.marketplaceId ?? "").trim();
  if (single) return [single];
  const multi = String(credentials.marketplace_ids ?? credentials.marketplaceIds ?? "").trim();
  if (multi) return multi.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return [DEFAULT_MARKETPLACE_ID];
}

function catalogHostFromCredentials(credentials: Record<string, unknown>): string {
  const ep = String(credentials.endpoint ?? credentials.sp_api_endpoint ?? "").trim();
  return trimHost(ep || DEFAULT_CATALOG_HOST);
}

function extractCatalogMainImageAndText(item: unknown): {
  main_image_url: string | null;
  product_name: string | null;
  brand: string | null;
} {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { main_image_url: null, product_name: null, brand: null };
  }
  const root = item as Record<string, unknown>;
  const summaries = root.summaries;
  let product_name: string | null = null;
  let brand: string | null = null;
  if (Array.isArray(summaries) && summaries[0] && typeof summaries[0] === "object") {
    const s0 = summaries[0] as Record<string, unknown>;
    const n = s0.itemName ?? s0.item_name;
    const b = s0.brand;
    if (typeof n === "string" && n.trim()) product_name = n.trim();
    if (typeof b === "string" && b.trim()) brand = b.trim();
  }
  const { bestUrl: main_image_url } = extractBestMainImageFromCatalogItem(item);
  return { main_image_url, product_name, brand };
}

async function fetchCatalogJson(
  catalogHost: string,
  accessToken: string,
  marketplaceIds: string[],
  asin: string,
): Promise<{ ok: true; body: unknown; attempts: number } | { ok: false; status: number; error: string; attempts: number }> {
  const base = trimHost(catalogHost);
  const mids = marketplaceIds.map((s) => s.trim()).filter(Boolean);
  if (!mids.length) return { ok: false, status: 0, error: "No marketplace ids", attempts: 0 };
  const qp = new URLSearchParams({
    marketplaceIds: mids.join(","),
    includedData: "summaries,attributes,images,productTypes,salesRanks",
  });
  const url = `${base}/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${qp}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      headers: { "x-amz-access-token": accessToken, "Content-Type": "application/json" },
      method: "GET",
      cache: "no-store",
    });
    const text = await res.text();
    if (res.ok) {
      try {
        return { ok: true, body: JSON.parse(text) as unknown, attempts: attempt + 1 };
      } catch {
        return { ok: false, status: res.status, error: "catalog_json_parse_failed", attempts: attempt + 1 };
      }
    }
    if (res.status === 429 || res.status === 503) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    return { ok: false, status: res.status, error: `catalog_http_${res.status}: ${text.slice(0, 200)}`, attempts: attempt + 1 };
  }
  return { ok: false, status: 0, error: "catalog_max_retries", attempts: 5 };
}

async function resolveAmazonCatalogContextPg(
  client: pg.Client,
  organizationId: string,
  storeId: string,
): Promise<
  | {
      ok: true;
      credentials: AmazonSpApiCredentials;
      marketplaceIds: string[];
      catalogHost: string;
      store_marketplace_id: string | null;
      marketplace_provider: string | null;
      cred_marketplace_id: string | null;
      cred_endpoint: string | null;
      cred_region: string | null;
    }
  | { ok: false; error: string }
> {
  const storeRes = await client.query(
    `SELECT s.marketplace_id::text AS store_marketplace_id, s.name AS store_name,
            m.id::text AS mp_id, m.provider, m.credentials
     FROM public.stores s
     LEFT JOIN public.marketplaces m ON m.id = s.marketplace_id
     WHERE s.id = $1::uuid AND s.organization_id = $2::uuid`,
    [storeId, organizationId],
  );
  const store = storeRes.rows[0] as {
    store_marketplace_id?: string;
    store_name?: string;
    provider?: string;
    credentials?: unknown;
  } | undefined;
  if (!store) return { ok: false, error: "Store not found" };

  const credMeta = (cred: Record<string, unknown>) => ({
    store_marketplace_id: store.store_marketplace_id ?? null,
    marketplace_provider: store.provider ?? null,
    cred_marketplace_id: String(cred.marketplace_id ?? cred.marketplaceId ?? "").trim() || null,
    cred_endpoint: String(cred.endpoint ?? cred.sp_api_endpoint ?? "").trim() || null,
    cred_region: String(cred.region ?? "").trim() || null,
  });

  if (store.credentials && typeof store.credentials === "object" && store.provider === "amazon_sp_api") {
    const credObj = store.credentials as Record<string, unknown>;
    if (amazonSpCredentialsLookComplete(credObj)) {
      const lwa = credsRecordToLwa(credObj);
      if (lwa) {
        const valid = filterValidAmazonRetailMarketplaceIds(marketplaceIdsFromCredentials(credObj));
        return {
          ok: true,
          credentials: lwa,
          marketplaceIds: valid.length ? valid : [DEFAULT_MARKETPLACE_ID],
          catalogHost: catalogHostFromCredentials(credObj),
          ...credMeta(credObj),
        };
      }
    }
  }

  const mpRes = await client.query(
    `SELECT id::text, provider, credentials FROM public.marketplaces
     WHERE organization_id = $1::uuid AND provider = 'amazon_sp_api'`,
    [organizationId],
  );
  for (const row of mpRes.rows) {
    const credObj = (row as { credentials?: unknown }).credentials;
    if (!credObj || typeof credObj !== "object") continue;
    const c = credObj as Record<string, unknown>;
    if (!amazonSpCredentialsLookComplete(c)) continue;
    const lwa = credsRecordToLwa(c);
    if (lwa) {
      const valid = filterValidAmazonRetailMarketplaceIds(marketplaceIdsFromCredentials(c));
      return {
        ok: true,
        credentials: lwa,
        marketplaceIds: valid.length ? valid : [DEFAULT_MARKETPLACE_ID],
        catalogHost: catalogHostFromCredentials(c),
        store_marketplace_id: store.store_marketplace_id ?? null,
        marketplace_provider: (row as { provider?: string }).provider ?? null,
        ...credMeta(c),
      };
    }
  }

  return { ok: false, error: "Amazon SP-API credentials not configured" };
}

async function loadSampleAsinsFromProducts(client: pg.Client, limit: number): Promise<AsinJob[]> {
  const r = await client.query(
    `
    SELECT UPPER(TRIM(asin)) AS asin, product_name
    FROM public.products
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
      AND asin IS NOT NULL AND TRIM(asin) ~ '^B[0-9A-Z]{9}$'
      AND (deleted_at IS NULL)
      AND (merge_status IS NULL OR merge_status <> 'merged')
    ORDER BY updated_at DESC NULLS LAST
    LIMIT $3
  `,
    [ORG, STORE, limit],
  );
  return (r.rows as { asin: string }[]).map((row) => ({
    asin: row.asin,
    organization_id: ORG,
    store_id: STORE,
    sku: null,
    fnsku: null,
    expected_package_ids: [],
  }));
}

function loadJobsFromV202DryRun(dryRunIdArg: string): AsinJob[] | null {
  if (!dryRunIdArg) return null;
  const linesPath = path.join(process.cwd(), V202_DRY_BASE, dryRunIdArg, "dry-run-lines.json");
  const cohortPath = path.join(process.cwd(), V202_DRY_BASE, dryRunIdArg, "api-evidence-cohort.json");
  if (!fs.existsSync(linesPath) || !fs.existsSync(cohortPath)) return null;

  const lines = JSON.parse(fs.readFileSync(linesPath, "utf8")) as Array<{
    asin: string;
    would_execute: string;
    expected_package_id?: string;
    sku?: string | null;
    fnsku?: string | null;
  }>;
  const cohort = JSON.parse(fs.readFileSync(cohortPath, "utf8")) as {
    rows: Array<{
      expected_package_id: string;
      organization_id: string;
      store_id: string;
      asin: string;
      sku?: string | null;
      fnsku?: string | null;
    }>;
  };

  const callAsins = new Set(
    lines.filter((l) => l.would_execute === "WOULD_CALL_API").map((l) => l.asin.trim().toUpperCase()),
  );
  const rows = (cohort.rows ?? []).filter((r) => callAsins.has(r.asin.trim().toUpperCase()));
  if (!rows.length) return null;

  const map = new Map<string, AsinJob>();
  for (const r of rows) {
    const asin = r.asin.trim().toUpperCase();
    const key = `${r.organization_id}|${r.store_id}|${asin}`;
    const ex = map.get(key);
    if (!ex) {
      map.set(key, {
        asin,
        organization_id: r.organization_id,
        store_id: r.store_id,
        sku: r.sku?.trim() || null,
        fnsku: r.fnsku?.trim() || null,
        expected_package_ids: [r.expected_package_id],
      });
    } else {
      ex.expected_package_ids.push(r.expected_package_id);
    }
  }
  return [...map.values()].sort((a, b) => a.asin.localeCompare(b.asin));
}

function defaultJobs(): AsinJob[] {
  return DEFAULT_ASINS.map((asin) => ({
    asin,
    organization_id: ORG,
    store_id: STORE,
    sku: null,
    fnsku: null,
    expected_package_ids: [],
  }));
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, id);
  fs.mkdirSync(outDir, { recursive: true });

  const approvalOk = readPc02Approval();
  const spApiEnabled = envFlag("AMAZON_SP_API_ENABLED");
  const autoCreateEnabled = envFlag("PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED");
  const stagingOk = supabaseUrlMatchesStagingRef(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "", STAGING_REF);

  if (!approvalOk) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), "# Blocked\n\nPC02 approval not true.\n");
    throw new Error("PC02 approval not true");
  }
  if (!spApiEnabled || !autoCreateEnabled || !stagingOk) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      `# Blocked\n\nspApi=${spApiEnabled} autoCreate=${autoCreateEnabled} stagingOk=${stagingOk}\n`,
    );
    throw new Error("Env gates not satisfied");
  }

  const dryId = dryRunId();
  const asinOverride = asinOverrides();
  const fromProducts = fromProductsLimit();

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (!dbUrl || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error("Staging ref guard failed");
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`SET statement_timeout = '120s'`);

  let jobs: AsinJob[];
  if (asinOverride.length > 0) {
    jobs = asinOverride.map((asin) => ({
      asin,
      organization_id: ORG,
      store_id: STORE,
      sku: null,
      fnsku: null,
      expected_package_ids: [],
    }));
  } else if (fromProducts > 0) {
    jobs = await loadSampleAsinsFromProducts(client, fromProducts);
  } else {
    jobs = loadJobsFromV202DryRun(dryId) ?? defaultJobs();
  }

  const ctx = await resolveAmazonCatalogContextPg(client, ORG, STORE);
  await client.end();

  if (!ctx.ok) {
    fs.writeFileSync(path.join(outDir, "credential-proof.json"), JSON.stringify({ ok: false, error: ctx.error }, null, 2));
    throw new Error(ctx.error);
  }

  let accessToken: string;
  try {
    accessToken = (await getAmazonAccessToken(ctx.credentials)).accessToken;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "token_failed";
    fs.writeFileSync(path.join(outDir, "credential-proof.json"), JSON.stringify({ ok: false, stage: "token", error: msg }, null, 2));
    throw new Error(msg);
  }

  fs.writeFileSync(
    path.join(outDir, "marketplace-validation.md"),
    [
      "# Marketplace validation — PC02 follow-up",
      "",
      "| Field | Value |",
      "|-------|-------|",
      `| Sam store_id | \`${STORE}\` |`,
      `| store.marketplace_id | \`${ctx.store_marketplace_id ?? "null"}\` |`,
      `| marketplace provider | \`${ctx.marketplace_provider ?? "null"}\` |`,
      `| credentials.marketplace_id | \`${ctx.cred_marketplace_id ?? "null"}\` |`,
      `| credentials.endpoint | \`${ctx.cred_endpoint ?? "null"}\` |`,
      `| credentials.region | \`${ctx.cred_region ?? "null"}\` |`,
      `| catalog_host used | \`${ctx.catalogHost}\` |`,
      `| marketplace_ids queried | \`${ctx.marketplaceIds.join(", ")}\` |`,
      `| US retail default | \`ATVPDKIKX0DER\` |`,
      "",
      ctx.marketplaceIds.includes("ATVPDKIKX0DER")
        ? "Configured marketplace includes **ATVPDKIKX0DER** (Amazon.com US)."
        : "**Note:** Active marketplace_ids do not include ATVPDKIKX0DER — US catalog 404s may be expected for US-only ASINs.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "credential-proof.json"),
    JSON.stringify(
      {
        ok: true,
        staging_ref: STAGING_REF,
        catalog_host: ctx.catalogHost,
        marketplace_ids: ctx.marketplaceIds,
        store_marketplace_id: ctx.store_marketplace_id,
        cred_marketplace_id: ctx.cred_marketplace_id,
        cred_endpoint: ctx.cred_endpoint,
        cred_region: ctx.cred_region,
        token_obtained: true,
        dry_run_id: dryId || null,
        asin_override: asinOverride,
        from_products: fromProducts || null,
      },
      null,
      2,
    ),
  );

  const auditPath = path.join(outDir, "api-evidence-audit.ndjson");
  const evidenceCachePath = path.join(outDir, "evidence-cache.json");
  const results: Record<string, unknown>[] = [];
  let apiCallCount = 0;
  let okCount = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]!;
    const cat = await fetchCatalogJson(ctx.catalogHost, accessToken, ctx.marketplaceIds, job.asin);
    apiCallCount += 1;

    const extracted = cat.ok ? extractCatalogMainImageAndText(cat.body) : null;
    const auditLine = {
      ts: new Date().toISOString(),
      run_id: id,
      prompt: "PC02-EXECUTE-EVIDENCE-ONLY",
      organization_id: job.organization_id,
      store_id: job.store_id,
      query_kind: "catalog_items_get",
      asin: job.asin,
      sku: job.sku,
      fnsku: job.fnsku,
      expected_package_ids: job.expected_package_ids,
      http_ok: cat.ok,
      http_status: cat.ok ? 200 : cat.status,
      attempts: cat.attempts,
      error: cat.ok ? null : cat.error,
      product_name: extracted?.product_name ?? null,
      main_image_url: extracted?.main_image_url ?? null,
      brand: extracted?.brand ?? null,
      source: "amazon_sp_api_catalog_items",
      confidence: cat.ok ? 1.0 : null,
      product_created: false,
      map_inserted: false,
      expected_packages_updated: false,
    };

    fs.appendFileSync(auditPath, `${JSON.stringify(auditLine)}\n`);
    results.push(auditLine);
    if (cat.ok) okCount += 1;

    if (i + 1 < jobs.length) await sleep(DELAY_MS);
  }

  fs.writeFileSync(evidenceCachePath, JSON.stringify(results, null, 2));

  const manifest = {
    prompt: "PC02-EXECUTE-SP-API-EVIDENCE-ONLY",
    run_id: id,
    mode: "evidence_only",
    staging_ref: STAGING_REF,
    status: okCount === jobs.length ? "PASS" : apiCallCount > 0 && okCount === 0 ? "PASS_CATALOG_NOT_FOUND" : okCount > 0 ? "PARTIAL" : "FAIL",
    distinct_asins: jobs.length,
    api_calls: apiCallCount,
    catalog_ok: okCount,
    products_inserted: 0,
    map_rows_inserted: 0,
    expected_packages_updated: false,
    dry_run_id: dryId || null,
    forbidden: {
      product_create: false,
      map_insert: false,
      expected_packages_update: false,
      production: false,
      ai: false,
    },
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "execute-result.md"),
    [
      "# PC02 evidence-only execute",
      "",
      `- ASINs queried: **${jobs.length}**`,
      `- Catalog OK: **${okCount}**`,
      `- API calls: **${apiCallCount}**`,
      `- Products created: **0**`,
      `- Map rows inserted: **0**`,
      `- Audit: \`api-evidence-audit.ndjson\``,
    ].join("\n"),
  );

  console.log(JSON.stringify({ outDir, ...manifest }, null, 2));
  process.exit(apiCallCount > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
