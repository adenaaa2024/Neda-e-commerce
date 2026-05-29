/**
 * PC03D-EXEC — EXPECTED PACKAGES AMAZON EVIDENCE DRY-RUN EXECUTE
 *
 * Phase 1: FBA inventory summaries lookup per X-FNSKU (sellerSku param).
 * Phase 2: Catalog GET for ASINs resolved in Phase 1.
 * No DB writes. No product create. No map insert. No expected_packages update.
 *
 *   npx tsx scripts/pc03d-expected-packages-amazon-evidence-dry-run-execute.ts --run-id=<UTC_Z>
 *   npx tsx scripts/pc03d-expected-packages-amazon-evidence-dry-run-execute.ts --plan-run-id=20260528T100000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { getAmazonAccessToken, type AmazonSpApiCredentials } from "../lib/amazon/sp-api";
import { extractBestMainImageFromCatalogItem } from "../lib/amazon-catalog-image-extract";
import { amazonSpCredentialsLookComplete } from "../lib/amazon-marketplace-credentials";
import { filterValidAmazonRetailMarketplaceIds } from "../lib/amazon-retail-marketplace-ids";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const PLAN_DEFAULT = "20260528T100000Z";
const PLAN_BASE = ".cursor/audit-reports/pc03d-expected-packages-amazon-evidence-queue-plan";
const APPROVAL_PATH = ".cursor/operator-approvals/pc03d-expected-packages-amazon-evidence-approval.md";
const OUT_BASE = ".cursor/audit-reports/pc03d-amazon-evidence-dry-run-execute";
const DEFAULT_MARKETPLACE_ID = "ATVPDKIKX0DER";
const DEFAULT_CATALOG_HOST = "https://sellingpartnerapi-na.amazon.com";
const DELAY_MS = 400;
const MAX_INVENTORY_SCAN_PAGES = 15;

type ReadinessRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string;
  source_fnsku: string | null;
  planned_primary_identifier: string | null;
  planned_call_type: string;
};

type Phase1Result = {
  expected_package_id: string;
  fnsku: string;
  call_type: "fba_inventory_by_fnsku";
  endpoint: string;
  http_ok: boolean;
  http_status: number;
  attempts: number;
  error: string | null;
  resolved_asin: string | null;
  resolved_seller_sku: string | null;
  resolved_fn_sku: string | null;
  product_name: string | null;
  condition: string | null;
  inventory_summaries_count: number;
  raw_sample: string | null;
};

type Phase2Job = {
  asin: string;
  expected_package_ids: string[];
  source_fnskus: string[];
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function planRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--plan-run-id="));
  return a ? a.split("=")[1]!.trim() : PLAN_DEFAULT;
}

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function readApproval(): { valid: boolean; runStaging: boolean; pc03dDryRun: boolean } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runStaging = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const pc03dDryRun = /APPROVED_PC03D_AMAZON_EVIDENCE_DRY_RUN\s*=\s*true/i.test(text);
  return { valid: runStaging && pc03dDryRun, runStaging, pc03dDryRun };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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

function isLikelyAsin(v: string | null | undefined): boolean {
  return !!v && /^B[0-9A-Z]{9}$/i.test(v.trim());
}

async function resolveAmazonCatalogContextPg(
  client: pg.Client,
  organizationId: string,
  storeId: string,
): Promise<
  | { ok: true; credentials: AmazonSpApiCredentials; marketplaceIds: string[]; catalogHost: string }
  | { ok: false; error: string }
> {
  const storeRes = await client.query(
    `SELECT s.marketplace_id::text, m.provider, m.credentials
     FROM public.stores s
     LEFT JOIN public.marketplaces m ON m.id = s.marketplace_id
     WHERE s.id = $1::uuid AND s.organization_id = $2::uuid`,
    [storeId, organizationId],
  );
  const store = storeRes.rows[0] as { provider?: string; credentials?: unknown } | undefined;
  if (!store) return { ok: false, error: "Store not found" };

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
        };
      }
    }
  }

  const mpRes = await client.query(
    `SELECT credentials FROM public.marketplaces
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
      };
    }
  }
  return { ok: false, error: "Amazon SP-API credentials not configured" };
}

type SpFetchResult =
  | { ok: true; status: number; body: unknown; attempts: number; url: string }
  | { ok: false; status: number; error: string; attempts: number; url: string; raw: string };

async function fetchSpApiJson(
  url: string,
  accessToken: string,
): Promise<SpFetchResult> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      headers: { "x-amz-access-token": accessToken, "Content-Type": "application/json" },
      method: "GET",
      cache: "no-store",
    });
    const text = await res.text();
    if (res.ok) {
      try {
        return { ok: true, status: res.status, body: JSON.parse(text) as unknown, attempts: attempt + 1, url };
      } catch {
        return { ok: false, status: res.status, error: "json_parse_failed", attempts: attempt + 1, url, raw: text };
      }
    }
    if (res.status === 429 || res.status === 503) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    return {
      ok: false,
      status: res.status,
      error: `http_${res.status}`,
      attempts: attempt + 1,
      url,
      raw: text.slice(0, 500),
    };
  }
  return { ok: false, status: 0, error: "max_retries", attempts: 5, url, raw: "" };
}

function inventorySummariesFromBody(body: unknown): Array<Record<string, unknown>> {
  if (!body || typeof body !== "object") return [];
  const root = body as Record<string, unknown>;
  const payload = root.payload;
  if (!payload || typeof payload !== "object") return [];
  const summaries = (payload as Record<string, unknown>).inventorySummaries;
  if (!Array.isArray(summaries)) return [];
  return summaries.filter((s) => s && typeof s === "object") as Array<Record<string, unknown>>;
}

function pickSummaryForFnsku(
  summaries: Array<Record<string, unknown>>,
  targetFnsku: string,
): Record<string, unknown> | null {
  const t = targetFnsku.trim().toUpperCase();
  const exact = summaries.find((s) => String(s.fnSku ?? s.fnsku ?? "").trim().toUpperCase() === t);
  if (exact) return exact;
  if (summaries.length === 1) return summaries[0]!;
  return null;
}

function extractInventoryEvidence(summary: Record<string, unknown>): {
  asin: string | null;
  seller_sku: string | null;
  fn_sku: string | null;
  product_name: string | null;
  condition: string | null;
} {
  const asinRaw = summary.asin ?? summary.ASIN;
  const asin = typeof asinRaw === "string" && isLikelyAsin(asinRaw) ? asinRaw.trim().toUpperCase() : null;
  const sellerSku = summary.sellerSku ?? summary.seller_sku;
  const fnSku = summary.fnSku ?? summary.fnsku;
  const productName = summary.productName ?? summary.product_name;
  const condition = summary.condition;
  return {
    asin,
    seller_sku: typeof sellerSku === "string" ? sellerSku.trim() : null,
    fn_sku: typeof fnSku === "string" ? fnSku.trim() : null,
    product_name: typeof productName === "string" ? productName.trim() : null,
    condition: typeof condition === "string" ? condition.trim() : null,
  };
}

function buildInventoryUrl(host: string, marketplaceId: string, sellerSku?: string, nextToken?: string): string {
  const base = trimHost(host);
  const qp = new URLSearchParams({
    details: "true",
    granularityType: "Marketplace",
    granularityId: marketplaceId,
    marketplaceIds: marketplaceId,
  });
  if (sellerSku) qp.set("sellerSku", sellerSku.trim());
  if (nextToken) qp.set("nextToken", nextToken);
  return `${base}/fba/inventory/v1/summaries?${qp}`;
}

async function fetchInventoryBySellerSku(
  host: string,
  accessToken: string,
  marketplaceId: string,
  fnsku: string,
): Promise<SpFetchResult> {
  const url = buildInventoryUrl(host, marketplaceId, fnsku);
  return fetchSpApiJson(url, accessToken);
}

async function scanInventoryForFnsku(
  host: string,
  accessToken: string,
  marketplaceId: string,
  targetFnsku: string,
): Promise<{ summary: Record<string, unknown> | null; pages: number; lastUrl: string }> {
  const t = targetFnsku.trim().toUpperCase();
  let nextToken: string | undefined;
  let pages = 0;
  let lastUrl = "";
  while (pages < MAX_INVENTORY_SCAN_PAGES) {
    const url = buildInventoryUrl(host, marketplaceId, undefined, nextToken);
    lastUrl = url;
    const res = await fetchSpApiJson(url, accessToken);
    pages += 1;
    if (!res.ok) return { summary: null, pages, lastUrl };
    const summaries = inventorySummariesFromBody(res.body);
    const hit = summaries.find((s) => String(s.fnSku ?? s.fnsku ?? "").trim().toUpperCase() === t);
    if (hit) return { summary: hit, pages, lastUrl };
    const root = res.body as Record<string, unknown>;
    const payload = root.payload as Record<string, unknown> | undefined;
    const nt = payload?.nextToken ?? payload?.next_token;
    if (typeof nt === "string" && nt.trim()) {
      nextToken = nt.trim();
      await sleep(DELAY_MS);
      continue;
    }
    break;
  }
  return { summary: null, pages, lastUrl };
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
): Promise<SpFetchResult> {
  const base = trimHost(catalogHost);
  const qp = new URLSearchParams({
    marketplaceIds: marketplaceIds.join(","),
    includedData: "summaries,attributes,images,identifiers",
  });
  const url = `${base}/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${qp}`;
  return fetchSpApiJson(url, accessToken);
}

type WriteSnapshot = {
  products_total: number;
  map_total: number;
  cohort_ep_max_updated_at: string | null;
};

async function writeSnapshot(client: pg.Client, epIds: string[]): Promise<WriteSnapshot> {
  const [p, m, ep] = await Promise.all([
    client.query(`SELECT COUNT(*)::int AS c FROM public.products WHERE organization_id = $1::uuid`, [ORG]),
    client.query(`SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE organization_id = $1::uuid`, [ORG]),
    epIds.length
      ? client.query(
          `SELECT MAX(updated_at)::text AS max_u FROM public.expected_packages WHERE id = ANY($1::uuid[])`,
          [epIds],
        )
      : Promise.resolve({ rows: [{ max_u: null }] }),
  ]);
  return {
    products_total: (p.rows[0] as { c: number }).c,
    map_total: (m.rows[0] as { c: number }).c,
    cohort_ep_max_updated_at: (ep.rows[0] as { max_u: string | null }).max_u,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const planRunId = planRunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const spApiEnabled = envFlag("AMAZON_SP_API_ENABLED");
  const stagingUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const stagingRef = getStagingProjectRef({ loadEnv: false });
  const stagingOk = supabaseUrlMatchesStagingRef(stagingUrl, STAGING_REF);

  const planDir = path.join(process.cwd(), PLAN_BASE, planRunId);
  const readinessPath = path.join(planDir, "identifier-readiness.json");
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) blockers.push(`branch=${branch}`);
  if (!approval.valid) blockers.push("PC03D approval flags not both true");
  if (!spApiEnabled) blockers.push("AMAZON_SP_API_ENABLED not true");
  if (!stagingOk || stagingRef !== STAGING_REF) blockers.push("staging ref guard failed");
  if (refFromSupabaseUrl(stagingUrl) === ORIGINAL_REF) blockers.push("original ref targeted");
  if (!fs.existsSync(readinessPath)) blockers.push(`Missing ${readinessPath}`);

  let cohort: ReadinessRow[] = [];
  if (fs.existsSync(readinessPath)) {
    cohort = JSON.parse(fs.readFileSync(readinessPath, "utf8")) as ReadinessRow[];
    if (cohort.length !== 5) blockers.push(`Expected 5 evidence rows, got ${cohort.length}`);
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof — PC03D",
      "",
      `| APPROVED_TO_RUN_STAGING | ${approval.runStaging} |`,
      `| APPROVED_PC03D_AMAZON_EVIDENCE_DRY_RUN | ${approval.pc03dDryRun} |`,
      `| valid | **${approval.valid}** |`,
      `| plan_run_id | \`${planRunId}\` |`,
    ].join("\n") + "\n",
  );

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    throw new Error(blockers.join("; "));
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error("STAGING_DIRECT_POSTGRES_URL guard failed");
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`SET statement_timeout = '120s'`);

  const epIds = cohort.map((r) => r.expected_package_id);
  const beforeSnap = await writeSnapshot(client, epIds);

  const ctx = await resolveAmazonCatalogContextPg(client, ORG, STORE);
  if (!ctx.ok) {
    await client.end();
    throw new Error(ctx.error);
  }

  const accessToken = (await getAmazonAccessToken(ctx.credentials)).accessToken;
  const marketplaceId = ctx.marketplaceIds[0] ?? DEFAULT_MARKETPLACE_ID;
  const apiHost = ctx.catalogHost;

  const phase1Results: Phase1Result[] = [];
  let apiCallCount = 0;

  for (let i = 0; i < cohort.length; i++) {
    const row = cohort[i]!;
    const fnsku = (row.source_fnsku ?? row.planned_primary_identifier ?? "").trim();
    let res = await fetchInventoryBySellerSku(apiHost, accessToken, marketplaceId, fnsku);
    apiCallCount += 1;
    let summaries = res.ok ? inventorySummariesFromBody(res.body) : [];
    let summary = pickSummaryForFnsku(summaries, fnsku);
    let scanPages = 0;
    let endpointUsed = res.url;

    if (!summary) {
      const scan = await scanInventoryForFnsku(apiHost, accessToken, marketplaceId, fnsku);
      apiCallCount += scan.pages;
      scanPages = scan.pages;
      endpointUsed = scan.lastUrl;
      if (scan.summary) summary = scan.summary;
    }

    const evidence = summary ? extractInventoryEvidence(summary) : null;
    const rawSample = res.ok
      ? JSON.stringify(res.body).slice(0, 1200)
      : "raw" in res
        ? res.raw.slice(0, 400)
        : null;

    phase1Results.push({
      expected_package_id: row.expected_package_id,
      fnsku,
      call_type: "fba_inventory_by_fnsku",
      endpoint: endpointUsed,
      http_ok: res.ok,
      http_status: res.ok ? res.status : res.status,
      attempts: res.attempts,
      error: res.ok ? null : res.error,
      resolved_asin: evidence?.asin ?? null,
      resolved_seller_sku: evidence?.seller_sku ?? null,
      resolved_fn_sku: evidence?.fn_sku ?? fnsku,
      product_name: evidence?.product_name ?? null,
      condition: evidence?.condition ?? null,
      inventory_summaries_count: summaries.length,
      raw_sample: scanPages > 0 ? `paginated_scan_pages=${scanPages}` : rawSample,
    });

    if (i + 1 < cohort.length) await sleep(DELAY_MS);
  }

  fs.writeFileSync(path.join(outDir, "phase1-fnsku-evidence.json"), JSON.stringify(phase1Results, null, 2));

  const phase2JobsMap = new Map<string, Phase2Job>();
  for (const p1 of phase1Results) {
    if (!p1.resolved_asin) continue;
    const asin = p1.resolved_asin;
    const ex = phase2JobsMap.get(asin);
    if (!ex) {
      phase2JobsMap.set(asin, {
        asin,
        expected_package_ids: [p1.expected_package_id],
        source_fnskus: [p1.fnsku],
      });
    } else {
      ex.expected_package_ids.push(p1.expected_package_id);
      ex.source_fnskus.push(p1.fnsku);
    }
  }
  const phase2Jobs = [...phase2JobsMap.values()].sort((a, b) => a.asin.localeCompare(b.asin));

  const phase2PlanLines = phase2Jobs.map(
    (j, i) =>
      `| ${i + 1} | \`${j.asin}\` | \`GET /catalog/2022-04-01/items/{asin}\` | ${marketplaceId} | ${j.expected_package_ids.map((id) => `\`${id.slice(0, 8)}…\``).join(", ")} |`,
  );

  fs.writeFileSync(
    path.join(outDir, "phase2-catalog-get-plan.md"),
    [
      "# Phase 2 — Catalog GET plan",
      "",
      `**Phase 1 resolved ASINs:** ${phase2Jobs.length}`,
      "",
      "| # | ASIN | endpoint | marketplace | expected_package_ids |",
      "|---|------|----------|-------------|----------------------|",
      ...(phase2PlanLines.length ? phase2PlanLines : ["| — | — | — | — | *No ASINs resolved in Phase 1* |"]),
      "",
      `**Planned catalog calls:** ${phase2Jobs.length}`,
    ].join("\n") + "\n",
  );

  const phase2Results: Record<string, unknown>[] = [];
  for (let i = 0; i < phase2Jobs.length; i++) {
    const job = phase2Jobs[i]!;
    const cat = await fetchCatalogJson(apiHost, accessToken, ctx.marketplaceIds, job.asin);
    apiCallCount += 1;
    const extracted = cat.ok ? extractCatalogMainImageAndText(cat.body) : null;
    phase2Results.push({
      asin: job.asin,
      expected_package_ids: job.expected_package_ids,
      source_fnskus: job.source_fnskus,
      http_ok: cat.ok,
      http_status: cat.ok ? cat.status : cat.status,
      attempts: cat.attempts,
      error: cat.ok ? null : cat.error,
      product_name: extracted?.product_name ?? null,
      brand: extracted?.brand ?? null,
      main_image_url: extracted?.main_image_url ?? null,
      catalog_evidence_found: cat.ok && !!(extracted?.product_name || extracted?.main_image_url),
    });
    if (i + 1 < phase2Jobs.length) await sleep(DELAY_MS);
  }

  fs.writeFileSync(path.join(outDir, "phase2-catalog-evidence.json"), JSON.stringify(phase2Results, null, 2));

  const afterSnap = await writeSnapshot(client, epIds);
  await client.end();

  const fnskuResolvedCount = phase1Results.filter((r) => r.resolved_asin).length;
  const unresolvedCount = phase1Results.length - fnskuResolvedCount;

  fs.writeFileSync(
    path.join(outDir, "no-write-proof.md"),
    [
      "# No-write proof — PC03D",
      "",
      "| Check | Before | After |",
      "|-------|--------|-------|",
      `| products (org) | ${beforeSnap.products_total} | ${afterSnap.products_total} |`,
      `| product_identifier_map (org) | ${beforeSnap.map_total} | ${afterSnap.map_total} |`,
      `| cohort EP max(updated_at) | ${beforeSnap.cohort_ep_max_updated_at ?? "null"} | ${afterSnap.cohort_ep_max_updated_at ?? "null"} |`,
      "",
      "**Forbidden writes:** 0 product, 0 map, 0 expected_packages UPDATE.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "execute-result.md"),
    [
      "# PC03D Amazon evidence dry-run execute",
      "",
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Phase 1 FNSKU jobs | ${cohort.length} |`,
      `| API calls (total) | **${apiCallCount}** |`,
      `| FNSKU → ASIN resolved | **${fnskuResolvedCount}** |`,
      `| Unresolved FNSKU | **${unresolvedCount}** |`,
      `| Phase 2 catalog candidates | **${phase2Jobs.length}** |`,
      `| Phase 2 catalog calls executed | **${phase2Results.length}** |`,
    ].join("\n") + "\n",
  );

  const noWrites =
    beforeSnap.products_total === afterSnap.products_total &&
    beforeSnap.map_total === afterSnap.map_total &&
    beforeSnap.cohort_ep_max_updated_at === afterSnap.cohort_ep_max_updated_at;

  const nextPrompt =
    fnskuResolvedCount === cohort.length
      ? "PC03D-EVIDENCE-REVIEW — operator review phase1/phase2 JSON before map-only or promotion"
      : "PC03D-PHASE1-RETRY-PLAN — investigate unresolved X-FNSKU inventory lookup paths";

  fs.writeFileSync(path.join(outDir, "blockers.md"), "# Blockers\n\nNone.\n");
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PC03D-EXEC — EXPECTED PACKAGES AMAZON EVIDENCE DRY-RUN EXECUTE",
        run_id: runId,
        plan_run_id: planRunId,
        branch,
        staging_ref: STAGING_REF,
        status: noWrites ? "PASS" : "FAIL_NO_WRITE_PROOF",
        api_calls_count: apiCallCount,
        fnsku_resolved_to_asin_count: fnskuResolvedCount,
        unresolved_fnsku_count: unresolvedCount,
        phase2_catalog_candidates_count: phase2Jobs.length,
        phase2_catalog_calls_executed: phase2Results.length,
        no_write_verified: noWrites,
        exact_next_prompt: nextPrompt,
        forbidden: {
          db_writes: true,
          product_create: true,
          map_insert: true,
          expected_packages_update: true,
        },
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: noWrites,
        outDir,
        api_calls_count: apiCallCount,
        fnsku_resolved_to_asin_count: fnskuResolvedCount,
        unresolved_count: unresolvedCount,
        phase2_catalog_candidates_count: phase2Jobs.length,
        next_prompt: nextPrompt,
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
