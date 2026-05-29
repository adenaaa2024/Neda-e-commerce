/**
 * REMOVAL-MISSING-PRODUCTS-AMAZON-EVIDENCE — Catalog GET plan/dry-run execute
 *
 * Phase 1: FBA inventory summaries lookup per X-FNSKU (and seller SKU when valid).
 * Phase 2: Catalog GET for ASINs resolved in Phase 1.
 * No DB writes. No product create. No map insert. No expected_packages update.
 *
 *   npx tsx scripts/removal-missing-products-amazon-evidence-dry-run.ts --run-id=<UTC_Z>
 *   npx tsx scripts/removal-missing-products-amazon-evidence-dry-run.ts --plan-run-id=20260528T160000Z
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
const PLAN_DEFAULT = "20260528T160000Z";
const PLAN_BASE = ".cursor/audit-reports/removal-product-promotion-plan";
const APPROVAL_PATH = ".cursor/operator-approvals/removal-missing-products-amazon-evidence-approval.md";
const OUT_BASE = ".cursor/audit-reports/removal-missing-products-amazon-evidence";
const DEFAULT_MARKETPLACE_ID = "ATVPDKIKX0DER";
const DEFAULT_CATALOG_HOST = "https://sellingpartnerapi-na.amazon.com";
const DELAY_MS = 400;
const MAX_INVENTORY_SCAN_PAGES = 15;

type NeedsCatalogCandidate = {
  candidate_key: string;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  title: string | null;
  report_sources: string[];
  order_ids: string[];
  removal_order_line_count: number;
  removal_shipment_line_count: number;
  map_matches: Array<{ product_id: string; match_via: string }>;
  existing_product_ids: string[];
  classification: string;
  blockers: string[];
  promotion_plan: Record<string, unknown> | null;
};

type EvidenceClassification =
  | "promote_ready"
  | "partial_evidence"
  | "not_found"
  | "conflict"
  | "unsafe";

type Phase1Result = {
  candidate_key: string;
  fnsku: string;
  report_sku: string | null;
  call_types: string[];
  api_calls: number;
  http_ok: boolean;
  resolved_asin: string | null;
  resolved_seller_sku: string | null;
  resolved_fn_sku: string | null;
  inventory_product_name: string | null;
  error: string | null;
};

type EnrichedEvidence = {
  candidate_key: string;
  sku: string | null;
  fnsku: string | null;
  report_asin: string | null;
  report_title: string | null;
  order_ids: string[];
  report_sources: string[];
  phase1: Phase1Result;
  catalog: {
    asin: string | null;
    http_ok: boolean;
    product_name: string | null;
    brand: string | null;
    main_image_url: string | null;
    error: string | null;
  };
  resolved_asin: string | null;
  resolved_title: string | null;
  resolved_seller_sku: string | null;
  existing_product_ids: string[];
  map_matches: Array<{ product_id: string; match_via: string }>;
  evidence_classification: EvidenceClassification;
  blockers: string[];
  promotion_plan: Record<string, unknown> | null;
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

function readApproval(): { valid: boolean; runStaging: boolean; catalogEvidence: boolean } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runStaging = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const catalogEvidence = /APPROVED_REMOVAL_MISSING_PRODUCTS_CATALOG_EVIDENCE\s*=\s*true/i.test(text);
  return { valid: runStaging && catalogEvidence, runStaging, catalogEvidence };
}

function normSku(s: string | null | undefined): string {
  return (s ?? "").trim();
}

function isUnknowSku(s: string | null | undefined): boolean {
  return /^(UNKNOW|UNKNOWN)$/i.test(normSku(s));
}

function isValidAmazonFnsku(fnsku: string | null | undefined): boolean {
  return /^X[0-9A-Z]{9,}$/i.test(normSku(fnsku));
}

function isValidSellerSku(sku: string | null | undefined): boolean {
  const s = normSku(sku);
  return s.length > 0 && !isUnknowSku(s);
}

function isLikelyAsin(v: string | null | undefined): boolean {
  return !!v && /^B[0-9A-Z]{9}$/i.test(v.trim());
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

async function fetchSpApiJson(url: string, accessToken: string): Promise<SpFetchResult> {
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
} {
  const asinRaw = summary.asin ?? summary.ASIN;
  const asin = typeof asinRaw === "string" && isLikelyAsin(asinRaw) ? asinRaw.trim().toUpperCase() : null;
  const sellerSku = summary.sellerSku ?? summary.seller_sku;
  const fnSku = summary.fnSku ?? summary.fnsku;
  const productName = summary.productName ?? summary.product_name;
  return {
    asin,
    seller_sku: typeof sellerSku === "string" ? sellerSku.trim() : null,
    fn_sku: typeof fnSku === "string" ? fnSku.trim() : null,
    product_name: typeof productName === "string" ? productName.trim() : null,
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
  sellerSku: string,
): Promise<SpFetchResult> {
  return fetchSpApiJson(buildInventoryUrl(host, marketplaceId, sellerSku), accessToken);
}

async function scanInventoryForFnsku(
  host: string,
  accessToken: string,
  marketplaceId: string,
  targetFnsku: string,
): Promise<{ summary: Record<string, unknown> | null; pages: number }> {
  const t = targetFnsku.trim().toUpperCase();
  let nextToken: string | undefined;
  let pages = 0;
  while (pages < MAX_INVENTORY_SCAN_PAGES) {
    const url = buildInventoryUrl(host, marketplaceId, undefined, nextToken);
    const res = await fetchSpApiJson(url, accessToken);
    pages += 1;
    if (!res.ok) return { summary: null, pages };
    const summaries = inventorySummariesFromBody(res.body);
    const hit = summaries.find((s) => String(s.fnSku ?? s.fnsku ?? "").trim().toUpperCase() === t);
    if (hit) return { summary: hit, pages };
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
  return { summary: null, pages };
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

async function lookupExistingProducts(
  client: pg.Client,
  asin: string | null,
  sku: string | null,
  fnsku: string | null,
): Promise<{ product_ids: string[]; map_matches: Array<{ product_id: string; match_via: string }> }> {
  const productIds = new Set<string>();
  const mapMatches: Array<{ product_id: string; match_via: string }> = [];

  const prodRes = await client.query(
    `SELECT id::text FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
       AND (
         ($3::text <> '' AND upper(trim(sku)) = upper(trim($3)))
         OR ($4::text <> '' AND upper(trim(fnsku)) = upper(trim($4)))
         OR ($5::text <> '' AND upper(trim(asin)) = upper(trim($5)))
       )`,
    [ORG, STORE, sku ?? "", fnsku ?? "", asin ?? ""],
  );
  for (const r of prodRes.rows) productIds.add((r as { id: string }).id);

  if (fnsku || (sku && isValidSellerSku(sku))) {
    const mapRes = await client.query(
      `SELECT product_id::text, seller_sku, fnsku, msku
       FROM public.product_identifier_map
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
         AND (
           ($3::text <> '' AND upper(trim(fnsku)) = upper(trim($3)))
           OR ($4::text <> '' AND (upper(trim(seller_sku)) = upper(trim($4)) OR upper(trim(msku)) = upper(trim($4))))
         )`,
      [ORG, STORE, fnsku ?? "", sku ?? ""],
    );
    for (const r of mapRes.rows) {
      const row = r as { product_id: string; fnsku: string | null; seller_sku: string | null; msku: string | null };
      const matchVia =
        row.fnsku && fnsku && row.fnsku.toUpperCase() === fnsku.toUpperCase()
          ? "fnsku"
          : "sku";
      mapMatches.push({ product_id: row.product_id, match_via: matchVia });
      productIds.add(row.product_id);
    }
  }

  return { product_ids: [...productIds], map_matches: mapMatches };
}

function classifyEvidence(row: {
  sku: string | null;
  fnsku: string | null;
  resolved_asin: string | null;
  resolved_title: string | null;
  resolved_seller_sku: string | null;
  inventory_fn_sku: string | null;
  existing_product_ids: string[];
  map_matches: Array<{ product_id: string; match_via: string }>;
  order_ids: string[];
  report_sources: string[];
}): { evidence_classification: EvidenceClassification; blockers: string[]; promotion_plan: Record<string, unknown> | null } {
  const blockers: string[] = [];
  const reportSku = normSku(row.sku);
  const fnsku = normSku(row.fnsku);
  const asin = row.resolved_asin;
  const title = row.resolved_title;
  const invFnsku = normSku(row.inventory_fn_sku);
  const sellerSku =
    isValidSellerSku(reportSku) ? reportSku : normSku(row.resolved_seller_sku);

  if (row.existing_product_ids.length > 0) {
    blockers.push(`product_already_exists:${row.existing_product_ids.join(",")}`);
    return { evidence_classification: "conflict", blockers, promotion_plan: null };
  }

  const mapPids = [...new Set(row.map_matches.map((m) => m.product_id))];
  if (mapPids.length > 1) {
    blockers.push(`multiple_map_products:${mapPids.join(",")}`);
    return { evidence_classification: "conflict", blockers, promotion_plan: null };
  }
  if (mapPids.length === 1) {
    blockers.push(`map_already_links_product:${mapPids[0]}`);
    return { evidence_classification: "conflict", blockers, promotion_plan: null };
  }

  if (!asin && !title) {
    return { evidence_classification: "not_found", blockers: ["no_api_evidence"], promotion_plan: null };
  }

  if (invFnsku && fnsku && invFnsku.toUpperCase() !== fnsku.toUpperCase()) {
    blockers.push(`inventory_fnsku_mismatch:${invFnsku}_vs_${fnsku}`);
    return { evidence_classification: "conflict", blockers, promotion_plan: null };
  }

  if (!isValidAmazonFnsku(fnsku)) {
    blockers.push("invalid_report_fnsku");
    return { evidence_classification: "unsafe", blockers, promotion_plan: null };
  }

  if (!asin || !title) {
    const missing = [!asin ? "asin" : null, !title ? "title" : null].filter(Boolean).join("_and_");
    blockers.push(`partial_api_evidence_missing_${missing}`);
    return { evidence_classification: "partial_evidence", blockers, promotion_plan: null };
  }

  if (!sellerSku) {
    blockers.push("no_resolved_seller_sku");
    return { evidence_classification: "partial_evidence", blockers, promotion_plan: null };
  }

  if (
    isValidSellerSku(reportSku) &&
    row.resolved_seller_sku &&
    reportSku.toUpperCase() !== row.resolved_seller_sku.toUpperCase()
  ) {
    blockers.push(`report_sku_vs_inventory_sku_mismatch:${reportSku}_vs_${row.resolved_seller_sku}`);
    return { evidence_classification: "conflict", blockers, promotion_plan: null };
  }

  return {
    evidence_classification: "promote_ready",
    blockers: [],
    promotion_plan: {
      action: "create_product_and_map",
      seller_sku: sellerSku,
      fnsku,
      asin,
      product_name: title,
      evidence: {
        source: "removal_missing_products_amazon_evidence_dry_run",
        report_sources: row.report_sources,
        order_ids: row.order_ids,
        api_paths: ["fba_inventory_summaries", "catalog_get_by_asin"],
      },
      guardrails: [
        "staging_only",
        "no_create_without_asin_and_title",
        "map_insert_in_same_transaction_as_product",
        "rollback_from_preimage",
      ],
    },
  };
}

type WriteSnapshot = { products_total: number; map_total: number; ep_max_updated_at: string | null };

async function writeSnapshot(client: pg.Client): Promise<WriteSnapshot> {
  const p = await client.query(`SELECT COUNT(*)::int AS c FROM public.products WHERE organization_id = $1::uuid`, [ORG]);
  const m = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE organization_id = $1::uuid`,
    [ORG],
  );
  const ep = await client.query(
    `SELECT MAX(updated_at)::text AS max_u FROM public.expected_packages WHERE organization_id = $1::uuid`,
    [ORG],
  );
  return {
    products_total: (p.rows[0] as { c: number }).c,
    map_total: (m.rows[0] as { c: number }).c,
    ep_max_updated_at: (ep.rows[0] as { max_u: string | null }).max_u,
  };
}

async function resolvePhase1(
  host: string,
  accessToken: string,
  marketplaceId: string,
  candidate: NeedsCatalogCandidate,
): Promise<{ result: Phase1Result; apiCalls: number }> {
  const fnsku = normSku(candidate.fnsku);
  const reportSku = normSku(candidate.sku) || null;
  let apiCalls = 0;
  const callTypes: string[] = [];
  let summary: Record<string, unknown> | null = null;
  let httpOk = false;
  let error: string | null = null;

  if (fnsku) {
    const byFnskuParam = await fetchInventoryBySellerSku(host, accessToken, marketplaceId, fnsku);
    apiCalls += 1;
    callTypes.push("fba_inventory_by_fnsku_param");
    if (byFnskuParam.ok) {
      httpOk = true;
      summary = pickSummaryForFnsku(inventorySummariesFromBody(byFnskuParam.body), fnsku);
    } else {
      error = byFnskuParam.error;
    }

    if (!summary) {
      const scan = await scanInventoryForFnsku(host, accessToken, marketplaceId, fnsku);
      apiCalls += scan.pages;
      if (scan.pages > 0) callTypes.push(`fba_inventory_paginated_scan_${scan.pages}p`);
      if (scan.summary) {
        httpOk = true;
        summary = scan.summary;
        error = null;
      }
    }
  }

  if (!summary && reportSku && isValidSellerSku(reportSku)) {
    const bySku = await fetchInventoryBySellerSku(host, accessToken, marketplaceId, reportSku);
    apiCalls += 1;
    callTypes.push("fba_inventory_by_report_sku");
    if (bySku.ok) {
      httpOk = true;
      const summaries = inventorySummariesFromBody(bySku.body);
      summary = fnsku ? pickSummaryForFnsku(summaries, fnsku) : summaries[0] ?? null;
      if (!summary && summaries.length === 1) summary = summaries[0]!;
    } else if (!error) {
      error = bySku.error;
    }
  }

  const evidence = summary ? extractInventoryEvidence(summary) : null;

  return {
    apiCalls,
    result: {
      candidate_key: candidate.candidate_key,
      fnsku,
      report_sku: reportSku,
      call_types: callTypes,
      api_calls: apiCalls,
      http_ok: httpOk,
      resolved_asin: evidence?.asin ?? null,
      resolved_seller_sku: evidence?.seller_sku ?? null,
      resolved_fn_sku: evidence?.fn_sku ?? fnsku,
      inventory_product_name: evidence?.product_name ?? null,
      error,
    },
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

  const planPath = path.join(process.cwd(), PLAN_BASE, planRunId, "needs-catalog-evidence.json");
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) blockers.push(`branch=${branch}`);
  if (!approval.valid) blockers.push("approval flags not both true");
  if (!spApiEnabled) blockers.push("AMAZON_SP_API_ENABLED not true");
  if (!stagingOk || stagingRef !== STAGING_REF) blockers.push("staging ref guard failed");
  if (refFromSupabaseUrl(stagingUrl) === ORIGINAL_REF) blockers.push("original ref targeted");
  if (!fs.existsSync(planPath)) blockers.push(`Missing ${planPath}`);

  let cohort: NeedsCatalogCandidate[] = [];
  if (fs.existsSync(planPath)) {
    const file = JSON.parse(fs.readFileSync(planPath, "utf8")) as { candidates: NeedsCatalogCandidate[] };
    cohort = file.candidates ?? [];
    if (cohort.length !== 9) blockers.push(`Expected 9 needs_catalog_evidence rows, got ${cohort.length}`);
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof — removal missing products Amazon evidence",
      "",
      `| APPROVED_TO_RUN_STAGING | ${approval.runStaging} |`,
      `| APPROVED_REMOVAL_MISSING_PRODUCTS_CATALOG_EVIDENCE | ${approval.catalogEvidence} |`,
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

  const beforeSnap = await writeSnapshot(client);
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
    const p1 = await resolvePhase1(apiHost, accessToken, marketplaceId, row);
    apiCallCount += p1.apiCalls;
    phase1Results.push(p1.result);
    if (i + 1 < cohort.length) await sleep(DELAY_MS);
  }

  fs.writeFileSync(path.join(outDir, "phase1-fnsku-evidence.json"), JSON.stringify(phase1Results, null, 2));

  const asinJobs = new Map<string, string[]>();
  for (const p1 of phase1Results) {
    if (!p1.resolved_asin) continue;
    const ex = asinJobs.get(p1.resolved_asin) ?? [];
    ex.push(p1.candidate_key);
    asinJobs.set(p1.resolved_asin, ex);
  }

  const catalogByAsin = new Map<
    string,
    { http_ok: boolean; product_name: string | null; brand: string | null; main_image_url: string | null; error: string | null }
  >();

  const asinList = [...asinJobs.keys()].sort();
  for (let i = 0; i < asinList.length; i++) {
    const asin = asinList[i]!;
    const cat = await fetchCatalogJson(apiHost, accessToken, ctx.marketplaceIds, asin);
    apiCallCount += 1;
    if (cat.ok) {
      const extracted = extractCatalogMainImageAndText(cat.body);
      catalogByAsin.set(asin, {
        http_ok: true,
        product_name: extracted.product_name,
        brand: extracted.brand,
        main_image_url: extracted.main_image_url,
        error: null,
      });
    } else {
      catalogByAsin.set(asin, {
        http_ok: false,
        product_name: null,
        brand: null,
        main_image_url: null,
        error: cat.error,
      });
    }
    if (i + 1 < asinList.length) await sleep(DELAY_MS);
  }

  fs.writeFileSync(
    path.join(outDir, "phase2-catalog-evidence.json"),
    JSON.stringify(
      asinList.map((asin) => ({
        asin,
        candidate_keys: asinJobs.get(asin) ?? [],
        ...catalogByAsin.get(asin),
      })),
      null,
      2,
    ),
  );

  const enriched: EnrichedEvidence[] = [];
  for (let i = 0; i < cohort.length; i++) {
    const c = cohort[i]!;
    const p1 = phase1Results[i]!;
    const asin = p1.resolved_asin;
    const cat = asin ? catalogByAsin.get(asin) : undefined;
    const resolvedTitle = cat?.product_name ?? p1.inventory_product_name ?? null;
    const resolvedSellerSku = p1.resolved_seller_sku;

    const existing = await lookupExistingProducts(client, asin, c.sku, c.fnsku);

    const classified = classifyEvidence({
      sku: c.sku,
      fnsku: c.fnsku,
      resolved_asin: asin,
      resolved_title: resolvedTitle,
      resolved_seller_sku: resolvedSellerSku,
      inventory_fn_sku: p1.resolved_fn_sku,
      existing_product_ids: existing.product_ids,
      map_matches: existing.map_matches,
      order_ids: c.order_ids,
      report_sources: c.report_sources,
    });

    enriched.push({
      candidate_key: c.candidate_key,
      sku: c.sku,
      fnsku: c.fnsku,
      report_asin: c.asin,
      report_title: c.title,
      order_ids: c.order_ids,
      report_sources: c.report_sources,
      phase1: p1,
      catalog: {
        asin,
        http_ok: cat?.http_ok ?? false,
        product_name: cat?.product_name ?? null,
        brand: cat?.brand ?? null,
        main_image_url: cat?.main_image_url ?? null,
        error: cat?.error ?? (asin ? "catalog_not_called" : null),
      },
      resolved_asin: asin,
      resolved_title: resolvedTitle,
      resolved_seller_sku: resolvedSellerSku,
      existing_product_ids: existing.product_ids,
      map_matches: existing.map_matches,
      evidence_classification: classified.evidence_classification,
      blockers: classified.blockers,
      promotion_plan: classified.promotion_plan,
    });
  }

  const promoteReady = enriched.filter((r) => r.evidence_classification === "promote_ready");
  const partial = enriched.filter((r) => r.evidence_classification === "partial_evidence");
  const notFound = enriched.filter((r) => r.evidence_classification === "not_found");
  const conflict = enriched.filter((r) => r.evidence_classification === "conflict");
  const unsafe = enriched.filter((r) => r.evidence_classification === "unsafe");

  fs.writeFileSync(path.join(outDir, "evidence-results.json"), JSON.stringify(enriched, null, 2));
  fs.writeFileSync(
    path.join(outDir, "promote-ready-candidates.json"),
    JSON.stringify({ run_id: runId, count: promoteReady.length, candidates: promoteReady }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "partial-evidence-candidates.json"),
    JSON.stringify({ run_id: runId, count: partial.length, candidates: partial }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "not-found-candidates.json"),
    JSON.stringify({ run_id: runId, count: notFound.length, candidates: notFound }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "conflict-candidates.json"),
    JSON.stringify({ run_id: runId, count: conflict.length, candidates: conflict }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "unsafe-candidates.json"),
    JSON.stringify({ run_id: runId, count: unsafe.length, candidates: unsafe }, null, 2),
  );

  const planLines = promoteReady.map(
    (r) =>
      `| \`${r.sku ?? "—"}\` | \`${r.fnsku}\` | \`${r.resolved_asin}\` | ${(r.resolved_title ?? "").slice(0, 60)} | ${r.order_ids.join(", ")} |`,
  );

  fs.writeFileSync(
    path.join(outDir, "product-promotion-plan-after-catalog.md"),
    [
      "# Product promotion plan after Catalog GET",
      "",
      `**Source plan:** \`${PLAN_BASE}/${planRunId}/\``,
      `**Evidence run:** \`${OUT_BASE}/${runId}/\``,
      "",
      "## Summary",
      "",
      "| Classification | Count |",
      "|----------------|------:|",
      `| promote_ready | **${promoteReady.length}** |`,
      `| partial_evidence | ${partial.length} |`,
      `| not_found | ${notFound.length} |`,
      `| conflict | ${conflict.length} |`,
      `| unsafe | ${unsafe.length} |`,
      "",
      "## Promote-ready (staging execute when approved)",
      "",
      "| sku | fnsku | asin | title | order_ids |",
      "|-----|-------|------|-------|-----------|",
      ...(planLines.length ? planLines : ["| — | — | — | — | *None* |"]),
      "",
      promoteReady.length
        ? "**Next:** `REMOVAL-PRODUCT-PROMOTION-STAGING-EXECUTE` with updated promote-ready list."
        : "**Next:** investigate partial/not_found/conflict cohorts before promotion.",
    ].join("\n") + "\n",
  );

  const afterSnap = await writeSnapshot(client);
  await client.end();

  const noWrites =
    beforeSnap.products_total === afterSnap.products_total &&
    beforeSnap.map_total === afterSnap.map_total &&
    beforeSnap.ep_max_updated_at === afterSnap.ep_max_updated_at;

  fs.writeFileSync(
    path.join(outDir, "no-write-proof.md"),
    [
      "# No-write proof",
      "",
      "| Check | Before | After |",
      "|-------|--------|-------|",
      `| products (org) | ${beforeSnap.products_total} | ${afterSnap.products_total} |`,
      `| product_identifier_map (org) | ${beforeSnap.map_total} | ${afterSnap.map_total} |`,
      `| expected_packages max(updated_at) | ${beforeSnap.ep_max_updated_at ?? "null"} | ${afterSnap.ep_max_updated_at ?? "null"} |`,
    ].join("\n") + "\n",
  );

  const exactNextPrompt =
    promoteReady.length > 0
      ? "REMOVAL-PRODUCT-PROMOTION-STAGING-EXECUTE — promote-ready after catalog evidence"
      : partial.length > 0 || notFound.length > 0
        ? "REMOVAL-MISSING-PRODUCTS-AMAZON-EVIDENCE-REVIEW — operator review partial/not_found cohort"
        : "REMOVAL-PRODUCT-PROMOTION-PLAN-REFRESH — conflict/unsafe only; no promotion path";

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    noWrites ? "# Blockers\n\nNone.\n" : "# Blockers\n\n- no_write_proof_failed\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL-MISSING-PRODUCTS-AMAZON-EVIDENCE — CATALOG GET PLAN/DRY-RUN",
        run_id: runId,
        plan_run_id: planRunId,
        branch,
        staging_ref: STAGING_REF,
        source_candidate_count: cohort.length,
        api_calls_count: apiCallCount,
        promote_ready_count: promoteReady.length,
        partial_evidence_count: partial.length,
        not_found_count: notFound.length,
        conflict_count: conflict.length,
        unsafe_count: unsafe.length,
        no_write_verified: noWrites,
        exact_next_prompt: exactNextPrompt,
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
        promote_ready_count: promoteReady.length,
        partial_evidence_count: partial.length,
        not_found_count: notFound.length,
        conflict_count: conflict.length,
        unsafe_count: unsafe.length,
        exact_next_prompt: exactNextPrompt,
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
