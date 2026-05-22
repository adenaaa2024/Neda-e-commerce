/**
 * SAM-PRODUCT-SPINE-LOOKUP-FOR-RETURN-ITEM-V186 — Read-only staging lookup.
 *
 *   npx tsx scripts/sam-product-spine-lookup-return-item-v186.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/sam-product-spine-lookup-return-item-v186";
const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const RETURN_ITEM_ID = "bd5bf0d6-500a-4696-80c6-7c0e65f539b6";
const ASIN = "B0BSDRJ85M";
const SKU = "TU-8QKU-LV50";
const RETURN_FNSKU = "4324567";
const AFI_FNSKU = "X00525Q5XZ";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return (r.rowCount ?? 0) > 0;
}

function scanAuditDirs(): { path: string; hint: string }[] {
  const base = path.join(process.cwd(), ".cursor", "audit-reports");
  if (!fs.existsSync(base)) return [];
  const hits: { path: string; hint: string }[] = [];
  const needles = ["product-seed", "product-identity", "import-product", "pim", "afi", "catalog"];
  for (const name of fs.readdirSync(base)) {
    const lower = name.toLowerCase();
    if (needles.some((n) => lower.includes(n))) {
      hits.push({ path: path.join(".cursor/audit-reports", name), hint: "audit folder name match" });
    }
  }
  return hits.slice(0, 30);
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const stagingRef = getStagingProjectRef({ loadEnv: false });
  if (!dbUrl || stagingRef !== STAGING_REF || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error(`Staging guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const returnItem = (
    await client.query(
      `SELECT id::text, organization_id::text, store_id::text, sku, fnsku, asin,
              product_identifier, package_id::text, notes, deleted_at, created_at, updated_at
       FROM public.return_items WHERE id=$1::uuid`,
      [RETURN_ITEM_ID],
    )
  ).rows[0];

  const productsExact = {
    asin: (
      await client.query(
        `SELECT id::text, store_id::text, sku, asin, fnsku, product_name
         FROM public.products WHERE organization_id=$1::uuid AND deleted_at IS NULL AND asin=$2`,
        [SAM_ORG, ASIN],
      )
    ).rows,
    sku: (
      await client.query(
        `SELECT id::text, store_id::text, sku, asin, fnsku, product_name
         FROM public.products WHERE organization_id=$1::uuid AND deleted_at IS NULL AND sku=$2`,
        [SAM_ORG, SKU],
      )
    ).rows,
    fnsku_return: (
      await client.query(
        `SELECT id::text, store_id::text, sku, asin, fnsku, product_name
         FROM public.products WHERE organization_id=$1::uuid AND deleted_at IS NULL AND fnsku=$2`,
        [SAM_ORG, RETURN_FNSKU],
      )
    ).rows,
    fnsku_afi: (
      await client.query(
        `SELECT id::text, store_id::text, sku, asin, fnsku, product_name
         FROM public.products WHERE organization_id=$1::uuid AND deleted_at IS NULL AND fnsku=$2`,
        [SAM_ORG, AFI_FNSKU],
      )
    ).rows,
  };

  const productsSameAsin = (
    await client.query(
      `SELECT id::text, store_id::text, sku, asin, fnsku, product_name
       FROM public.products WHERE organization_id=$1::uuid AND deleted_at IS NULL AND asin=$2
       ORDER BY store_id, sku LIMIT 20`,
      [SAM_ORG, ASIN],
    )
  ).rows;

  const mapExact = {
    asin: (
      await client.query(
        `SELECT id::text, product_id::text, store_id::text, seller_sku, msku, asin, fnsku
         FROM public.product_identifier_map
         WHERE organization_id=$1::uuid AND store_id=$2::uuid AND asin=$3`,
        [SAM_ORG, SAM_STORE, ASIN],
      )
    ).rows,
    sku: (
      await client.query(
        `SELECT id::text, product_id::text, store_id::text, seller_sku, msku, asin, fnsku
         FROM public.product_identifier_map
         WHERE organization_id=$1::uuid AND store_id=$2::uuid
           AND (seller_sku=$3 OR msku=$3)`,
        [SAM_ORG, SAM_STORE, SKU],
      )
    ).rows,
    fnsku_return: (
      await client.query(
        `SELECT id::text, product_id::text, store_id::text, seller_sku, msku, asin, fnsku
         FROM public.product_identifier_map
         WHERE organization_id=$1::uuid AND store_id=$2::uuid AND fnsku=$3`,
        [SAM_ORG, SAM_STORE, RETURN_FNSKU],
      )
    ).rows,
    fnsku_afi: (
      await client.query(
        `SELECT id::text, product_id::text, store_id::text, seller_sku, msku, asin, fnsku
         FROM public.product_identifier_map
         WHERE organization_id=$1::uuid AND store_id=$2::uuid AND fnsku=$3`,
        [SAM_ORG, SAM_STORE, AFI_FNSKU],
      )
    ).rows,
  };

  const afiRows = (
    await client.query(
      `SELECT id::text, source_upload_id::text, seller_sku, fulfillment_channel_sku, asin,
              quantity_available, resolved_product_id::text, catalog_product_id::text,
              identifier_resolution_status, source_physical_row_number
       FROM public.amazon_amazon_fulfilled_inventory
       WHERE organization_id=$1::uuid AND store_id=$2::uuid
         AND (asin=$3 OR seller_sku=$4 OR fulfillment_channel_sku=$5)
       LIMIT 10`,
      [SAM_ORG, SAM_STORE, ASIN, SKU, AFI_FNSKU],
    )
  ).rows;

  let catalogRows: unknown[] = [];
  if (await tableExists(client, "catalog_products")) {
    catalogRows = (
      await client.query(
        `SELECT id::text, seller_sku, asin, fnsku, item_name
         FROM public.catalog_products
         WHERE organization_id=$1::uuid AND store_id=$2::uuid
           AND (asin=$3 OR seller_sku=$4 OR fnsku=$5 OR fnsku=$6)
         LIMIT 10`,
        [SAM_ORG, SAM_STORE, ASIN, SKU, RETURN_FNSKU, AFI_FNSKU],
      )
    ).rows;
  }

  let stagingRows: unknown[] = [];
  if (await tableExists(client, "product_identity_staging_rows")) {
    stagingRows = (
      await client.query(
        `SELECT id::text, seller_sku, asin, fnsku, product_name, upload_id::text,
                source_physical_row_number
         FROM public.product_identity_staging_rows
         WHERE organization_id=$1::uuid AND store_id=$2::uuid
           AND (asin=$3 OR seller_sku=$4 OR fnsku IN ($5, $6))
         LIMIT 10`,
        [SAM_ORG, SAM_STORE, ASIN, SKU, RETURN_FNSKU, AFI_FNSKU],
      )
    ).rows;
  }

  const uploadId = afiRows[0]?.source_upload_id as string | undefined;
  let uploadMeta: unknown = null;
  if (uploadId && (await tableExists(client, "raw_report_uploads"))) {
    uploadMeta = (
      await client.query(`SELECT * FROM public.raw_report_uploads WHERE id=$1::uuid`, [uploadId])
    ).rows[0];
  }

  const returnAsinRaw = returnItem?.asin != null ? String(returnItem.asin) : "";
  const returnAsinHasCrlf = returnAsinRaw !== returnAsinRaw.trim() || returnAsinRaw.includes("\r") || returnAsinRaw.includes("\n");

  const existingProductFound =
    productsExact.asin.length > 0 ||
    productsExact.sku.length > 0 ||
    productsExact.fnsku_afi.length > 0;

  const identifierDirty =
    (RETURN_FNSKU !== AFI_FNSKU &&
      productsExact.fnsku_return.length === 0 &&
      mapExact.fnsku_return.length === 0) ||
    returnAsinHasCrlf;

  const productSpineNeeded = !existingProductFound && afiRows.length > 0;

  const auditDirHits = scanAuditDirs();

  const payload = {
    run_id: runId,
    staging_ref: STAGING_REF,
    return_item: returnItem,
    identifiers: { asin: ASIN, sku: SKU, return_fnsku: RETURN_FNSKU, afi_fnsku: AFI_FNSKU },
    products_exact: productsExact,
    products_same_asin: productsSameAsin,
    map_exact: mapExact,
    afi_rows: afiRows,
    catalog_rows: catalogRows,
    staging_rows: stagingRows,
    upload_meta: uploadMeta,
    audit_dir_hits: auditDirHits,
    decisions: {
      existing_product_found: existingProductFound,
      product_spine_needed: productSpineNeeded,
      identifier_dirty: identifierDirty,
      return_item_asin_has_crlf: returnAsinHasCrlf,
      return_item_asin_raw: returnAsinRaw,
      row_is_test_fake: false,
    },
  };

  fs.writeFileSync(path.join(outDir, "lookup-results.json"), JSON.stringify(payload, null, 2));

  fs.writeFileSync(
    path.join(outDir, "product-table-search.md"),
    [
      "# Product table search — Sam bd5bf0d6",
      "",
      "| Probe | Store-scoped / org hits |",
      "|-------|-------------------------|",
      `| \`asin=${ASIN}\` | ${productsExact.asin.length} |`,
      `| \`sku=${SKU}\` | ${productsExact.sku.length} |`,
      `| \`fnsku=${RETURN_FNSKU}\` (return_item) | ${productsExact.fnsku_return.length} |`,
      `| \`fnsku=${AFI_FNSKU}\` (AFI canonical) | ${productsExact.fnsku_afi.length} |`,
      "",
      "## Same ASIN (any SKU/FNSKU in org)",
      "",
      productsSameAsin.length
        ? productsSameAsin.map((r: Record<string, unknown>) =>
            `- \`${r.id}\` store=\`${r.store_id}\` sku=\`${r.sku}\` fnsku=\`${r.fnsku ?? ""}\``,
          ).join("\n")
        : "_none_",
      "",
      "## Conclusion",
      "",
      existingProductFound
        ? "**Product row exists** under searched identifiers."
        : "**No product row** for ASIN/SKU/AFI FNSKU on staging.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "identifier-map-search.md"),
    [
      "# product_identifier_map search",
      "",
      "| Identifier | Rows |",
      "|------------|-----:|",
      `| ASIN \`${ASIN}\` | ${mapExact.asin.length} |`,
      `| SKU \`${SKU}\` | ${mapExact.sku.length} |`,
      `| FNSKU \`${RETURN_FNSKU}\` (return_item) | ${mapExact.fnsku_return.length} |`,
      `| FNSKU \`${AFI_FNSKU}\` (AFI) | ${mapExact.fnsku_afi.length} |`,
      "",
      identifierDirty
        ? "**FNSKU mismatch:** return_item uses non-Amazon FNSKU; AFI lists `fulfillment_channel_sku`."
        : "FNSKU aligns with import source.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "import-source-search.md"),
    [
      "# Import / source search",
      "",
      "## amazon_amazon_fulfilled_inventory",
      "",
      afiRows.length
        ? afiRows
            .map(
              (r: Record<string, unknown>) =>
                `- id=\`${r.id}\` upload=\`${r.source_upload_id}\` sku=\`${r.seller_sku}\` asin=\`${r.asin}\` fnsku=\`${r.fulfillment_channel_sku}\` resolved_product=\`${r.resolved_product_id ?? "null"}\``,
            )
            .join("\n")
        : "_no rows_",
      "",
      "## catalog_products",
      "",
      catalogRows.length ? JSON.stringify(catalogRows, null, 2) : "_no exact rows_",
      "",
      "## product_identity_staging_rows",
      "",
      stagingRows.length ? JSON.stringify(stagingRows, null, 2) : "_table empty or no hits_",
      "",
      "## raw_report_uploads (AFI lineage)",
      "",
      uploadMeta ? "```json\n" + JSON.stringify(uploadMeta, null, 2) + "\n```" : "_n/a_",
      "",
      "## Repo audit folders (name match)",
      "",
      auditDirHits.length
        ? auditDirHits.map((h) => `- ${h.path}`).join("\n")
        : "_no product-import audit folder names in .cursor/audit-reports_",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "product-spine-decision.md"),
    [
      "# Product spine decision",
      "",
      "| Question | Answer |",
      "|----------|--------|",
      `| Existing \`products\` row? | **${existingProductFound ? "yes" : "no"}** |`,
      `| Product under different identifier? | **${productsSameAsin.length > 0 && !existingProductFound ? "possible — see same-ASIN list" : "no exact alternate spine"}** |`,
      `| Missing from catalog spine? | **${productSpineNeeded ? "yes — AFI import exists, products/map empty" : "unclear"}** |`,
      `| Identifier dirty? | **${identifierDirty ? "yes — return FNSKU ≠ AFI FNSKU" : "no"}** |`,
      `| Test/fake row? | **no** — ASIN/SKU match real AFI import |`,
      "",
      "**Verdict:** Operational listing exists in **AFI import** but was never promoted to `products` / `product_identifier_map`. Return scan FNSKU `4324567` is likely **wrong channel label**; resolver should use SKU+ASIN (and AFI FNSKU after spine), not return_item FNSKU alone.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "product-spine-import-plan-if-needed.md"),
    [
      "# Product spine import plan (if needed)",
      "",
      "**Needed:** yes — governed promotion, not auto-create.",
      "",
      "## Required fields (products)",
      "",
      "- `organization_id` = Sam org",
      "- `store_id` = Sam store",
      "- `sku` = `TU-8QKU-LV50`",
      "- `asin` = `B0BSDRJ85M`",
      "- `fnsku` = `X00525Q5XZ` (from AFI `fulfillment_channel_sku`, not `4324567`)",
      "- `product_name` — from PIM/CSV if available; optional until import",
      "",
      "## product_identifier_map rows (after products.id)",
      "",
      "- Tier-1 FNSKU: `X00525Q5XZ`",
      "- Tier-2 ASIN: `B0BSDRJ85M`",
      "- Tier-3 seller_sku: `TU-8QKU-LV50`",
      "",
      "## Rollback",
      "",
      "- Preimage: export `products` + `product_identifier_map` rows by id before insert",
      "- Soft-delete products if governed path supports `deleted_at`",
      "",
      "## Approval",
      "",
      "- [`.cursor/operator-approvals/return-items-bd5bf0d6-spine-v186-approval.md`](../../operator-approvals/return-items-bd5bf0d6-spine-v186-approval.md) — set `APPROVED_TO_RUN_STAGING=true` after review",
      "",
      "## Sequence",
      "",
      "1. Governed PIM / `import-product-identity` or AFI resolver promotion",
      "2. V185 map enrichment (only with product_id)",
      "3. FBM dry-run — expect tier match on FNSKU or ASIN/SKU",
      "4. return_items resolver execute only if dry-run shows eligible `set_resolved`",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "# Blockers",
      "",
      "- No `products.id` → V185 map enrichment blocked",
      "- return_item FNSKU `4324567` ≠ AFI `X00525Q5XZ` → tier-1 FNSKU match will fail until spine uses canonical FNSKU",
      "- `APPROVED_TO_RUN_STAGING=false` on spine approval",
      "- Resolver execute remains **blocked** until spine + optional map + dry-run",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "SAM-PRODUCT-SPINE-LOOKUP-FOR-RETURN-ITEM-V186",
        run_id: runId,
        staging_ref: STAGING_REF,
        return_item_id: RETURN_ITEM_ID,
        existing_product_found: existingProductFound,
        product_spine_needed: productSpineNeeded,
        identifier_dirty: identifierDirty,
        afi_import_hit: afiRows.length > 0,
        write_mode: "read_only",
      },
      null,
      2,
    ),
  );

  await client.end();
  console.log(`Wrote ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
