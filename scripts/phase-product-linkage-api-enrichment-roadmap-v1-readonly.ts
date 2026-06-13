/**
 * PHASE-PRODUCT-LINKAGE-API-ENRICHMENT-ROADMAP-V1
 * Read-only product linkage architecture plan — no writes, no API calls.
 *
 *   npx tsx scripts/phase-product-linkage-api-enrichment-roadmap-v1-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { fetchLinkageHealthSnapshot } from "../lib/product-linkage-health";
import {
  RESOLUTION_ORDER_OPERATIONAL,
  RESOLUTION_ORDER_SCANNER,
  formatResolutionOrderExport,
} from "../lib/product-linkage-resolution-policy";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-product-linkage-api-enrichment-roadmap-v1";
const MAIN_ORG = "00000000-0000-0000-0000-000000000001";
const MAIN_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const FIXTURE_ORG = "7397edff-7994-4731-8501-55d258d507d2";
const REAL_ASIN = "B0000B11UX";
const QA_FNSKU = "X006OFFM01";

type EnrichmentSource = {
  source_key: string;
  channel: "api" | "file_import" | "manual_ui";
  display_name: string;
  sp_api_or_report: string | null;
  target_spine_objects: string[];
  identifiers_provided: string[];
  attributes_provided: string[];
  creates_products: "never" | "governed_only" | "forbidden";
  mutates_map: "enrich_only" | "governed_upsert" | "no" | "review_queue";
  mutates_prices: "no" | "context_list_price_only";
  mutates_dimensions: "no" | "pc04_governed" | "catalog_evidence_only";
  confidence: "high" | "medium" | "low";
  phase: number;
  blocker: string | null;
  claim_lifecycle_story_use: string;
};

const API_ENRICHMENT_SOURCES: EnrichmentSource[] = [
  {
    source_key: "catalog_items_api",
    channel: "api",
    display_name: "Catalog Items API",
    sp_api_or_report: "GET /catalog/2022-04-01/items/{asin}",
    target_spine_objects: ["products (evidence)", "catalog_products adjunct", "enrichment queue"],
    identifiers_provided: ["ASIN"],
    attributes_provided: ["itemName", "brand", "images", "productTypes", "salesRanks", "attributes (UPC/EAN/GTIN when present)", "dimensions/weight when in attributes"],
    creates_products: "forbidden",
    mutates_map: "no",
    mutates_prices: "context_list_price_only",
    mutates_dimensions: "catalog_evidence_only",
    confidence: "medium",
    phase: 3,
    blocker: "PC02 gates; AMAZON_SP_API_ENABLED; evidence-only default",
    claim_lifecycle_story_use: "Product Story attributes after ASIN linkage; fee/dim claim evidence — not COGS",
  },
  {
    source_key: "listings_items_api",
    channel: "api",
    display_name: "Listings Items API",
    sp_api_or_report: "GET /listings/2021-08-01/items/{sellerSku}",
    target_spine_objects: ["amazon_listing_report_rows_raw", "product_identifier_map (future)"],
    identifiers_provided: ["seller SKU", "ASIN", "FNSKU when FBA"],
    attributes_provided: ["listing status", "offer price", "fulfillment"],
    creates_products: "forbidden",
    mutates_map: "enrich_only",
    mutates_prices: "context_list_price_only",
    mutates_dimensions: "no",
    confidence: "low",
    phase: 4,
    blocker: "No worker in repo — use Open/Manage FBA file imports first",
    claim_lifecycle_story_use: "Listing status + offer context for Product Story",
  },
  {
    source_key: "manage_fba_inventory",
    channel: "api",
    display_name: "Manage FBA Inventory (Reports API / file)",
    sp_api_or_report: "GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA",
    target_spine_objects: ["amazon_manage_fba_inventory", "product_identifier_map via ledger-style bridge (future)"],
    identifiers_provided: ["FNSKU", "MSKU", "ASIN"],
    attributes_provided: ["AFN quantities", "inbound flow columns"],
    creates_products: "never",
    mutates_map: "enrich_only",
    mutates_prices: "no",
    mutates_dimensions: "no",
    confidence: "high",
    phase: 2,
    blocker: "Reports API worker not wired; file import live",
    claim_lifecycle_story_use: "lifecycle available_fba / reserved; linkage FNSKU↔SKU↔ASIN",
  },
  {
    source_key: "open_listings",
    channel: "file_import",
    display_name: "Open Listings / All Listings report",
    sp_api_or_report: "GET_FLAT_FILE_OPEN_LISTINGS_DATA (planned API)",
    target_spine_objects: ["amazon_listing_report_rows_raw", "catalog_products (Phase 4 generic)"],
    identifiers_provided: ["seller-sku", "product-id/ASIN"],
    attributes_provided: ["price", "quantity"],
    creates_products: "governed_only",
    mutates_map: "governed_upsert",
    mutates_prices: "context_list_price_only",
    mutates_dimensions: "no",
    confidence: "medium",
    phase: 2,
    blocker: "Open Listings Lite lacks UPC — Product Identity CSV still needed",
    claim_lifecycle_story_use: "catalog spine + list price context",
  },
  {
    source_key: "fee_preview",
    channel: "file_import",
    display_name: "Fee Preview report",
    sp_api_or_report: "GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA",
    target_spine_objects: ["amazon_fee_preview"],
    identifiers_provided: ["SKU", "FNSKU", "ASIN"],
    attributes_provided: ["estimated fees", "product dimensions/weight for fee calc"],
    creates_products: "never",
    mutates_map: "enrich_only",
    mutates_prices: "no",
    mutates_dimensions: "catalog_evidence_only",
    confidence: "medium",
    phase: 3,
    blocker: "Staging empty; compare to PC04 internal dims in review queue",
    claim_lifecycle_story_use: "fee_or_dimension_issue lifecycle; fee claim evidence",
  },
  {
    source_key: "inventory_ledger",
    channel: "file_import",
    display_name: "Inventory Ledger Detail",
    sp_api_or_report: "GET_LEDGER_DETAIL_VIEW_DATA (planned API)",
    target_spine_objects: ["amazon_inventory_ledger", "product_identifier_map (Phase 4 enrich)"],
    identifiers_provided: ["FNSKU", "MSKU", "ASIN", "reference-id"],
    attributes_provided: ["event-type", "quantity", "disposition"],
    creates_products: "never",
    mutates_map: "enrich_only",
    mutates_prices: "no",
    mutates_dimensions: "no",
    confidence: "high",
    phase: 1,
    blocker: "Require Detail View export; enrichIdentifierMapFromInventoryLedgerUpload live",
    claim_lifecycle_story_use: "TRID reference edges; lost/damaged/disposed lifecycle",
  },
  {
    source_key: "product_identity_csv",
    channel: "file_import",
    display_name: "Product Identity CSV",
    sp_api_or_report: null,
    target_spine_objects: ["product_identifier_map", "products (governed)"],
    identifiers_provided: ["UPC", "Vendor", "Seller SKU", "Mfg #", "FNSKU", "ASIN"],
    attributes_provided: ["Product Name"],
    creates_products: "governed_only",
    mutates_map: "governed_upsert",
    mutates_prices: "no",
    mutates_dimensions: "no",
    confidence: "high",
    phase: 1,
    blocker: "Maysam must supply CSV — highest priority manual/file spine",
    claim_lifecycle_story_use: "UPC spine — prerequisite for scanner UPC path and Product Story",
  },
  {
    source_key: "sellersnap_cogs",
    channel: "file_import",
    display_name: "SellerSnap COGS export",
    sp_api_or_report: null,
    target_spine_objects: ["future product_unit_costs or approved cost spine"],
    identifiers_provided: ["SKU", "ASIN"],
    attributes_provided: ["unit_cost", "effective_date"],
    creates_products: "never",
    mutates_map: "no",
    mutates_prices: "no",
    mutates_dimensions: "no",
    confidence: "high",
    phase: 1,
    blocker: "Dedicated importer not built; product_prices is NOT COGS",
    claim_lifecycle_story_use: "claim money / ORBIT recovery_value — blocked until wired",
  },
  {
    source_key: "manual_upc_correction",
    channel: "manual_ui",
    display_name: "UPC/EAN correction UI",
    sp_api_or_report: null,
    target_spine_objects: ["product_identifier_map", "products.upc_code"],
    identifiers_provided: ["UPC", "EAN", "GTIN"],
    attributes_provided: [],
    creates_products: "never",
    mutates_map: "review_queue",
    mutates_prices: "no",
    mutates_dimensions: "no",
    confidence: "high",
    phase: 2,
    blocker: "Conflict review UI partial — extend Claim Center / PIM review queue",
    claim_lifecycle_story_use: "scanner barcode-first resolution",
  },
  {
    source_key: "manual_dimensions",
    channel: "manual_ui",
    display_name: "Internal measured dimensions/weight",
    sp_api_or_report: null,
    target_spine_objects: ["dimensions_current (PC04)"],
    identifiers_provided: ["product_id"],
    attributes_provided: ["length", "width", "height", "weight"],
    creates_products: "never",
    mutates_map: "no",
    mutates_prices: "no",
    mutates_dimensions: "pc04_governed",
    confidence: "high",
    phase: 2,
    blocker: "571 PC04 rows on staging; operator measure events",
    claim_lifecycle_story_use: "fee/dimension overcharge claims vs Amazon charged dims",
  },
  {
    source_key: "manual_case_pack",
    channel: "manual_ui",
    display_name: "Case pack / units per case",
    sp_api_or_report: null,
    target_spine_objects: ["products metadata or packaging contract"],
    identifiers_provided: ["product_id"],
    attributes_provided: ["units_per_case"],
    creates_products: "never",
    mutates_map: "no",
    mutates_prices: "no",
    mutates_dimensions: "no",
    confidence: "medium",
    phase: 3,
    blocker: "Schema TBD — financial spine approval pending",
    claim_lifecycle_story_use: "ORBIT unit normalization",
  },
  {
    source_key: "purchase_landed_cost",
    channel: "manual_ui",
    display_name: "Purchase cost / landed cost",
    sp_api_or_report: null,
    target_spine_objects: ["future cost spine"],
    identifiers_provided: ["SKU", "product_id"],
    attributes_provided: ["unit_cost", "landed_cost"],
    creates_products: "never",
    mutates_map: "no",
    mutates_prices: "no",
    mutates_dimensions: "no",
    confidence: "medium",
    phase: 2,
    blocker: "Same as SellerSnap — no authoritative cost table yet",
    claim_lifecycle_story_use: "recovery_value on all claim families",
  },
];

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function connectPg(): Promise<pg.Client> {
  loadEnvLocalIntoProcess();
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url?.includes(STAGING_REF)) throw new Error("STAGING_DIRECT_POSTGRES_URL must target staging");
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '120s'");
  await c.query("SET default_transaction_read_only = ON");
  return c;
}

async function spineCensus(c: pg.Client, orgId: string, storeId: string | null) {
  const scopeStore = storeId
    ? `organization_id = $1::uuid AND store_id = $2::uuid`
    : `organization_id = $1::uuid`;
  const params = storeId ? [orgId, storeId] : [orgId];

  async function count(table: string, extra = ""): Promise<number> {
    const q = `SELECT COUNT(*)::bigint AS c FROM public.${table} WHERE ${scopeStore}${extra}`;
    const r = await c.query(q, params);
    return Number(r.rows[0]?.c ?? 0);
  }

  const products = await count("products", " AND deleted_at IS NULL");
  const mapRows = await count("product_identifier_map", " AND deleted_at IS NULL");
  const mapWithUpc = await c.query(
    `SELECT COUNT(*)::bigint AS c FROM public.product_identifier_map
     WHERE ${scopeStore} AND deleted_at IS NULL AND NULLIF(TRIM(upc_code), '') IS NOT NULL`,
    params,
  );
  const mapWithFnsku = await c.query(
    `SELECT COUNT(*)::bigint AS c FROM public.product_identifier_map
     WHERE ${scopeStore} AND deleted_at IS NULL AND NULLIF(TRIM(fnsku), '') IS NOT NULL`,
    params,
  );

  let catalogProducts = 0;
  try {
    catalogProducts = await count("catalog_products");
  } catch {
    catalogProducts = -1;
  }

  let productPrices = 0;
  try {
    productPrices = await count("product_prices");
  } catch {
    productPrices = -1;
  }

  let dimensions = 0;
  try {
    const dr = await c.query(
      `SELECT COUNT(*)::bigint AS c FROM public.dimensions_current dc
       INNER JOIN public.products p ON p.id = dc.product_id
       WHERE p.organization_id = $1::uuid${storeId ? " AND p.store_id = $2::uuid" : ""}`,
      params,
    );
    dimensions = Number(dr.rows[0]?.c ?? 0);
  } catch {
    dimensions = -1;
  }

  return {
    products,
    product_identifier_map: mapRows,
    map_with_upc: Number(mapWithUpc.rows[0]?.c ?? 0),
    map_with_fnsku: Number(mapWithFnsku.rows[0]?.c ?? 0),
    catalog_products: catalogProducts,
    product_prices: productPrices,
    dimensions_current: dimensions,
  };
}

async function identifierTrace(
  c: pg.Client,
  orgId: string,
  opts: { fnsku?: string; asin?: string },
) {
  const fnsku = opts.fnsku?.trim().toUpperCase();
  const asin = opts.asin?.trim().toUpperCase();
  const map = await c.query(
    `SELECT id, product_id, store_id, fnsku, asin, seller_sku, upc_code, match_source
     FROM public.product_identifier_map
     WHERE organization_id = $1::uuid AND deleted_at IS NULL
       AND ($2::text IS NULL OR UPPER(TRIM(fnsku)) = $2 OR UPPER(TRIM(asin)) = $3)
     LIMIT 20`,
    [orgId, fnsku ?? null, asin ?? null],
  );
  const products = await c.query(
    `SELECT id, sku, asin, fnsku, upc_code, product_name
     FROM public.products
     WHERE organization_id = $1::uuid AND deleted_at IS NULL
       AND ($2::text IS NULL OR UPPER(TRIM(fnsku)) = $2 OR UPPER(TRIM(asin)) = $3)
     LIMIT 10`,
    [orgId, fnsku ?? null, asin ?? null],
  );
  return { map_rows: map.rows, product_rows: products.rows };
}

function renderMarkdown(payload: Record<string, unknown>): string {
  let md = `# PHASE-PRODUCT-LINKAGE-API-ENRICHMENT-ROADMAP-V1\n\nRun: \`${payload.run_id}\`\n\n`;
  md += `## first_safe_phase: **${payload.first_safe_phase}**\n\n`;
  md += `## SAFE_TO_IMPLEMENT_PRODUCT_LINKAGE_ENRICHMENT_READMODEL: **${payload.SAFE_TO_IMPLEMENT_PRODUCT_LINKAGE_ENRICHMENT_READMODEL}**\n\n`;
  const status = payload.current_product_linkage_status as Record<string, unknown>;
  md += `### Main org spine\n\n\`\`\`json\n${JSON.stringify(status.main_org_spine, null, 2)}\n\`\`\`\n\n`;
  md += `## NEXT_EXACT_PROMPT\n\n\`${payload.NEXT_EXACT_PROMPT}\`\n`;
  return md;
}

async function main(): Promise<void> {
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const c = await connectPg();

  const mainSpine = await spineCensus(c, MAIN_ORG, MAIN_STORE);
  const mainSpineOrgWide = await spineCensus(c, MAIN_ORG, null);
  const fixtureSpine = await spineCensus(c, FIXTURE_ORG, null);

  const realTarget = await identifierTrace(c, MAIN_ORG, { asin: REAL_ASIN, fnsku: REAL_ASIN });
  const qaFnskuMain = await identifierTrace(c, MAIN_ORG, { fnsku: QA_FNSKU });
  const qaFnskuFixture = await identifierTrace(c, FIXTURE_ORG, { fnsku: QA_FNSKU });
  const qaFnskuGlobal = await c.query(
    `SELECT organization_id::text, COUNT(*)::int AS n
     FROM public.product_identifier_map
     WHERE deleted_at IS NULL AND UPPER(TRIM(fnsku)) = $1
     GROUP BY 1`,
    [QA_FNSKU],
  );

  const unresolvedEp = await c.query(
    `SELECT COUNT(*)::bigint AS c FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND resolved_product_id IS NULL`,
    [MAIN_ORG, MAIN_STORE],
  );
  const totalEp = await c.query(
    `SELECT COUNT(*)::bigint AS c FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid`,
    [MAIN_ORG, MAIN_STORE],
  );

  await c.end();

  let linkageHealthMain: Awaited<ReturnType<typeof fetchLinkageHealthSnapshot>> | null = null;
  try {
    loadEnvLocalIntoProcess();
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (url && key && refFromSupabaseUrl(url) === STAGING_REF) {
      const sb = createClient(url, key, { auth: { persistSession: false } });
      linkageHealthMain = await fetchLinkageHealthSnapshot(sb, MAIN_ORG);
    }
  } catch {
    linkageHealthMain = null;
  }

  const api_enrichment_sources = API_ENRICHMENT_SOURCES.filter((s) => s.channel === "api");
  const file_import_enrichment_sources = API_ENRICHMENT_SOURCES.filter(
    (s) => s.channel === "file_import",
  );
  const manual_user_input_sources = API_ENRICHMENT_SOURCES.filter((s) => s.channel === "manual_ui");

  const product_identifier_priority_rules = {
    scanner_context: {
      order: RESOLUTION_ORDER_SCANNER,
      formatted: formatResolutionOrderExport("scanner"),
      notes: "Barcode/UPC-first for return_items and slip scan",
    },
    operational_import_context: {
      order: RESOLUTION_ORDER_OPERATIONAL,
      formatted: formatResolutionOrderExport("operational_import"),
      notes: "FNSKU-first per governance V192; ASIN+SKU pair beats ASIN-only",
    },
    matcher_tiers: [
      "Tier 1: FNSKU exact (product_identifier_map + products)",
      "Tier 2: ASIN exact",
      "Tier 3: seller_sku / msku",
      "Tier 4: upc_code / UPC-EAN-GTIN barcode variants",
      "Sub-rank: ASIN+SKU pair > ASIN-only > SKU-only",
    ],
    scope: "organization_id + store_id required for map prefetch",
    forbidden: [
      "title-only matching",
      "OCR/title auto-create",
      "scanner auto-create without approved path",
      "raw report title as product create key",
      "cross-org seeding (X006OFFM01 must not appear in main org map)",
      "browser products.insert",
    ],
  };

  const product_creation_rules = {
    allowed_paths: [
      "PRODUCT_IDENTITY CSV governed import (product-identity-import.ts)",
      "Approved listing catalog Phase 4 generic (catalog_products) with operator approval",
      "Governed spreadsheet wave with explicit approval — not from Amazon API fetch",
    ],
    forbidden_paths: [
      "Amazon Reports API removal fetch/sync/rebuild",
      "Scanner OCR / title inference",
      "Catalog Items API auto-create (PC02 evidence-only)",
      "UniversalImporter auto-create from report product-name column",
      "Cross-org fixture seed for QA FNSKU",
    ],
    persist_rule: "resolved_product_id only when exactly one deterministic winner",
    display_contract: "ProductLinkageDisplayContract on all read/write surfaces",
  };

  const conflict_review_rules = {
    ambiguous_status: "identifier_resolution_status = ambiguous → no resolved_product_id persist",
    mismatch_status: "catalog FK mismatch vs map → review; confidence capped 0.35",
    duplicate_map_groups: "same fnsku/asin/upc/sku → 2+ product_ids → conflict review queue",
    safe_for_auto_map: "fnsku_conflict_groups = 0 AND asin_conflict_groups = 0",
    review_surfaces: [
      "PIM AmbiguousProductPicker",
      "Claim Center product-linkage route",
      "Future: linkage enrichment review queue (Phase 2)",
    ],
    no_auto_create_on_conflict: true,
  };

  const epTotal = Number(totalEp.rows[0]?.c ?? 0);
  const epUnresolved = Number(unresolvedEp.rows[0]?.c ?? 0);
  const epLinkagePct = epTotal === 0 ? 100 : Math.round(((epTotal - epUnresolved) / epTotal) * 1000) / 10;

  const product_linkage_health_metrics = {
    coverage: {
      expected_packages_linkage_percent: epLinkagePct,
      expected_packages_unresolved: epUnresolved,
      expected_packages_total: epTotal,
      operational_linkage: linkageHealthMain?.linkage_health ?? null,
    },
    unresolved_identifiers: {
      expected_packages: epUnresolved,
      operational_unresolved_total: linkageHealthMain?.unresolved_count ?? null,
    },
    conflicting_identifiers: linkageHealthMain?.duplicate_risks ?? null,
    stale_product_info: "No automated stale catalog TTL — use last_seen_at on map + import freshness badges (planned)",
    missing_upc: {
      map_rows_without_upc:
        mainSpine.product_identifier_map - mainSpine.map_with_upc,
      map_upc_coverage_percent:
        mainSpine.product_identifier_map === 0
          ? 0
          : Math.round((mainSpine.map_with_upc / mainSpine.product_identifier_map) * 1000) / 10,
    },
    missing_cost: {
      status: "unavailable",
      note: "SellerSnap COGS importer not wired; product_prices is sale/list context only",
    },
    missing_dimensions: {
      products_with_pc04: mainSpine.dimensions_current,
      products_without_pc04: Math.max(0, mainSpine.products - Math.max(0, mainSpine.dimensions_current)),
    },
    missing_price: {
      product_prices_rows: mainSpine.product_prices,
      note: "List/sale context — not COGS; Catalog API list price is enrichment only",
    },
    safe_for_product_story: linkageHealthMain?.linkage_health.safe_for_product_story ?? "unknown",
  };

  const implementation_phases = [
    {
      phase: 1,
      name: "Spine completion (file-first, no Catalog API writes)",
      actions: [
        "Product Identity CSV import for main org store",
        "Inventory Ledger Detail import + Phase 4 map enrich (existing path)",
        "SellerSnap COGS external_export importer design approval",
        "Extend linkage-health read-model with UPC/cost/dimensions metrics (read-only)",
      ],
      sources: ["product_identity_csv", "inventory_ledger", "sellersnap_cogs"],
    },
    {
      phase: 2,
      name: "Operational identifier enrichment + review queue",
      actions: [
        "Manage FBA + Open Listings scheduled file/API sync → map enrich",
        "Manual UPC correction + conflict review UI in Claim Center",
        "PC04 dimension capture for fee-claim cohort",
        "Purchase/landed cost manual entry (post schema approval)",
      ],
      sources: ["manage_fba_inventory", "open_listings", "manual_upc_correction", "manual_dimensions"],
    },
    {
      phase: 3,
      name: "Governed Catalog API enrichment (evidence-only → map enrich)",
      actions: [
        "PC02 approval + batch Catalog Items fetch for unresolved ASINs",
        "Fee Preview import for dimension/fee evidence",
        "Case pack metadata contract",
        "Never auto-create products from catalog response",
      ],
      sources: ["catalog_items_api", "fee_preview", "manual_case_pack"],
    },
    {
      phase: 4,
      name: "Listings API + listings bulk automation",
      actions: ["Listings Items API evaluation", "Open Listings Reports API worker"],
      sources: ["listings_items_api"],
    },
  ];

  const first_safe_phase = 1;

  const SAFE_TO_IMPLEMENT_PRODUCT_LINKAGE_ENRICHMENT_READMODEL =
    linkageHealthMain != null ? "yes" : "partial";

  const NEXT_EXACT_PROMPT =
    "PHASE-PRODUCT-LINKAGE-ENRICHMENT-READMODEL-EXTEND-V1 — extend linkage-health API with missing_upc/missing_cost/missing_dimensions/missing_price metrics + main-org dashboard; then PHASE-PRODUCT-IDENTITY-CSV-IMPORT-EXECUTE-V1 for Maysam";

  const current_product_linkage_status = {
    main_org: MAIN_ORG,
    main_store: MAIN_STORE,
    fixture_org: FIXTURE_ORG,
    main_org_spine: mainSpine,
    main_org_spine_org_wide: mainSpineOrgWide,
    fixture_org_spine: fixtureSpine,
    fixture_has_product_spine: fixtureSpine.products > 0,
    real_target_B0000B11UX: {
      asin: REAL_ASIN,
      main_org_trace: realTarget,
      resolves_deterministically: realTarget.map_rows.length > 0 || realTarget.product_rows.length > 0,
      note: "Real off-manifest smoke target — ASIN+MSKU present in main org PIM",
    },
    qa_fnsku_X006OFFM01: {
      fnsku: QA_FNSKU,
      main_org_hits: qaFnskuMain.map_rows.length + qaFnskuMain.product_rows.length,
      fixture_org_hits: qaFnskuFixture.map_rows.length + qaFnskuFixture.product_rows.length,
      global_map_by_org: qaFnskuGlobal.rows,
      cross_org_seed_forbidden: true,
      note: "QA fixture — must NOT be seeded into main org; negative control for physical return MVP",
    },
    product_prices_authority: "sale/listing context ONLY — not COGS",
    cost_status: "unknown until SellerSnap/purchase cost spine wired",
    linkage_health_snapshot: linkageHealthMain,
  };

  const current_product_spine_inventory = {
    products: {
      table: "products",
      role: "Canonical product row; products.id is first comparison key",
      key_columns: ["id", "organization_id", "store_id", "sku", "asin", "fnsku", "upc_code", "product_name"],
    },
    catalog_products: {
      table: "catalog_products",
      role: "Listing/catalog adjunct from listing imports Phase 4",
      note: "Not primary resolver key — resolved_product_id targets products",
    },
    product_identifier_map: {
      table: "product_identifier_map",
      role: "ASIN/FNSKU/SKU/UPC bridge; ledger + Product Identity enrich",
      key_columns: ["product_id", "fnsku", "asin", "seller_sku", "msku", "upc_code", "confidence_score", "match_source"],
    },
    product_prices: {
      table: "product_prices",
      role: "List/sale price context — NOT unit COGS",
      forbidden_use: "recovery_value / ORBIT COGS",
    },
    dimensions_current: {
      table: "dimensions_current",
      role: "PC04 packaging dimensions — governed waves + spreadsheet activate",
      staging_count: mainSpine.dimensions_current,
    },
    amazon_raw_payloads: {
      tables: [
        "amazon_listing_report_rows_raw",
        "amazon_manage_fba_inventory",
        "amazon_fee_preview",
        "amazon_inventory_ledger",
        "raw_report_uploads",
      ],
      role: "Source evidence — normalized before resolver; map enrich from ledger/listing paths",
    },
  };

  const summary = {
    prompt: "PHASE-PRODUCT-LINKAGE-API-ENRICHMENT-ROADMAP-V1",
    run_id: rid,
    mode: "read_only",
    staging_ref: STAGING_REF,
    blocker_summary:
      "Product linkage blocks claim money, Product Story, TRID edges, lifecycle qty, physical return MVP, ORBIT/FRA",
    current_product_linkage_status,
    current_product_spine_inventory,
    api_enrichment_sources,
    file_import_enrichment_sources,
    manual_user_input_sources,
    product_identifier_priority_rules,
    product_creation_rules,
    conflict_review_rules,
    product_linkage_health_metrics,
    implementation_phases,
    first_safe_phase,
    existing_readmodel: {
      module: "lib/product-linkage-health.ts",
      api_route: "GET /api/dashboard/products/linkage-health",
      resolution_policy: "lib/product-linkage-resolution-policy.ts",
      matcher: "lib/product-identifier-match.ts",
      display_contract: "lib/product-linkage-display-contract.ts",
    },
    cross_refs: [
      "phase-amazon-spapi-reports-api-first-sync-roadmap-v1/20260613T003921Z",
      "phase-amazon-sample-zip-source-coverage-audit-v1/20260613T003412Z",
    ],
    SAFE_TO_IMPLEMENT_PRODUCT_LINKAGE_ENRICHMENT_READMODEL,
    NEXT_EXACT_PROMPT,
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outDir, "linkage-enrichment-roadmap.md"), renderMarkdown(summary), "utf8");
  fs.writeFileSync(path.join(outDir, "NEXT_EXACT_PROMPT.txt"), NEXT_EXACT_PROMPT);

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
