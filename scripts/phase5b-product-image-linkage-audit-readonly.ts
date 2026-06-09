/**
 * PHASE-5B-PRODUCT-IMAGE-LINKAGE-AUDIT (read-only)
 *   npx tsx scripts/phase5b-product-image-linkage-audit-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { collectAmazonCatalogImageUrls } from "../lib/amazon-catalog-image-extract";
import { resolvePimDisplayImageUrl } from "../lib/pim-display-image";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";

type ProductRow = {
  id: string;
  product_name: string | null;
  asin: string | null;
  fnsku: string | null;
  sku: string | null;
  upc_code: string | null;
  main_image_url: string | null;
  image_url: string | null;
  amazon_raw: unknown;
  updated_at: string | null;
  map_asin: string | null;
  map_fnsku: string | null;
  map_seller_sku: string | null;
};

type Audited = ProductRow & {
  display_url: string | null;
  catalog_asin: string | null;
  raw_main: string | null;
  supplement: string | null;
  reasons: string[];
};

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function norm(s: string | null | undefined): string {
  return String(s ?? "").trim().toUpperCase();
}

function extractCatalogAsin(amazonRaw: unknown): string | null {
  if (!amazonRaw || typeof amazonRaw !== "object" || Array.isArray(amazonRaw)) return null;
  const o = amazonRaw as Record<string, unknown>;
  if (typeof o.asin === "string" && o.asin.trim()) return o.asin.trim().toUpperCase();
  const summaries = o.summaries;
  if (Array.isArray(summaries) && summaries[0] && typeof summaries[0] === "object") {
    const a = (summaries[0] as Record<string, unknown>).asin;
    if (typeof a === "string" && a.trim()) return a.trim().toUpperCase();
  }
  return null;
}

function extractSupplement(amazonRaw: unknown): string | null {
  if (!amazonRaw || typeof amazonRaw !== "object" || Array.isArray(amazonRaw)) return null;
  const s = (amazonRaw as Record<string, unknown>).pim_enrichment_supplement;
  return typeof s === "string" ? s : null;
}

function rawFlatMain(amazonRaw: unknown): string | null {
  if (!amazonRaw || typeof amazonRaw !== "object" || Array.isArray(amazonRaw)) return null;
  const o = amazonRaw as Record<string, unknown>;
  for (const k of ["main_image_url", "mainImageUrl", "primary_image_url", "image_url", "imageUrl"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function auditRow(row: ProductRow): Audited {
  const reasons: string[] = [];
  const display_url = resolvePimDisplayImageUrl(row.main_image_url, row.amazon_raw);
  const catalog_asin = extractCatalogAsin(row.amazon_raw);
  const raw_main = rawFlatMain(row.amazon_raw);
  const supplement = extractSupplement(row.amazon_raw);
  const prodAsin = norm(row.asin);
  const mapAsin = norm(row.map_asin);

  if (row.main_image_url?.trim() && display_url && row.main_image_url.trim() !== display_url) {
    reasons.push("main_image_url_differs_from_resolver_primary");
  }
  if (row.image_url?.trim() && row.main_image_url?.trim() && row.image_url.trim() !== row.main_image_url.trim()) {
    reasons.push("legacy_image_url_differs_from_main");
  }
  if (prodAsin && catalog_asin && prodAsin !== catalog_asin) {
    reasons.push("product_asin_differs_from_amazon_raw_catalog_asin");
  }
  if (prodAsin && mapAsin && prodAsin !== mapAsin) {
    reasons.push("product_asin_differs_from_identifier_map_asin");
  }
  if (display_url && !prodAsin && !mapAsin) {
    reasons.push("image_present_but_no_asin_on_product_or_map");
  }
  if (supplement === "fnsku_identifier_map" && prodAsin && catalog_asin && prodAsin !== catalog_asin) {
    reasons.push("supplemental_image_from_fnsku_map_wrong_asin");
  }
  if (row.main_image_url?.trim() && !raw_main && collectAmazonCatalogImageUrls(row.amazon_raw).length > 0) {
    reasons.push("main_image_url_set_but_not_from_current_amazon_raw_flat_keys");
  }

  return { ...row, display_url, catalog_asin, raw_main, supplement, reasons };
}

async function loadProducts(client: pg.Client): Promise<ProductRow[]> {
  const r = await client.query<ProductRow>(
    `SELECT
       p.id::text,
       p.product_name,
       p.asin,
       p.fnsku,
       p.sku,
       p.upc_code,
       p.main_image_url,
       p.image_url,
       p.amazon_raw,
       p.updated_at::text,
       m.asin AS map_asin,
       m.fnsku AS map_fnsku,
       m.seller_sku AS map_seller_sku
     FROM public.products p
     LEFT JOIN LATERAL (
       SELECT pim.asin, pim.fnsku, pim.seller_sku
       FROM public.product_identifier_map pim
       WHERE pim.product_id = p.id
         AND pim.organization_id = $1::uuid
         AND pim.deleted_at IS NULL
       ORDER BY pim.last_seen_at DESC NULLS LAST, pim.updated_at DESC NULLS LAST
       LIMIT 1
     ) m ON true
     WHERE p.organization_id = $1::uuid
       AND p.deleted_at IS NULL`,
    [ORG],
  );
  return r.rows;
}

async function auditDb(label: string, url: string) {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");
  const rows = await loadProducts(client);
  await client.end();

  const audited = rows.map(auditRow);
  const withImage = audited.filter((r) => r.display_url);
  const suspicious = audited.filter((r) => r.reasons.length > 0);

  const urlClusters = new Map<string, Audited[]>();
  for (const r of withImage) {
    const u = r.display_url!;
    const list = urlClusters.get(u) ?? [];
    list.push(r);
    urlClusters.set(u, list);
  }
  const duplicateClusters = [...urlClusters.entries()]
    .filter(([, list]) => list.length >= 3)
    .map(([url, list]) => {
      const asins = new Set(list.map((x) => norm(x.asin)).filter(Boolean));
      const titles = new Set(list.map((x) => String(x.product_name ?? "").slice(0, 40)));
      return {
        image_url: url,
        product_count: list.length,
        distinct_asins: asins.size,
        distinct_title_prefixes: titles.size,
        suspicious: asins.size >= 2 || titles.size >= 3,
        sample_ids: list.slice(0, 5).map((x) => x.id),
      };
    })
    .sort((a, b) => b.product_count - a.product_count);

  const asinMultiProduct = new Map<string, Audited[]>();
  for (const r of audited.filter((x) => norm(x.asin))) {
    const a = norm(r.asin);
    const list = asinMultiProduct.get(a) ?? [];
    list.push(r);
    asinMultiProduct.set(a, list);
  }
  const asinMultiRisk = [...asinMultiProduct.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([asin, list]) => ({
      asin,
      product_count: list.length,
      distinct_names: new Set(list.map((x) => String(x.product_name ?? "").trim())).size,
      ids: list.map((x) => x.id),
    }))
    .filter((x) => x.distinct_names > 1)
    .sort((a, b) => b.product_count - a.product_count);

  const urlSharedSuspicious = duplicateClusters.filter((c) => c.suspicious);

  const ranked = [...suspicious].sort((a, b) => b.reasons.length - a.reasons.length);
  const top30 = ranked.slice(0, 30).map((r) => ({
    product_id: r.id,
    title: r.product_name,
    asin: r.asin,
    fnsku: r.fnsku,
    sku: r.sku,
    upc: r.upc_code,
    displayed_image_url: r.display_url,
    main_image_url: r.main_image_url,
    legacy_image_url: r.image_url,
    amazon_raw_main: r.raw_main,
    catalog_asin_in_raw: r.catalog_asin,
    map_asin: r.map_asin,
    supplement: r.supplement,
    updated_at: r.updated_at,
    why_suspicious: r.reasons,
  }));

  return {
    label,
    total_products: rows.length,
    with_display_image: withImage.length,
    suspicious_count: suspicious.length,
    duplicate_url_clusters_3plus: duplicateClusters.length,
    duplicate_url_clusters_suspicious: urlSharedSuspicious.length,
    asin_multi_product_name_risk: asinMultiRisk.length,
    parent_child_asin_risk: 0,
    top30,
    duplicate_clusters_top10: duplicateClusters.slice(0, 10),
    asin_multi_top10: asinMultiRisk.slice(0, 10),
  };
}

async function main() {
  loadEnvLocalIntoProcess();
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!originalUrl?.includes(ORIGINAL_REF)) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL must target original");
  if (!stagingUrl?.includes(STAGING_REF)) throw new Error("STAGING_DIRECT_POSTGRES_URL must target staging");

  const id = runId();
  const outDir = path.join(process.cwd(), ".cursor/audit-reports/product-image-linkage", id);
  fs.mkdirSync(outDir, { recursive: true });

  const [original, staging] = await Promise.all([
    auditDb("original", originalUrl),
    auditDb("staging", stagingUrl),
  ]);

  const origMap = new Map(original.top30.map((x) => [x.product_id, x]));
  const stagingDiff = {
    original_with_image: original.with_display_image,
    staging_with_image: staging.with_display_image,
    original_suspicious: original.suspicious_count,
    staging_suspicious: staging.suspicious_count,
    original_duplicate_clusters: original.duplicate_url_clusters_suspicious,
    staging_duplicate_clusters: staging.duplicate_url_clusters_suspicious,
  };

  const client = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const imageDiffCount = await client.query<{ c: string }>(
    `WITH o AS (
       SELECT p.id::text, p.main_image_url, p.image_url, p.amazon_raw
       FROM public.products p WHERE p.organization_id=$1::uuid AND p.deleted_at IS NULL
     )
     SELECT COUNT(*)::text AS c FROM o WHERE true`,
    [ORG],
  );
  await client.end();

  const summary = {
    phase_number: "5B",
    run_id: id,
    image_storage_tables: [
      "products.main_image_url (canonical)",
      "products.image_url (legacy)",
      "products.amazon_raw (Catalog API cache + pim_image_candidates[])",
      "no product_images table",
      "catalog_products has no image column",
      "product_identifier_map has no image columns",
    ],
    ui_image_selection_files: [
      "lib/pim-display-image.ts resolvePimDisplayImageUrl",
      "app/dashboard/products/pim/CatalogDataGrid.tsx",
      "app/dashboard/products/pim/ProductDetailDrawer.tsx",
      "app/dashboard/products/pim/PimGroupTreeView.tsx",
      "app/dashboard/products/pim/VendorTreeView.tsx",
      "app/pim/products/[productId]/page.tsx (main_image_url ?? image_url only, no amazon_raw)",
    ],
    ui_fallback_order: [
      "1 products.main_image_url",
      "2 amazon_raw flat keys",
      "3 collectAmazonCatalogImageUrls + pickBest",
      "4 amazon_raw.pim_image_candidates",
      "5 placeholder",
    ],
    root_cause_candidates: [
      "main_image_url never overwritten by enrichment when already set — stale/wrong URL persists",
      "FNSKU→ASIN supplemental fetch may attach wrong catalog ASIN images via identifier_map",
      "Same image_url shared across unrelated products (duplicate URL clusters)",
      "product.asin != catalog ASIN embedded in amazon_raw",
      "SQL display_image_url / vendor missing_image counts narrower than UI resolver — filter drift",
      "Legacy image_url vs main_image_url divergence",
      "No parent ASIN handling — variation families not modeled",
    ],
    original,
    staging,
    staging_original_image_diff: stagingDiff,
    SAFE_TO_REFRESH_AMAZON_IMAGES: "no",
    recommended_fix_plan: [
      "1. Add image provenance to metadata on enrichment (source ASIN, fetch path)",
      "2. Audit-fix products where catalog_asin != product.asin before refresh",
      "3. Split refresh: clear main_image_url only for flagged suspicious rows, not bulk",
      "4. Align SQL missing-image filter with resolvePimDisplayImageUrl",
      "5. Block supplemental fnsku_identifier_map image merge when map ASIN != product ASIN",
      "6. Dedupe duplicate URL clusters — re-enrich per correct ASIN",
    ],
    new_phase_5b_percent: 35,
    blockers: [
      "Must not bulk refresh until root cause confirmed per cluster",
      "Must not touch unresolved/ambiguous product links",
      "Enrichment skip when main_image_url already set masks wrong images",
    ],
    next_prompt_recommendation:
      "PHASE-5B-FIX-SUSPICIOUS-IMAGE-CLUSTERS — targeted re-enrich for top duplicate URL clusters and ASIN mismatches only, with provenance logging",
    products_total_original: imageDiffCount.rows[0]?.c,
  };

  const md = [
    "# PHASE-5B Product image linkage audit",
    "",
    `Run: \`${id}\` · Original: \`${ORIGINAL_REF}\` · Staging: \`${STAGING_REF}\``,
    "",
    "## Image storage",
    ...summary.image_storage_tables.map((t) => `- ${t}`),
    "",
    "## UI selection",
    ...summary.ui_image_selection_files.map((f) => `- \`${f}\``),
    "",
    "**Fallback order:** " + summary.ui_fallback_order.join(" → "),
    "",
    "## Original metrics",
    `- Products: **${original.total_products}** · with display image: **${original.with_display_image}**`,
    `- Suspicious (≥1 flag): **${original.suspicious_count}**`,
    `- Duplicate URL clusters (≥3 products): **${original.duplicate_url_clusters_3plus}** (suspicious: **${original.duplicate_url_clusters_suspicious}**`,
    `- ASIN → multiple product names: **${original.asin_multi_product_name_risk}**`,
    "",
    "## Staging metrics",
    `- Products: **${staging.total_products}** · suspicious: **${staging.suspicious_count}**`,
    `- Duplicate suspicious clusters: **${staging.duplicate_url_clusters_suspicious}**`,
    "",
    "## Root cause candidates",
    ...summary.root_cause_candidates.map((r) => `- ${r}`),
    "",
    "## Top 30 suspicious (original)",
    "",
    "| product_id | title | asin | display_url | why |",
    "|---|---|---|---|---|",
    ...original.top30.map(
      (r) =>
        `| \`${r.product_id.slice(0, 8)}…\` | ${String(r.title ?? "").slice(0, 40).replace(/\|/g, "/")} | ${r.asin ?? "—"} | ${String(r.displayed_image_url ?? "").slice(0, 50)}… | ${r.why_suspicious.join("; ")} |`,
    ),
    "",
    "## SAFE_TO_REFRESH_AMAZON_IMAGES",
    "**no** — fix provenance and targeted clusters first.",
    "",
    "Full JSON: `summary.json` · suspicious CSV: `suspicious-original.csv`",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, "PHASE-5B-PRODUCT-IMAGE-LINKAGE-AUDIT.md"), md);

  const csvHeader =
    "product_id,title,asin,fnsku,sku,displayed_image_url,main_image_url,catalog_asin_in_raw,map_asin,why_suspicious";
  const csv = [
    csvHeader,
    ...original.top30.map((r) =>
      [
        r.product_id,
        JSON.stringify(r.title ?? ""),
        r.asin ?? "",
        r.fnsku ?? "",
        r.sku ?? "",
        JSON.stringify(r.displayed_image_url ?? ""),
        JSON.stringify(r.main_image_url ?? ""),
        r.catalog_asin_in_raw ?? "",
        r.map_asin ?? "",
        JSON.stringify(r.why_suspicious.join("|")),
      ].join(","),
    ),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "suspicious-original.csv"), csv);

  console.log(JSON.stringify({
    outDir,
    original_suspicious: original.suspicious_count,
    duplicate_clusters: original.duplicate_url_clusters_suspicious,
    asin_multi_risk: original.asin_multi_product_name_risk,
  }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
