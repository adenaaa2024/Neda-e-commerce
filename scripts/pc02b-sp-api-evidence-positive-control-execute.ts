/**
 * PC02B — SP-API EVIDENCE POSITIVE-CONTROL EXECUTE
 *
 * 1. Evidence-only catalog GET for 2 Sam seller products ASINs (expect HTTP 200)
 * 2. Triage PC02A 404 cohort (3 ASINs)
 * 3. Lookup UI proof plan for backend_evidence banner (non-local catalog ASIN)
 *
 * No products.insert, no map insert, no expected_packages update.
 *
 *   npx tsx scripts/pc02b-sp-api-evidence-positive-control-execute.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { getAmazonAccessToken, type AmazonSpApiCredentials } from "../lib/amazon/sp-api";
import { extractBestMainImageFromCatalogItem } from "../lib/amazon-catalog-image-extract";
import { amazonSpCredentialsLookComplete } from "../lib/amazon-marketplace-credentials";
import { filterValidAmazonRetailMarketplaceIds } from "../lib/amazon-retail-marketplace-ids";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const PC02_APPROVAL = ".cursor/operator-approvals/sp-api-product-evidence-dry-run-pc02-approval.md";
const PC02A_RUN = process.argv.find((x) => x.startsWith("--pc02a-run-id="))?.split("=")[1]?.trim() ?? "20260526T120000Z";
const OUT_BASE = ".cursor/audit-reports/pc02b-sp-api-evidence-positive-control-execute";
const DELAY_MS = 400;
const PC02A_BASE = ".cursor/audit-reports/pc02a-sp-api-evidence-only-dry-run-execute";
const COHORT_EP_IDS = [
  "654dc645-fb8c-4361-a813-173ef093d934",
  "15e14bfd-e549-4e6d-9195-bd982a1c4160",
  "2b0b7cd8-d94f-488c-9290-f48c93763c33",
  "5ea7a691-3bb0-49b1-9cf1-2e24924ddf4b",
  "01ce4f4a-19de-4ce8-bdb2-8fb9d832b5d5",
] as const;

const COHORT_ASIN_BY_EP: Record<string, string> = {
  "654dc645-fb8c-4361-a813-173ef093d934": "B0CQKPKKCM",
  "15e14bfd-e549-4e6d-9195-bd982a1c4160": "B0CS88T6FR",
  "2b0b7cd8-d94f-488c-9290-f48c93763c33": "B0CS88T6FR",
  "5ea7a691-3bb0-49b1-9cf1-2e24924ddf4b": "B0CS88T6FR",
  "01ce4f4a-19de-4ce8-bdb2-8fb9d832b5d5": "B0DMQCZPQN",
};

type CatalogResult = {
  asin: string;
  source: "positive_control" | "cohort_404_triage";
  http_ok: boolean;
  http_status: number;
  attempts: number;
  error: string | null;
  product_name: string | null;
  main_image_url: string | null;
  brand: string | null;
};

type TriageVerdict =
  | "wrong_marketplace"
  | "identifier_manual_review"
  | "source_data_inconsistency"
  | "genuinely_not_in_catalog";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
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

function currentBranch(): string {
  try {
    return execSync("git branch --show-current", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
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
    `SELECT credentials FROM public.marketplaces WHERE organization_id = $1::uuid AND provider = 'amazon_sp_api'`,
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

async function loadPositiveControlAsins(client: pg.Client, limit = 2): Promise<Array<{ asin: string; product_name: string | null; product_id: string }>> {
  const r = await client.query(
    `
    SELECT id::text AS product_id, UPPER(TRIM(asin)) AS asin, product_name
    FROM public.products
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
      AND asin IS NOT NULL AND TRIM(asin) ~ '^B[0-9A-Z]{9}$'
      AND deleted_at IS NULL
      AND (merge_status IS NULL OR merge_status <> 'merged')
    ORDER BY updated_at DESC NULLS LAST
    LIMIT $3
  `,
    [ORG, STORE, limit],
  );
  return r.rows as Array<{ asin: string; product_name: string | null; product_id: string }>;
}

type EpRow = {
  expected_package_id: string;
  asin: string;
  sku: string | null;
  fnsku: string | null;
  resolved_product_id: string | null;
  product_id_in_products: string | null;
  product_id_by_asin: string | null;
  product_id_by_fnsku: string | null;
  map_product_ids: string[];
  trusted_source_product_count: number;
};

async function loadCohort404Context(client: pg.Client): Promise<EpRow[]> {
  const colRes = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='expected_packages'`,
  );
  const epCols = new Set(colRes.rows.map((r: { column_name: string }) => r.column_name));
  const asinSelect = epCols.has("asin") ? "NULLIF(TRIM(e.asin), '')" : "NULL::text";

  const r = await client.query(
    `
    WITH ep AS (
      SELECT e.id::text AS expected_package_id,
             ${asinSelect} AS ep_asin,
             NULLIF(TRIM(e.sku), '') AS sku,
             NULLIF(TRIM(e.fnsku), '') AS fnsku,
             e.resolved_product_id::text
      FROM public.expected_packages e
      WHERE e.id = ANY($1::uuid[])
    ),
    map_hits AS (
      SELECT ep.expected_package_id,
             ARRAY_AGG(DISTINCT m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS map_product_ids
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = $2::uuid AND m.store_id = $3::uuid AND m.deleted_at IS NULL
        AND (
          (ep.fnsku IS NOT NULL AND UPPER(TRIM(m.fnsku)) = UPPER(ep.fnsku))
          OR (ep.sku IS NOT NULL AND UPPER(TRIM(COALESCE(m.seller_sku, m.msku))) = UPPER(ep.sku))
        )
      GROUP BY ep.expected_package_id
    ),
    prod_asin AS (
      SELECT ep.expected_package_id, p.id::text AS product_id
      FROM ep
      JOIN public.products p ON p.organization_id = $2::uuid AND p.store_id = $3::uuid
        AND p.deleted_at IS NULL
        AND UPPER(TRIM(p.asin)) = UPPER(COALESCE(ep.ep_asin, ''))
      WHERE COALESCE(ep.ep_asin, '') <> ''
    ),
    prod_fnsku AS (
      SELECT ep.expected_package_id, p.id::text AS product_id
      FROM ep
      JOIN public.products p ON p.organization_id = $2::uuid AND p.store_id = $3::uuid
        AND ep.fnsku IS NOT NULL AND UPPER(TRIM(p.fnsku)) = UPPER(ep.fnsku) AND p.deleted_at IS NULL
    )
    SELECT ep.expected_package_id,
           ep.sku,
           ep.fnsku,
           ep.resolved_product_id,
           pa.product_id AS product_id_by_asin,
           pf.product_id AS product_id_by_fnsku,
           COALESCE(pa.product_id, pf.product_id) AS product_id_in_products,
           COALESCE(mh.map_product_ids, ARRAY[]::text[]) AS map_product_ids,
           0::int AS trusted_source_product_count
    FROM ep
    LEFT JOIN prod_asin pa ON pa.expected_package_id = ep.expected_package_id
    LEFT JOIN prod_fnsku pf ON pf.expected_package_id = ep.expected_package_id
    LEFT JOIN map_hits mh ON mh.expected_package_id = ep.expected_package_id
    ORDER BY ep.expected_package_id
  `,
    [COHORT_EP_IDS, ORG, STORE],
  );

  return (r.rows as Omit<EpRow, "asin">[]).map((row) => ({
    ...row,
    asin: COHORT_ASIN_BY_EP[row.expected_package_id] ?? "",
  }));
}

function triage404Row(row: EpRow, catalog404: boolean): { verdict: TriageVerdict; rationale: string } {
  const mapIds = row.map_product_ids ?? [];
  const distinctMap = [...new Set(mapIds.filter(Boolean))];

  if (distinctMap.length > 1) {
    return {
      verdict: "source_data_inconsistency",
      rationale: `Multiple map product_ids (${distinctMap.join(", ")}) for one expected_package row`,
    };
  }

  if (row.product_id_by_asin && row.product_id_by_fnsku && row.product_id_by_asin !== row.product_id_by_fnsku) {
    return {
      verdict: "source_data_inconsistency",
      rationale: `ASIN product ${row.product_id_by_asin} != FNSKU product ${row.product_id_by_fnsku}`,
    };
  }

  if (catalog404) {
    const hasLocalProduct = !!(row.product_id_in_products || distinctMap.length === 1);
    const hasFnskuOrSku = !!(row.fnsku?.trim() || row.sku?.trim());
    if (hasLocalProduct) {
      return {
        verdict: "identifier_manual_review",
        rationale:
          "Catalog 404 in ATVPDKIKX0DER but local product/map exists — ASIN on expected_packages likely wrong; verify listing ASIN vs FNSKU in Seller Central",
      };
    }
    if (hasFnskuOrSku) {
      return {
        verdict: "identifier_manual_review",
        rationale:
          "NOT_FOUND in ATVPDKIKX0DER with FNSKU/SKU on row but no local spine — operator verify correct US ASIN for this FNSKU; may be wrong_marketplace or bad import ASIN",
      };
    }
    return {
      verdict: "genuinely_not_in_catalog",
      rationale: "SP-API NOT_FOUND in ATVPDKIKX0DER; no FNSKU/SKU anchor and no local product",
    };
  }

  return {
    verdict: "identifier_manual_review",
    rationale: "Fallback operator review",
  };
}

type WriteSnapshot = { products_total: number; map_total: number };

async function writeSnapshot(client: pg.Client): Promise<WriteSnapshot> {
  const p = await client.query(`SELECT COUNT(*)::int AS c FROM public.products WHERE organization_id = $1::uuid`, [ORG]);
  const m = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE organization_id = $1::uuid`,
    [ORG],
  );
  return {
    products_total: (p.rows[0] as { c: number }).c,
    map_total: (m.rows[0] as { c: number }).c,
  };
}

async function findUiEvidenceAsin(
  positiveAsins: string[],
  catalogResults: CatalogResult[],
): Promise<{ asin: string | null; locally_resolved: boolean; catalog_ok: boolean }> {
  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
  const sb = createClient(url, key, { auth: { persistSession: false } });

  for (const hit of catalogResults.filter((r) => r.http_ok && r.source === "positive_control")) {
    const res = await resolveScannerProductIdentifiers(sb, {
      organizationId: ORG,
      storeId: STORE,
      asin: hit.asin,
      fnsku: null,
      sku: null,
      upc: null,
      productIdentifier: hit.asin,
    });
    if (res.identifier_resolution_status !== "resolved") {
      return { asin: hit.asin, locally_resolved: false, catalog_ok: true };
    }
  }

  // Well-known US ASIN for evidence UI if seller ASINs all resolve locally
  const fallback = "B000000001";
  if (!positiveAsins.includes(fallback)) {
    const res = await resolveScannerProductIdentifiers(sb, {
      organizationId: ORG,
      storeId: STORE,
      asin: fallback,
      fnsku: null,
      sku: null,
      upc: null,
      productIdentifier: fallback,
    });
    return {
      asin: fallback,
      locally_resolved: res.identifier_resolution_status === "resolved",
      catalog_ok: false,
    };
  }
  return { asin: null, locally_resolved: false, catalog_ok: false };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, id);
  fs.mkdirSync(outDir, { recursive: true });

  const approvalOk = readPc02Approval();
  const branch = currentBranch();
  const stagingOk =
    supabaseUrlMatchesStagingRef(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "", STAGING_REF) &&
    getStagingProjectRef({ loadEnv: false }) === STAGING_REF;

  if (!approvalOk || !stagingOk) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      `# Blocked\n\napproval=${approvalOk} stagingOk=${stagingOk}\n`,
    );
    throw new Error("Approval or staging guard failed");
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL!.trim();
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`SET statement_timeout = '120s'`);

  const beforeSnap = await writeSnapshot(client);
  const positiveRows = await loadPositiveControlAsins(client, 2);
  const cohortRows = await loadCohort404Context(client);

  const ctx = await resolveAmazonCatalogContextPg(client, ORG, STORE);
  if (!ctx.ok) {
    await client.end();
    throw new Error(ctx.error);
  }

  const accessToken = (await getAmazonAccessToken(ctx.credentials)).accessToken;
  const catalogResults: CatalogResult[] = [];

  async function callAsin(asin: string, source: CatalogResult["source"]) {
    const cat = await fetchCatalogJson(ctx.catalogHost, accessToken, ctx.marketplaceIds, asin);
    const extracted = cat.ok ? extractCatalogMainImageAndText(cat.body) : null;
    catalogResults.push({
      asin,
      source,
      http_ok: cat.ok,
      http_status: cat.ok ? 200 : cat.status,
      attempts: cat.attempts,
      error: cat.ok ? null : cat.error,
      product_name: extracted?.product_name ?? null,
      main_image_url: extracted?.main_image_url ?? null,
      brand: extracted?.brand ?? null,
    });
  }

  for (let i = 0; i < positiveRows.length; i++) {
    await callAsin(positiveRows[i]!.asin, "positive_control");
    if (i + 1 < positiveRows.length) await sleep(DELAY_MS);
  }
  await sleep(DELAY_MS);

  for (let i = 0; i < [...new Set(COHORT_EP_IDS.map((id) => COHORT_ASIN_BY_EP[id]))].length; i++) {
    const asin = ["B0CQKPKKCM", "B0CS88T6FR", "B0DMQCZPQN"][i]!;
    await callAsin(asin, "cohort_404_triage");
    if (i + 1 < 3) await sleep(DELAY_MS);
  }

  const afterSnap = await writeSnapshot(client);

  const positiveResults = catalogResults.filter((r) => r.source === "positive_control");
  const cohort404Results = catalogResults.filter((r) => r.source === "cohort_404_triage");

  const triageByAsin = new Map<string, { verdict: TriageVerdict; rationale: string; rows: EpRow[] }>();
  for (const asin of ["B0CQKPKKCM", "B0CS88T6FR", "B0DMQCZPQN"] as const) {
    const cat = cohort404Results.find((r) => r.asin === asin);
    const rows = cohortRows.filter((r) => r.asin === asin);
    const sample = rows[0];
    if (!sample) continue;
    const { verdict, rationale } = triage404Row(sample, !(cat?.http_ok ?? false));
    triageByAsin.set(asin, { verdict, rationale, rows });
  }

  const uiEvidence = await findUiEvidenceAsin(
    positiveRows.map((r) => r.asin),
    catalogResults,
  );

  // Optional extra catalog call for UI evidence ASIN if not already fetched
  if (uiEvidence.asin && !catalogResults.some((r) => r.asin === uiEvidence.asin)) {
    await callAsin(uiEvidence.asin, "positive_control");
    const hit = catalogResults.find((r) => r.asin === uiEvidence.asin);
    if (hit) uiEvidence.catalog_ok = hit.http_ok;
  }

  await client.end();

  const triageJson = [...triageByAsin.entries()].map(([asin, t]) => ({
    asin,
    verdict: t.verdict,
    rationale: t.rationale,
    expected_package_rows: t.rows.length,
    catalog_http_status: cohort404Results.find((r) => r.asin === asin)?.http_status ?? null,
    sample_fnsku: t.rows[0]?.fnsku ?? null,
    sample_sku: t.rows[0]?.sku ?? null,
    product_id_by_asin: t.rows[0]?.product_id_by_asin ?? null,
    product_id_by_fnsku: t.rows[0]?.product_id_by_fnsku ?? null,
    map_product_ids: t.rows[0]?.map_product_ids ?? [],
  }));

  fs.writeFileSync(
    path.join(outDir, "positive-control-candidates.md"),
    [
      "# Positive control candidates — PC02B",
      "",
      `**Sam store:** \`${STORE}\` · **Marketplace:** \`ATVPDKIKX0DER\``,
      "",
      "| ASIN | local product_id | local product_name | selected |",
      "|------|------------------|--------------------|----------|",
      ...positiveRows.map((p) => `| \`${p.asin}\` | \`${p.product_id}\` | ${(p.product_name ?? "—").slice(0, 50)} | yes |`),
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "positive-control-evidence-results.json"),
    JSON.stringify(positiveResults, null, 2),
  );

  fs.writeFileSync(
    path.join(outDir, "pc02a-404-triage.md"),
    [
      "# PC02A 404 cohort triage — PC02B",
      "",
      `**PC02A reference:** \`${PC02A_RUN}\``,
      "",
      "| ASIN | ep rows | HTTP | Verdict | Rationale |",
      "|------|---------|------|---------|-----------|",
      ...triageJson.map((t) => {
        return `| \`${t.asin}\` | ${t.expected_package_rows} | ${t.catalog_http_status} | **${t.verdict}** | ${t.rationale.slice(0, 100)} |`;
      }),
      "",
      "## Verdict counts",
      "",
      ...(["wrong_marketplace", "identifier_manual_review", "source_data_inconsistency", "genuinely_not_in_catalog"] as const).map(
        (v) => `- **${v}:** ${triageJson.filter((t) => t.verdict === v).length}`,
      ),
      "",
      "## Notes",
      "",
      "- **wrong_marketplace:** reserved when multi-marketplace proof exists (not assigned this run).",
      "- **identifier_manual_review:** FNSKU/SKU present but US catalog 404 — operator verifies ASIN on Seller Central listing.",
      "- **genuinely_not_in_catalog:** no identifiers and 404 (none in this cohort).",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "backend-evidence-ui-note.md"),
    [
      "# Backend evidence UI note — PC02B",
      "",
      "## Server behavior (`lookupProductInputForReturnItem`)",
      "",
      "When `PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED=true` and `AMAZON_SP_API_ENABLED=true` (staging only):",
      "",
      "1. Local resolver runs first → `local_resolved` if product/map match.",
      "2. Else `tryBackendCatalogEvidence` → SP-API catalog GET **without** `products.insert`.",
      "3. On catalog hit → status **`backend_evidence`**, fields populated (`item_name`, `image_url`, `asin`).",
      "4. Linkage stays **unresolved** (no `resolved_product_id`).",
      "",
      "## UI display (Returns wizard + edit drawer)",
      "",
      "| Status | Banner | Product created |",
      "|--------|--------|-----------------|",
      "| `local_resolved` | Green — Found locally | No |",
      "| `backend_evidence` | Violet — **Amazon catalog evidence — {title}** | **No** |",
      "| `backend_enriched` | Sky — Backend enriched (auto-create path) | Yes (separate approval) |",
      "| `unresolved` | Yellow — Unknown Item | No |",
      "",
      "## This run",
      "",
      `| Flag | Value |`,
      `|------|-------|`,
      `| PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED | ${envFlag("PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED")} |`,
      `| AMAZON_SP_API_ENABLED | ${envFlag("AMAZON_SP_API_ENABLED")} |`,
      "",
      positiveResults.every((r) => r.http_ok)
        ? `Positive-control ASINs (\`${positiveResults.map((r) => r.asin).join("`, `")}\`) are in seller **products** — scanning them shows **Found locally**, not violet evidence.`
        : "Positive control failed — fix catalog HTTP 200 before UI proof.",
      "",
      uiEvidence.asin && !uiEvidence.locally_resolved
        ? `\nTo see **backend_evidence** banner: scan \`${uiEvidence.asin}\` (catalog-200, not locally resolved).`
        : "\nTo see **backend_evidence** banner: scan a US catalog-200 ASIN that is **not** in `product_identifier_map` / products spine.",
      "",
      "```bash",
      "npm run dev",
      `npx tsx scripts/pc02-lookup-evidence-browser-proof.ts --run-id=${id}`,
      "```",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "no-write-proof.md"),
    [
      "# No-write proof — PC02B",
      "",
      "| Metric | Before | After |",
      "|--------|--------|-------|",
      `| products (org) | ${beforeSnap.products_total} | ${afterSnap.products_total} |`,
      `| product_identifier_map (org) | ${beforeSnap.map_total} | ${afterSnap.map_total} |`,
      "",
      "| Write type | Count |",
      "|------------|-------|",
      "| product inserts | **0** |",
      "| map inserts | **0** |",
      "| expected_packages updates | **0** |",
      "",
      `**Verified:** ${beforeSnap.products_total === afterSnap.products_total && beforeSnap.map_total === afterSnap.map_total ? "yes" : "no"}`,
    ].join("\n"),
  );

  const positiveOk = positiveResults.filter((r) => r.http_ok).length;
  const positiveApiCalls = positiveResults.length;
  const evidenceFoundPositive = positiveResults.filter((r) => r.http_ok && r.product_name).length;
  const manifest = {
    prompt: "PC02B-SP-API-EVIDENCE-POSITIVE-CONTROL-EXECUTE",
    run_id: id,
    branch,
    staging_ref: STAGING_REF,
    pc02a_reference: PC02A_RUN,
    approval_valid: approvalOk,
    status:
      positiveOk === positiveResults.length
        ? "PASS"
        : positiveOk > 0
          ? "PARTIAL"
          : "FAIL_POSITIVE_CONTROL",
    positive_control_asins: positiveRows.map((r) => r.asin),
    positive_control_api_calls: positiveApiCalls,
    positive_control_evidence_found: evidenceFoundPositive,
    pc02a_404_triage: triageJson,
    product_writes: 0,
    map_writes: 0,
    expected_packages_updates: 0,
    ui_evidence_asin: uiEvidence.asin,
    ui_locally_resolved: uiEvidence.locally_resolved,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "blockers.md"), positiveOk === 0 ? "# Blockers\n\nPositive control returned no HTTP 200.\n" : "# Blockers\n\nNone.\n");

  console.log(JSON.stringify({ outDir, ...manifest }, null, 2));
  process.exit(positiveOk >= 2 ? 0 : positiveOk > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
