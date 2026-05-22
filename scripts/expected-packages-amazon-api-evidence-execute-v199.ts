/**
 * EXPECTED-PACKAGES-AMAZON-API-EVIDENCE-EXECUTE-V199
 *
 * Governed Amazon SP-API catalog lookup + product/map promotion for V199 API cohort.
 * Does not update expected_packages. Staging only.
 *
 *   npx tsx scripts/expected-packages-amazon-api-evidence-execute-v199.ts --run-id=<id> --v199-run-id=20260519T230000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
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
const API_APPROVAL = ".cursor/operator-approvals/expected-packages-amazon-api-enrichment-v194-approval.md";
const V199_BASE = ".cursor/audit-reports/v199-expected-identifier-ambiguous-review-pack";
const OUT_BASE = ".cursor/audit-reports/expected-packages-amazon-api-evidence-execute-v199";
const MATCH_SOURCE = "expected_packages_amazon_api_evidence_v199";

type CohortRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string;
  asin: string;
  fnsku?: string | null;
  sku?: string | null;
};

type AsinBundle = {
  asin: string;
  organization_id: string;
  store_id: string;
  fnsku: string | null;
  sku: string | null;
  expected_package_ids: string[];
};

type LineResult = {
  asin: string;
  expected_package_ids: string[];
  outcome: string;
  catalog_ok: boolean;
  product_id: string | null;
  map_inserted: boolean;
  api_called: boolean;
  detail: string;
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

function v199RunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--v199-run-id="));
  return a ? a.split("=")[1]!.trim() : "20260519T230000Z";
}

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function readApiApproval(): { approved: boolean; detail: string } {
  const p = path.join(process.cwd(), API_APPROVAL);
  if (!fs.existsSync(p)) return { approved: false, detail: "approval_file_missing" };
  const text = fs.readFileSync(p, "utf8");
  const run = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const api = /APPROVED_EXPECTED_PACKAGES_AMAZON_API_ENRICHMENT_V194\s*=\s*true/i.test(text);
  if (run && api) return { approved: true, detail: "operator_approval_true" };
  return { approved: false, detail: run ? "api_flag_not_true" : "not_approved" };
}

function groupByAsin(rows: CohortRow[]): AsinBundle[] {
  const map = new Map<string, AsinBundle>();
  for (const r of rows) {
    const asin = r.asin.trim().toUpperCase();
    const key = `${r.organization_id}|${r.store_id}|${asin}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        asin,
        organization_id: r.organization_id,
        store_id: r.store_id,
        fnsku: r.fnsku?.trim() || null,
        sku: r.sku?.trim() || null,
        expected_package_ids: [r.expected_package_id],
      });
      continue;
    }
    existing.expected_package_ids.push(r.expected_package_id);
    if (!existing.fnsku && r.fnsku) existing.fnsku = r.fnsku.trim();
    if (!existing.sku && r.sku) existing.sku = r.sku.trim();
  }
  return [...map.values()].sort((a, b) => a.asin.localeCompare(b.asin));
}

async function coverage(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(`
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id, NULLIF(TRIM(e.sku), '') AS sku,
        NULLIF(TRIM(e.fnsku), '') AS fnsku, e.resolved_product_id
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count
      FROM ep
      JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku = ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count
      FROM ep
      JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku = ep.sku OR m.msku = ep.sku)
      GROUP BY ep.id
    ),
    classified AS (
      SELECT ep.id,
        CASE
          WHEN ep.resolved_product_id IS NOT NULL THEN 'direct'
          WHEN COALESCE(mf.product_count, 0) = 1 THEN 'map_fnsku'
          WHEN COALESCE(ms.product_count, 0) = 1 THEN 'map_sku'
          WHEN COALESCE(mf.product_count, 0) > 1 OR COALESCE(ms.product_count, 0) > 1 THEN 'ambiguous'
          ELSE 'unresolved'
        END AS bucket
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id = ep.id
      LEFT JOIN map_sku ms ON ms.id = ep.id
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket IN ('direct', 'map_fnsku', 'map_sku'))::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE bucket = 'unresolved')::int AS unresolved
    FROM classified
  `);
  return r.rows[0] as Record<string, number>;
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
    if (typeof s0.itemName === "string" && s0.itemName.trim()) product_name = s0.itemName.trim();
    if (typeof s0.brand === "string" && s0.brand.trim()) brand = s0.brand.trim();
  }
  const { bestUrl: main_image_url } = extractBestMainImageFromCatalogItem(item);
  return { main_image_url, product_name, brand };
}

async function fetchCatalogJson(
  catalogHost: string,
  accessToken: string,
  marketplaceIds: string[],
  asin: string,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  const base = trimHost(catalogHost);
  const mids = marketplaceIds.map((s) => s.trim()).filter(Boolean);
  if (!mids.length) return { ok: false, error: "No marketplace ids" };
  const qp = new URLSearchParams({
    marketplaceIds: mids.join(","),
    includedData: "summaries,attributes,images,productTypes,salesRanks",
  });
  const url = `${base}/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${qp}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      headers: { "x-amz-access-token": accessToken, "Content-Type": "application/json" },
      method: "GET",
    });
    const text = await res.text();
    if (res.ok) {
      try {
        return { ok: true, body: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, error: "catalog_json_parse_failed" };
      }
    }
    if (res.status === 429 || res.status === 503) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    return { ok: false, error: `catalog_http_${res.status}: ${text.slice(0, 200)}` };
  }
  return { ok: false, error: "catalog_max_retries" };
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
    `SELECT s.marketplace_id::text AS store_marketplace_id, m.provider, m.credentials
     FROM public.stores s
     LEFT JOIN public.marketplaces m ON m.id = s.marketplace_id
     WHERE s.id = $1::uuid AND s.organization_id = $2::uuid`,
    [storeId, organizationId],
  );
  const store = storeRes.rows[0] as { store_marketplace_id?: string; provider?: string; credentials?: unknown } | undefined;
  if (!store) return { ok: false, error: "Store not found" };

  const storeMpRaw = store.store_marketplace_id?.trim() || null;
  if (store.credentials && typeof store.credentials === "object" && store.provider === "amazon_sp_api") {
    const credObj = store.credentials as Record<string, unknown>;
    if (amazonSpCredentialsLookComplete(credObj)) {
      const lwa = credsRecordToLwa(credObj);
      if (lwa) {
        const rawIds = marketplaceIdsFromCredentials(credObj);
        const valid = filterValidAmazonRetailMarketplaceIds(rawIds);
        const marketplaceIds = valid.length ? valid : [DEFAULT_MARKETPLACE_ID];
        return { ok: true, credentials: lwa, marketplaceIds, catalogHost: catalogHostFromCredentials(credObj) };
      }
    }
  }

  const keyRes = await client.query(
    `SELECT api_key FROM public.organization_api_keys
     WHERE organization_id = $1::uuid AND name = 'amazon_sp_api' LIMIT 1`,
    [organizationId],
  );
  const rawKey = (keyRes.rows[0] as { api_key?: string } | undefined)?.api_key;
  if (rawKey?.trim()) {
    try {
      const parsed = JSON.parse(rawKey) as Record<string, unknown>;
      const lwa = credsRecordToLwa(parsed);
      if (lwa) {
        const rawIds = marketplaceIdsFromCredentials(parsed);
        const valid = filterValidAmazonRetailMarketplaceIds(rawIds);
        const marketplaceIds = valid.length ? valid : [DEFAULT_MARKETPLACE_ID];
        return { ok: true, credentials: lwa, marketplaceIds, catalogHost: catalogHostFromCredentials(parsed) };
      }
    } catch {
      /* fall through */
    }
  }

  const mpRes = await client.query(
    `SELECT credentials FROM public.marketplaces
     WHERE organization_id = $1::uuid AND provider = 'amazon_sp_api' LIMIT 3`,
    [organizationId],
  );
  for (const row of mpRes.rows) {
    const credObj = (row as { credentials?: unknown }).credentials;
    if (!credObj || typeof credObj !== "object") continue;
    const c = credObj as Record<string, unknown>;
    if (!amazonSpCredentialsLookComplete(c)) continue;
    const lwa = credsRecordToLwa(c);
    if (lwa) {
      const rawIds = marketplaceIdsFromCredentials(c);
      const valid = filterValidAmazonRetailMarketplaceIds(rawIds);
      const marketplaceIds = valid.length ? valid : [DEFAULT_MARKETPLACE_ID];
      return { ok: true, credentials: lwa, marketplaceIds, catalogHost: catalogHostFromCredentials(c) };
    }
  }

  return { ok: false, error: "Amazon SP-API credentials not configured for workspace/store" };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const v199RunId = v199RunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const approval = readApiApproval();
  const spApiEnabled = envFlag("AMAZON_SP_API_ENABLED");
  const autoCreateEnabled = envFlag("PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED");
  const stagingUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const stagingOk = supabaseUrlMatchesStagingRef(stagingUrl, STAGING_REF);

  if (!approval.approved) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), `# Blocked\n\nAPI approval not true in \`${API_APPROVAL}\`.\n`);
    throw new Error("API approval not true");
  }
  if (!spApiEnabled || !autoCreateEnabled || !stagingOk) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      `# Blocked\n\nspApi=${spApiEnabled} autoCreate=${autoCreateEnabled} stagingOk=${stagingOk}\n`,
    );
    throw new Error("Env gates not satisfied");
  }

  const cohortPath = path.join(process.cwd(), V199_BASE, v199RunId, "api-evidence-cohort.json");
  const cohort = (JSON.parse(fs.readFileSync(cohortPath, "utf8")) as { rows: CohortRow[] }).rows;
  const bundles = groupByAsin(cohort);

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const url = process.env.STAGING_SUPABASE_URL?.trim() || stagingUrl;
  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!dbUrl || !key || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error("Staging DB/Supabase guard failed");
  }

  const orgId = bundles[0]?.organization_id ?? "00000000-0000-0000-0000-000000000001";
  const storeId = bundles[0]?.store_id ?? "509ee1f6-622c-46a5-8110-7b889ba46c2c";

  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();
  await pgClient.query(`SET statement_timeout = '180s'`);

  const ctx = await resolveAmazonCatalogContextPg(pgClient, orgId, storeId);
  if (!ctx.ok) {
    fs.writeFileSync(path.join(outDir, "credential-proof.json"), JSON.stringify({ ok: false, error: ctx.error }, null, 2));
    await pgClient.end();
    throw new Error(`SP-API credentials: ${ctx.error}`);
  }
  let accessToken: string;
  try {
    const t = await getAmazonAccessToken(ctx.credentials);
    accessToken = t.accessToken;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "token_failed";
    fs.writeFileSync(
      path.join(outDir, "credential-proof.json"),
      JSON.stringify({ ok: false, stage: "token", error: msg }, null, 2),
    );
    await pgClient.end();
    throw new Error(`SP-API token: ${msg}`);
  }

  fs.writeFileSync(
    path.join(outDir, "credential-proof.json"),
    JSON.stringify(
      {
        ok: true,
        staging_ref: STAGING_REF,
        catalog_host: ctx.catalogHost,
        marketplace_ids: ctx.marketplaceIds,
        token_obtained: true,
        lwa_client_id_present: !!ctx.credentials.lwaClientId,
      },
      null,
      2,
    ),
  );

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const beforeCoverage = await coverage(pgClient);
  const beforeCounts = await pgClient.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS active_map_rows,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE match_source = $1 AND deleted_at IS NULL) AS cohort_map_rows
  `, [MATCH_SOURCE]);

  const lineResults: LineResult[] = [];
  const insertedProducts: Record<string, unknown>[] = [];
  const insertedMaps: Record<string, unknown>[] = [];
  let apiCallCount = 0;

  for (const bundle of bundles) {
    const existing = await pgClient.query(
      `SELECT id::text FROM public.products
       WHERE organization_id = $1::uuid AND store_id = $2::uuid
         AND UPPER(TRIM(asin)) = $3
         AND deleted_at IS NULL
         AND (merge_status IS NULL OR merge_status <> 'merged')
       LIMIT 2`,
      [bundle.organization_id, bundle.store_id, bundle.asin],
    );
    if ((existing.rowCount ?? 0) > 1) {
      lineResults.push({
        asin: bundle.asin,
        expected_package_ids: bundle.expected_package_ids,
        outcome: "blocked_ambiguous_existing_products",
        catalog_ok: false,
        product_id: null,
        map_inserted: false,
        api_called: false,
        detail: "multiple products for asin+store",
      });
      continue;
    }

    if (existing.rows.length === 1) {
      const pid = String((existing.rows[0] as { id: string }).id);
      const mapExists = await pgClient.query(
        `SELECT 1 FROM public.product_identifier_map
         WHERE organization_id = $1::uuid AND store_id = $2::uuid AND product_id = $3::uuid
           AND deleted_at IS NULL AND asin = $4 LIMIT 1`,
        [bundle.organization_id, bundle.store_id, pid, bundle.asin],
      );
      lineResults.push({
        asin: bundle.asin,
        expected_package_ids: bundle.expected_package_ids,
        outcome: "skipped_product_already_exists",
        catalog_ok: true,
        product_id: pid,
        map_inserted: (mapExists.rowCount ?? 0) > 0,
        api_called: false,
        detail: "no_api_product_already_on_spine",
      });
      continue;
    }

    const cat = await fetchCatalogJson(ctx.catalogHost, accessToken, ctx.marketplaceIds, bundle.asin);
    apiCallCount += 1;
    await sleep(400);

    if (!cat.ok) {
      lineResults.push({
        asin: bundle.asin,
        expected_package_ids: bundle.expected_package_ids,
        outcome: "catalog_lookup_failed",
        catalog_ok: false,
        product_id: null,
        map_inserted: false,
        api_called: true,
        detail: cat.error,
      });
      continue;
    }

    const extracted = extractCatalogMainImageAndText(cat.body);
    const productName = extracted.product_name ?? bundle.asin;
    const insertRow = {
      organization_id: bundle.organization_id,
      store_id: bundle.store_id,
      product_name: productName,
      asin: bundle.asin,
      fnsku: bundle.fnsku,
      sku: bundle.sku,
      upc_code: null,
      barcode: null,
      main_image_url: extracted.main_image_url,
      image_url: extracted.main_image_url,
      brand: extracted.brand,
      status: "active",
      metadata: {
        source: "amazon_sp_api_catalog_items",
        prompt: "EXPECTED-PACKAGES-AMAZON-API-EVIDENCE-EXECUTE-V199",
        expected_package_ids: bundle.expected_package_ids,
        v199_run_id: v199RunId,
      },
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    };

    const { data: product, error: pErr } = await supabase
      .from("products")
      .insert(insertRow)
      .select("id, product_name, asin, fnsku, sku")
      .single();

    if (pErr || !product) {
      lineResults.push({
        asin: bundle.asin,
        expected_package_ids: bundle.expected_package_ids,
        outcome: "product_insert_failed",
        catalog_ok: true,
        product_id: null,
        map_inserted: false,
        api_called: true,
        detail: pErr?.message ?? "product_insert_failed",
      });
      continue;
    }

    const productId = String((product as { id: string }).id);
    const externalListingId = `${MATCH_SOURCE}:${productId}`;
    const { error: mErr } = await supabase.from("product_identifier_map").insert({
      organization_id: bundle.organization_id,
      store_id: bundle.store_id,
      product_id: productId,
      seller_sku: bundle.sku,
      msku: bundle.sku,
      asin: bundle.asin,
      fnsku: bundle.fnsku,
      match_source: MATCH_SOURCE,
      source_report_type: MATCH_SOURCE,
      external_listing_id: externalListingId,
      is_primary: true,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    });

    if (mErr) {
      lineResults.push({
        asin: bundle.asin,
        expected_package_ids: bundle.expected_package_ids,
        outcome: "map_insert_failed",
        catalog_ok: true,
        product_id: productId,
        map_inserted: false,
        api_called: true,
        detail: mErr.message,
      });
      insertedProducts.push({ ...product, rollback_note: "map_failed_product_orphan" });
      continue;
    }

    insertedProducts.push(product as Record<string, unknown>);
    insertedMaps.push({ product_id: productId, asin: bundle.asin, external_listing_id: externalListingId });
    lineResults.push({
      asin: bundle.asin,
      expected_package_ids: bundle.expected_package_ids,
      outcome: "product_and_map_inserted",
      catalog_ok: true,
      product_id: productId,
      map_inserted: true,
      api_called: true,
      detail: productName,
    });
  }

  const afterCoverage = await coverage(pgClient);
  const afterCounts = await pgClient.query(
    `
    SELECT
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS active_map_rows,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE match_source = $1 AND deleted_at IS NULL) AS cohort_map_rows
  `,
    [MATCH_SOURCE],
  );
  await pgClient.end();

  const cohortEpIds = new Set(cohort.flatMap((r) => r.expected_package_id));
  const resolvedAfter = await (async () => {
    const c = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const r = await c.query(
      `
      WITH ep AS (
        SELECT e.id, NULLIF(TRIM(e.fnsku), '') AS fnsku, NULLIF(TRIM(e.sku), '') AS sku
        FROM public.expected_packages e WHERE e.id = ANY($1::uuid[])
      ),
      map_fnsku AS (
        SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
        FROM ep
        JOIN public.product_identifier_map m ON m.organization_id = $2::uuid AND m.store_id = $3::uuid
         AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku = ep.fnsku
        GROUP BY ep.id
      ),
      map_sku AS (
        SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
        FROM ep
        JOIN public.product_identifier_map m ON m.organization_id = $2::uuid AND m.store_id = $3::uuid
         AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku = ep.sku OR m.msku = ep.sku)
        GROUP BY ep.id
      )
      SELECT COUNT(*) FILTER (WHERE COALESCE(mf.c,0)=1 OR COALESCE(ms.c,0)=1)::int AS resolved
      FROM ep LEFT JOIN map_fnsku mf ON mf.id=ep.id LEFT JOIN map_sku ms ON ms.id=ep.id
    `,
      [[...cohortEpIds], orgId, storeId],
    );
    await c.end();
    return Number(r.rows[0]?.resolved ?? 0);
  })();

  fs.writeFileSync(path.join(outDir, "execute-lines.json"), JSON.stringify(lineResults, null, 2));
  fs.writeFileSync(path.join(outDir, "inserted-products.json"), JSON.stringify(insertedProducts, null, 2));
  fs.writeFileSync(path.join(outDir, "inserted-map-rows.json"), JSON.stringify(insertedMaps, null, 2));

  const inserted = lineResults.filter((l) => l.outcome === "product_and_map_inserted").length;
  const failed = lineResults.filter((l) => l.outcome.includes("failed")).length;
  const skipped = lineResults.filter((l) => l.outcome.startsWith("skipped")).length;

  const manifest = {
    prompt: "EXPECTED-PACKAGES-AMAZON-API-EVIDENCE-EXECUTE-V199",
    run_id: runId,
    v199_run_id: v199RunId,
    staging_ref: STAGING_REF,
    status: failed === 0 ? "PASS" : inserted > 0 ? "PARTIAL_PASS" : "FAIL",
    approval,
    credential_proof: true,
    amazon_api_calls: apiCallCount,
    distinct_asins: bundles.length,
    cohort_rows: cohort.length,
    outcomes: { inserted, skipped, failed },
    cohort_ep_read_layer_resolved_after: resolvedAfter,
    expected_packages_updated: false,
    before_coverage: beforeCoverage,
    after_coverage: afterCoverage,
    before_counts: beforeCounts.rows[0],
    after_counts: afterCounts.rows[0],
    manual_review_deferred: { source_disagreement: 6, identifier_manual: 38 },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "execute-summary.md"),
    [
      "# Amazon API evidence execute V199",
      "",
      `- **Credential preflight:** PASS (token obtained, no secrets logged)`,
      `- **Distinct ASINs:** ${bundles.length}`,
      `- **Amazon catalog API calls:** ${apiCallCount}`,
      `- **Products inserted:** ${inserted}`,
      `- **Skipped (already on spine):** ${skipped}`,
      `- **Failed:** ${failed}`,
      `- **Cohort EP rows read-resolved after:** ${resolvedAfter} / ${cohort.length}`,
      `- **Read-layer (all EP):** ${beforeCoverage.read_layer_resolved} → **${afterCoverage.read_layer_resolved}**`,
      "",
      "Manual review (not executed): 6 source-disagreement + 38 identifier-only per `manual-review-queue.csv`.",
    ].join("\n") + "\n",
  );

  const mapIds = insertedMaps.map((m) => `'${String(m.external_listing_id).replace(/'/g, "''")}'`);
  const prodIds = insertedProducts.map((p) => `'${String(p.id).replace(/'/g, "''")}'::uuid`);
  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      "-- Rollback V199 API evidence execute batch only.",
      "DELETE FROM public.product_identifier_map",
      mapIds.length ? `WHERE external_listing_id IN (${mapIds.join(", ")});` : "WHERE false;",
      "",
      "DELETE FROM public.products",
      prodIds.length ? `WHERE id IN (${prodIds.join(", ")});` : "WHERE false;",
      "",
    ].join("\n"),
  );

  console.log(JSON.stringify(manifest, null, 2));
  if (failed > 0 && inserted === 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
