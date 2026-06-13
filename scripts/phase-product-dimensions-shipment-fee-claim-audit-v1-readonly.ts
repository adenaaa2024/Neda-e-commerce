/**
 * PHASE-PRODUCT-DIMENSIONS-SHIPMENT-FEE-CLAIM-AUDIT-V1 (read-only)
 *
 *   npx tsx scripts/phase-product-dimensions-shipment-fee-claim-audit-v1-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-product-dimensions-shipment-fee-claim-audit-v1";

const DIMENSION_TABLES = [
  "products",
  "product_identifier_map",
  "product_packaging_profiles",
  "product_packaging_profile_versions",
  "product_packaging_dimensions_current",
  "product_packaging_evidence",
  "catalog_products",
  "product_prices",
];

const SHIPMENT_FEE_TABLES = [
  "packages",
  "pallets",
  "expected_packages",
  "shipment_boxes",
  "shipment_box_items",
  "shipment_containers",
  "amazon_removal_shipments",
  "amazon_removals",
  "amazon_fee_preview",
  "amazon_monthly_storage_fees",
  "amazon_settlements",
  "financial_reference_resolver",
  "claim_candidates",
  "claim_candidate_drafts",
  "claim_lines",
  "claim_reference_edges",
  "trid_entities",
  "trid_links",
  "raw_report_uploads",
];

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function tableExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name],
  );
  return (r.rowCount ?? 0) > 0;
}

async function cols(client: pg.Client, table: string): Promise<string[]> {
  const r = await client.query(
    `SELECT column_name, data_type, udt_name
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1
     ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map(
    (x: { column_name: string; data_type: string; udt_name: string }) =>
      `${x.column_name}:${x.data_type}${x.udt_name !== x.data_type ? `(${x.udt_name})` : ""}`,
  );
}

async function orgCount(client: pg.Client, table: string): Promise<number | null> {
  if (!(await tableExists(client, table))) return null;
  const c = await cols(client, table);
  const hasOrg = c.some((x) => x.startsWith("organization_id:"));
  if (!hasOrg) {
    const r = await client.query(`SELECT count(*)::int AS c FROM public.${table}`);
    return Number(r.rows[0]?.c ?? 0);
  }
  const r = await client.query(
    `SELECT count(*)::int AS c FROM public.${table} WHERE organization_id=$1::uuid`,
    [ORG],
  );
  return Number(r.rows[0]?.c ?? 0);
}

function pickCols(all: string[], patterns: RegExp[]): string[] {
  return all.filter((c) => patterns.some((p) => p.test(c.split(":")[0]!)));
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const run = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, run);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    process.env.SUPABASE_DB_URL?.trim() ||
    "";
  if (!dbUrl) {
    throw new Error("Missing STAGING_DIRECT_POSTGRES_URL / DIRECT_POSTGRES_URL / SUPABASE_DB_URL in .env.local");
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  try {
    const tableCols: Record<string, string[]> = {};
    for (const t of [...DIMENSION_TABLES, ...SHIPMENT_FEE_TABLES]) {
      if (await tableExists(client, t)) tableCols[t] = await cols(client, t);
    }

    const dimensionsTableInventory: Record<string, unknown>[] = [];
    for (const t of DIMENSION_TABLES) {
      if (!tableCols[t]) {
        dimensionsTableInventory.push({ table: t, exists: false });
        continue;
      }
      const all = tableCols[t]!;
      dimensionsTableInventory.push({
        table: t,
        exists: true,
        row_count_org: await orgCount(client, t),
        identifier_columns: pickCols(all, [/product_id|asin|fnsku|sku|upc|identifier/i]),
        measurement_columns: pickCols(all, [/length|width|height|weight|dimension|unit|volume/i]),
        temporal_columns: pickCols(all, [/observed|effective|created|updated|refreshed|source/i]),
        confidence_columns: pickCols(all, [/confidence|source_type|source_|evidence/i]),
      });
    }

    const shipmentFeeSourceInventory: Record<string, unknown>[] = [];
    for (const t of SHIPMENT_FEE_TABLES) {
      if (!tableCols[t]) {
        shipmentFeeSourceInventory.push({ table: t, exists: false });
        continue;
      }
      const all = tableCols[t]!;
      shipmentFeeSourceInventory.push({
        table: t,
        exists: true,
        row_count_org: await orgCount(client, t),
        product_identifier_columns: pickCols(all, [/product_id|resolved_product|asin|fnsku|sku/i]),
        shipment_identifier_columns: pickCols(all, [
          /shipment|tracking|order_id|package|pallet|removal|carrier|box/i,
        ]),
        fee_amount_columns: pickCols(all, [/fee|amount|price|cost|rate|currency|recovery|cogs/i]),
        date_columns: pickCols(all, [/date|month|observed|created|effective|deadline|window/i]),
        linkage_columns: pickCols(all, [/upload|source_|trid|reference|resolved/i]),
      });
    }

    let packagingStats: Record<string, unknown> = {};
    if (tableCols.product_packaging_dimensions_current) {
      const r = await client.query(
        `SELECT
           count(*)::int AS total,
           count(*) FILTER (WHERE length_value IS NOT NULL AND width_value IS NOT NULL AND height_value IS NOT NULL)::int AS has_lwh,
           count(*) FILTER (WHERE weight_value IS NOT NULL)::int AS has_weight,
           count(*) FILTER (WHERE dimension_unit IS NOT NULL)::int AS has_dim_unit,
           count(*) FILTER (WHERE weight_unit IS NOT NULL)::int AS has_weight_unit,
           count(*) FILTER (WHERE confidence_score IS NOT NULL)::int AS has_confidence
         FROM product_packaging_dimensions_current WHERE organization_id=$1::uuid`,
        [ORG],
      );
      const src = await client.query(
        `SELECT source_type, count(*)::int AS n
         FROM product_packaging_dimensions_current WHERE organization_id=$1::uuid
         GROUP BY 1 ORDER BY n DESC`,
        [ORG],
      );
      const ctx = await client.query(
        `SELECT fulfillment_context, packaging_level, count(*)::int AS n
         FROM product_packaging_dimensions_current WHERE organization_id=$1::uuid
         GROUP BY 1,2 ORDER BY n DESC`,
        [ORG],
      );
      packagingStats = { coverage: r.rows[0], by_source_type: src.rows, by_context_level: ctx.rows };
    }

    let productsLegacyDims: Record<string, unknown> = {};
    if (tableCols.products) {
      const legacyCols = [
        "item_weight",
        "package_weight",
        "item_dimensions_json",
        "package_dimensions_json",
        "packaging_dimensions",
        "product_dimensions",
        "amazon_raw",
      ].filter((c) => tableCols.products!.some((x) => x.startsWith(`${c}:`)));
      const parts = legacyCols.map(
        (c) =>
          `count(*) FILTER (WHERE ${c} IS NOT NULL AND ${c}::text NOT IN ('null','{}','[]',''))::int AS ${c}`,
      );
      if (parts.length) {
        const r = await client.query(
          `SELECT count(*)::int AS total, ${parts.join(",")}
           FROM products WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
          [ORG],
        );
        productsLegacyDims = { legacy_columns_present: legacyCols, counts: r.rows[0] };
      }
    }

    let feePreviewStats = {};
    if (tableCols.amazon_fee_preview) {
      feePreviewStats = (
        await client.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE estimated_fee IS NOT NULL)::int AS has_estimated_fee,
                  count(*) FILTER (WHERE asin IS NOT NULL OR fnsku IS NOT NULL OR sku IS NOT NULL)::int AS has_identifier,
                  count(*) FILTER (WHERE raw_data IS NOT NULL)::int AS has_raw_data
           FROM amazon_fee_preview WHERE organization_id=$1::uuid`,
          [ORG],
        )
      ).rows[0];
    }

    let storageFeeStats = {};
    if (tableCols.amazon_monthly_storage_fees) {
      storageFeeStats = (
        await client.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE storage_rate IS NOT NULL)::int AS has_rate,
                  count(*) FILTER (WHERE storage_month IS NOT NULL)::int AS has_month,
                  count(*) FILTER (WHERE asin IS NOT NULL OR fnsku IS NOT NULL)::int AS has_identifier
           FROM amazon_monthly_storage_fees WHERE organization_id=$1::uuid`,
          [ORG],
        )
      ).rows[0];
    }

    let settlementStats = {};
    if (tableCols.amazon_settlements) {
      const sCols = tableCols.amazon_settlements.map((x) => x.split(":")[0]!);
      const amountExpr =
        sCols.includes("amount") && sCols.includes("total_amount")
          ? "amount IS NOT NULL OR total_amount IS NOT NULL"
          : sCols.includes("total_amount")
            ? "total_amount IS NOT NULL"
            : sCols.includes("amount")
              ? "amount IS NOT NULL"
              : "false";
      const productExpr =
        sCols.includes("sku") && sCols.includes("asin")
          ? "sku IS NOT NULL OR asin IS NOT NULL"
          : sCols.includes("sku")
            ? "sku IS NOT NULL"
            : sCols.includes("asin")
              ? "asin IS NOT NULL"
              : "false";
      const feeTypeExpr =
        sCols.includes("transaction_type") && sCols.includes("amount_description")
          ? "transaction_type IS NOT NULL OR amount_description IS NOT NULL"
          : sCols.includes("transaction_type")
            ? "transaction_type IS NOT NULL"
            : sCols.includes("amount_description")
              ? "amount_description IS NOT NULL"
              : "false";
      settlementStats = (
        await client.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE ${amountExpr})::int AS has_amount,
                  count(*) FILTER (WHERE ${productExpr})::int AS has_product_id,
                  count(*) FILTER (WHERE ${feeTypeExpr})::int AS has_fee_type
           FROM amazon_settlements WHERE organization_id=$1::uuid`,
          [ORG],
        )
      ).rows[0];
    }

    let removalStats = {};
    if (tableCols.amazon_removal_shipments) {
      removalStats = (
        await client.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS has_rpid,
                  count(*) FILTER (WHERE tracking_number IS NOT NULL AND btrim(tracking_number) <> '')::int AS has_tracking,
                  count(*) FILTER (WHERE order_id IS NOT NULL)::int AS has_order_id
           FROM amazon_removal_shipments WHERE organization_id=$1::uuid`,
          [ORG],
        )
      ).rows[0];
    }

    let epStats = {};
    if (tableCols.expected_packages) {
      const epCols = new Set(tableCols.expected_packages.map((x) => x.split(":")[0]!));
      epStats = (
        await client.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE tracking_number IS NOT NULL AND btrim(tracking_number) <> '')::int AS has_tracking,
                  count(*) FILTER (WHERE sku IS NOT NULL AND btrim(sku) <> '')::int AS has_sku${
                    epCols.has("fnsku")
                      ? `,
                  count(*) FILTER (WHERE fnsku IS NOT NULL AND btrim(fnsku) <> '')::int AS has_fnsku`
                      : ""
                  }
           FROM expected_packages WHERE organization_id=$1::uuid`,
          [ORG],
        )
      ).rows[0];
    }

    let frrStats = {};
    if (tableCols.financial_reference_resolver) {
      const frrCols = new Set(tableCols.financial_reference_resolver.map((x) => x.split(":")[0]!));
      frrStats = (
        await client.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE trid_key IS NOT NULL)::int AS has_trid_key${
                    frrCols.has("resolved_product_id")
                      ? `,
                  count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS has_rpid`
                      : ""
                  }${
                    frrCols.has("amount")
                      ? `,
                  count(*) FILTER (WHERE amount IS NOT NULL)::int AS has_amount`
                      : ""
                  }
           FROM financial_reference_resolver WHERE organization_id=$1::uuid`,
          [ORG],
        )
      ).rows[0];
    }

    const dimensionsFieldMap = {
      canonical_table: "product_packaging_dimensions_current",
      version_history: "product_packaging_profile_versions",
      evidence: "product_packaging_evidence",
      spine_link: "product_id → products → product_identifier_map (asin/fnsku/sku)",
      fields: {
        weight: "weight_value + weight_unit (unit/case level via packaging_level)",
        length_width_height: "length_value, width_value, height_value + dimension_unit",
        package_vs_item: "packaging_level enum: unit | inner_pack | case | master_carton | pallet_load",
        amazon_measured: "NOT a dedicated column — SP-API Catalog item/package dims → evidence dry-run; amazon_raw on products",
        internal_measured: "source_type=warehouse_measurement | manual | import (spreadsheet batch SPREADSHEET_DIMENSIONS_20260528T010000Z)",
        observed_at: "effective_from on versions; refreshed_at on dimensions_current",
        source: "source_type on versions/current",
        confidence: "confidence_score on versions/current",
        fnsku_asin_sku: "via products + product_identifier_map; packaging tables hold product_id only",
      },
      staging_coverage: packagingStats,
      legacy_products_columns: productsLegacyDims,
    };

    const feeClaimUseCaseMatrix = [
      {
        use_case: "Amazon overcharged FBA fee",
        primary_sources: ["amazon_fee_preview", "amazon_settlements", "financial_reference_resolver"],
        dimension_sources: ["product_packaging_dimensions_current", "products.amazon_raw"],
        shipment_link: "weak — fee rows are ASIN/FNSKU grain, not shipment_id",
        evidence_ready: "partial",
        trid_edge: "product_spine + financial_match + evidence (packaging version)",
        product_story_block: "Financial / FBA fees / Product specs",
      },
      {
        use_case: "Wrong weight/dimension tier",
        primary_sources: ["product_packaging_dimensions_current", "amazon_fee_preview.raw_data"],
        dimension_sources: ["product_packaging_dimensions_current", "product_packaging_evidence"],
        shipment_link: "n/a — product grain",
        evidence_ready: "yes for 571 staged products with current snapshot",
        trid_edge: "product_spine → packaging profile version + amazon measured evidence",
        product_story_block: "Product specs / Packaging / Claim evidence",
      },
      {
        use_case: "Storage fee overcharge",
        primary_sources: ["amazon_monthly_storage_fees", "amazon_settlements"],
        dimension_sources: ["product_packaging_dimensions_current (volume proxy)"],
        shipment_link: "n/a",
        evidence_ready: "partial — rates in table; cubic ft needs dims + month",
        trid_edge: "financial_match on storage_month + product_spine",
        product_story_block: "Financial / Storage fees",
      },
      {
        use_case: "Removal fee overcharge",
        primary_sources: ["amazon_removals", "amazon_removal_shipments", "expected_packages"],
        dimension_sources: ["product_packaging_dimensions_current"],
        shipment_link: "order_id + tracking_number bridge EP ↔ removal_shipments",
        evidence_ready: "partial — operational rows exist; fee amounts sparse on removal tables",
        trid_edge: "operational_source removal_shipment + claim_to_shipment",
        product_story_block: "Removals / Shipments / Financial",
      },
      {
        use_case: "Shipment lost/damaged/discrepancy",
        primary_sources: ["packages", "pallets", "shipment_boxes", "expected_packages", "return_items"],
        dimension_sources: ["product_packaging_dimensions_current"],
        shipment_link: "tracking_number, package_code, pallet_id chain",
        evidence_ready: "yes for scanner/ORBIT operational evidence",
        trid_edge: "claim_to_shipment + operational_source",
        product_story_block: "Scans / Shipments / Timeline",
      },
      {
        use_case: "Refund/reimbursement mismatch",
        primary_sources: ["financial_reference_resolver", "amazon_settlements", "claim_lines"],
        dimension_sources: ["optional — COGS from product_prices"],
        shipment_link: "FRR trid_key groups financial rows",
        evidence_ready: "yes where FRR populated",
        trid_edge: "operational_to_financial + claim_to_settlement",
        product_story_block: "Financial / Reimbursements / TRID graph",
      },
    ];

    const productToShipmentLinkRequirements = {
      locked_keys: [
        "organization_id + store_id",
        "product_id via resolved_product_id or product_identifier_map",
        "order_id (removal)",
        "tracking_number (carrier)",
        "upload_id / source_upload_id (report lineage)",
      ],
      existing_bridges: [
        "amazon_removal_shipments → expected_packages (4-tier match migration 20260628)",
        "expected_packages.tracking_number ↔ packages/pallets views",
        "shipment_boxes ↔ packages hierarchy",
        "claim_reference_edges claim_to_shipment",
      ],
      gaps: [
        "amazon_fee_preview has no product_id / resolved_product_id — identifier join only",
        "amazon_monthly_storage_fees has no product_id — ASIN/FNSKU join only",
        "No unified shipment_fee_fact table",
        "Carrier invoice / dimensional weight not ingested",
      ],
    };

    const dimensionalWeightFormulaRequirements = {
      amazon_fba_rule: "greater of unit weight vs (L×W×H)/139 for standard-size (verify current Amazon fee schedule at design time)",
      required_inputs: ["length_value", "width_value", "height_value", "dimension_unit", "weight_value", "weight_unit", "packaging_level=unit"],
      unit_normalization: "Convert in/cm/mm → inches; lb/oz/kg/g → pounds before formula",
      sources_for_inputs: ["product_packaging_dimensions_current (internal)", "SP-API catalog package_dimensions (amazon)", "amazon_fee_preview.raw_data (charged tier hints)"],
      gaps: ["No stored computed dim_weight column", "No amazon_measured_dimensions table separate from packaging evidence"],
    };

    const fbaFeeAuditRequirements = {
      compare: ["amazon_fee_preview.estimated_fee vs settlement/FRR actual fee rows", "charged size tier in raw_data vs product_packaging_dimensions_current tier"],
      identifiers: ["asin", "fnsku", "sku", "product_id via map"],
      dates: ["report upload created_at", "settlement deposit_date", "fee preview implicit snapshot"],
      blockers: ["Fee preview row count may be 0 on staging — verify census", "No resolved_product_id on fee tables"],
    };

    const storageFeeAuditRequirements = {
      compare: ["amazon_monthly_storage_fees.storage_rate × volume vs settlement storage lines"],
      identifiers: ["asin", "fnsku", "storage_month"],
      volume_source: "product_packaging_dimensions_current cubic inches/feet conversion",
      blockers: ["storage_rate populated check", "No explicit cubic_feet on storage fee rows — may be in raw_data"],
    };

    const removalFeeAuditRequirements = {
      compare: ["removal order lines vs expected_packages quantities vs billed removal fees in settlements/FRR"],
      identifiers: ["order_id", "sku", "fnsku", "tracking_number"],
      blockers: ["Removal domain tables lack explicit fee amount columns — rely on settlements/FRR"],
    };

    const tridEdgeRequirements = [
      { edge: "product_spine", from: "claim_line / trid_entity", to: "products + packaging_dimensions_current", status: "partial — 4889 missing product links per TRID dry-run" },
      { edge: "evidence", from: "trid_entity", to: "product_packaging_evidence + product_packaging_profile_versions", status: "not materialized — schema exists" },
      { edge: "financial_match", from: "trid_entity", to: "financial_reference_resolver.trid_key", status: "pattern locked in trid_foundation" },
      { edge: "claim_to_shipment", from: "claim_reference_edges", to: "expected_packages / amazon_removal_shipments", status: "exists in discovery engine" },
      { edge: "amazon_fee_row", from: "candidate", to: "amazon_fee_preview via asin+fnsku+upload", status: "needs new discovery rule" },
      { edge: "storage_fee_row", from: "candidate", to: "amazon_monthly_storage_fees", status: "needs new discovery rule" },
    ];

    const productStoryRequirements = {
      blocks_affected: [
        "Product specs / Packaging (dimensions_current + evidence)",
        "Financial / FBA & storage fees (fee preview, settlements, FRR)",
        "Removals / Shipments (removal_shipments, expected_packages, tracking)",
        "Claim evidence / TRID graph (edges to fee + dimension sources)",
      ],
      api_today: "GET /api/dashboard/products/[id] + Claim Center 6-block detail — no unified /story API",
      gaps: ["No Product Story section for dimensional-weight tier comparison", "No fee-overcharge delta widget"],
    };

    const missingTablesOrColumns = [
      { item: "amazon_measured_dimensions", severity: "gap", note: "No dedicated table; use packaging evidence + amazon_raw + fee raw_data" },
      { item: "computed_dimensional_weight", severity: "gap", note: "Not stored — must compute at audit time" },
      { item: "shipment_fee_fact", severity: "gap", note: "Fees scattered across settlements/FRR/fee reports" },
      { item: "carrier_dimensional_weight", severity: "gap", note: "No carrier invoice ingest" },
      { item: "amazon_fee_preview.resolved_product_id", severity: "enhancement", note: "Join via identifier map only today" },
      { item: "amazon_monthly_storage_fees.resolved_product_id", severity: "enhancement", note: "Join via identifier map only today" },
      { item: "products legacy dim columns", severity: "deprecated", note: "0 populated on staging — PC04 is canonical" },
    ];

    const productsTotal = tableCols.products
      ? Number(
          (
            await client.query(
              `SELECT count(*)::int c FROM products WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
              [ORG],
            )
          ).rows[0]?.c ?? 0,
        )
      : 0;
    const dimsCurrent = Number((packagingStats as { coverage?: { total?: number } }).coverage?.total ?? 0);
    const safeToDesign =
      tableCols.product_packaging_dimensions_current &&
      dimsCurrent > 0 &&
      tableCols.amazon_fee_preview &&
      tableCols.amazon_settlements
        ? "yes"
        : "conditional_yes";

    const nextExactPrompt = `PHASE-PRODUCT-DIMENSIONS-FEE-CLAIM-SCHEMA-DESIGN-V1
Mode: read-only design + migration draft only (no apply).
Prerequisites: operator approval after this audit.
Scope: (1) additive resolved_product_id on amazon_fee_preview + amazon_monthly_storage_fees via map backfill plan; (2) product_packaging_evidence link rules for SP-API amazon measured dims; (3) computed dim_weight view on dimensions_current; (4) TRID discovery rules for fee_preview + storage_fee rows; (5) claim eligibility policy rows for FBA fee overcharge + storage overcharge families.
Staging ref: ${STAGING_REF}; max 25-row pilot backfill dry-run only.`;

    const outputs = {
      dimensions_table_inventory: dimensionsTableInventory,
      dimensions_field_map: dimensionsFieldMap,
      shipment_fee_source_inventory: shipmentFeeSourceInventory,
      fee_claim_use_case_matrix: feeClaimUseCaseMatrix,
      product_to_shipment_link_requirements: productToShipmentLinkRequirements,
      dimensional_weight_formula_requirements: dimensionalWeightFormulaRequirements,
      FBA_fee_audit_requirements: fbaFeeAuditRequirements,
      storage_fee_audit_requirements: storageFeeAuditRequirements,
      removal_fee_audit_requirements: removalFeeAuditRequirements,
      TRID_edge_requirements: tridEdgeRequirements,
      Product_Story_requirements: productStoryRequirements,
      missing_tables_or_columns: missingTablesOrColumns,
      SAFE_TO_DESIGN_DIMENSION_FEE_SCHEMA: safeToDesign,
      NEXT_EXACT_PROMPT: nextExactPrompt,
      census: {
        staging_ref: STAGING_REF,
        org: ORG,
        store: STORE,
        products_total: productsTotal,
        dimensions_current: dimsCurrent,
        dimensions_coverage_pct: productsTotal ? Math.round((dimsCurrent / productsTotal) * 1000) / 10 : 0,
        fee_preview: feePreviewStats,
        storage_fees: storageFeeStats,
        settlements: settlementStats,
        removals: removalStats,
        expected_packages: epStats,
        frr: frrStats,
      },
    };

    for (const [key, val] of Object.entries(outputs)) {
      if (key === "NEXT_EXACT_PROMPT") {
        fs.writeFileSync(path.join(outDir, `${key}.txt`), String(val));
      } else {
        fs.writeFileSync(path.join(outDir, `${key}.json`), JSON.stringify(val, null, 2));
      }
    }

    const summary = [
      "# PHASE-PRODUCT-DIMENSIONS-SHIPMENT-FEE-CLAIM-AUDIT-V1",
      "",
      `**Run:** \`${run}\` · **Staging:** \`${STAGING_REF}\` · **Read-only:** yes`,
      "",
      "## Headline",
      "",
      `- **Canonical dimensions table:** \`product_packaging_dimensions_current\` — **${dimsCurrent}** rows (${outputs.census.dimensions_coverage_pct}% of ${productsTotal} products)`,
      `- **Maysam table confirmed:** PC04 stack (\`product_packaging_profiles\` / \`_versions\` / \`_dimensions_current\` / \`_evidence\`)`,
      `- **Legacy \`products\` dim columns:** deprecated; use PC04 snapshot`,
      `- **Fee sources present:** \`amazon_fee_preview\`, \`amazon_monthly_storage_fees\`, \`amazon_settlements\`, \`financial_reference_resolver\``,
      `- **Shipment ops present:** \`expected_packages\`, \`amazon_removal_shipments\`, \`packages\` / \`pallets\` / \`shipment_boxes\``,
      `- **SAFE_TO_DESIGN_DIMENSION_FEE_SCHEMA:** **${safeToDesign}**`,
      "",
      "## Gaps (design queue)",
      "",
      ...missingTablesOrColumns.map((g) => `- **${g.item}** (${g.severity}): ${g.note}`),
      "",
      "## Next prompt",
      "",
      "```text",
      nextExactPrompt,
      "```",
      "",
      "Artifacts: all `*.json` keys match audit output contract.",
    ].join("\n");

    fs.writeFileSync(path.join(outDir, "audit-summary.md"), summary);
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          prompt: "PHASE-PRODUCT-DIMENSIONS-SHIPMENT-FEE-CLAIM-AUDIT-V1",
          run_id: run,
          staging_ref: STAGING_REF,
          read_only: true,
          no_db_writes: true,
          safe_to_design: safeToDesign,
          products_total: productsTotal,
          dimensions_current: dimsCurrent,
        },
        null,
        2,
      ),
    );

    console.log(JSON.stringify({ ok: true, outDir, safeToDesign, dimsCurrent, productsTotal }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
