/**
 * RETURN-ITEMS-BD5BF0D6-SPINE-PROMOTION-V187
 *
 * Governed single-SKU promotion from amazon_amazon_fulfilled_inventory → products + map.
 * Does NOT update return_items.
 *
 *   npx tsx scripts/return-items-bd5bf0d6-spine-promotion-v187.ts --run-id=<id>
 *   npx tsx scripts/return-items-bd5bf0d6-spine-promotion-v187.ts --run-id=<id> --execute
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/return-items-bd5bf0d6-spine-promotion-v187";
const APPROVAL_PATH = ".cursor/operator-approvals/return-items-bd5bf0d6-spine-v186-approval.md";

const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const RETURN_ITEM_ID = "bd5bf0d6-500a-4696-80c6-7c0e65f539b6";
const AFI_ROW_ID = "10915375-04d5-4f02-9124-0f7fdad7bcbc";
const SKU = "TU-8QKU-LV50";
const ASIN = "B0BSDRJ85M";
const FNSKU = "X00525Q5XZ";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApproval(): boolean {
  const raw = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  return /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(raw);
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const execute = process.argv.includes("--execute");
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

  const afi = (
    await client.query(
      `SELECT id::text, organization_id::text, store_id::text, seller_sku, fulfillment_channel_sku, asin,
              source_upload_id::text, source_file_sha256, source_physical_row_number,
              resolved_product_id::text, identifier_resolution_status
       FROM public.amazon_amazon_fulfilled_inventory
       WHERE id = $1::uuid`,
      [AFI_ROW_ID],
    )
  ).rows[0];

  if (!afi) throw new Error(`AFI row ${AFI_ROW_ID} not found`);
  if (afi.organization_id !== SAM_ORG || afi.store_id !== SAM_STORE) {
    throw new Error("AFI row org/store mismatch");
  }
  if (afi.seller_sku !== SKU || afi.asin !== ASIN || afi.fulfillment_channel_sku !== FNSKU) {
    throw new Error("AFI identifiers drifted from V186 expected values");
  }

  const productHits = await client.query(
    `SELECT id::text, sku, asin, fnsku FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
       AND (sku = $3 OR asin = $4 OR fnsku = $5)`,
    [SAM_ORG, SAM_STORE, SKU, ASIN, FNSKU],
  );

  const mapHits = await client.query(
    `SELECT id::text, product_id::text, seller_sku, asin, fnsku FROM public.product_identifier_map
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND (deleted_at IS NULL)
       AND (seller_sku = $3 OR asin = $4 OR fnsku = $5)`,
    [SAM_ORG, SAM_STORE, SKU, ASIN, FNSKU],
  );

  const precheck = {
    afi_row: afi,
    existing_products: productHits.rows,
    existing_map: mapHits.rows,
    afi_already_resolved: afi.resolved_product_id != null,
    blockers: [] as string[],
  };

  if (precheck.afi_already_resolved) {
    precheck.blockers.push("afi_already_has_resolved_product_id");
  }
  if (productHits.rows.length > 0) {
    precheck.blockers.push("product_already_exists");
  }
  for (const m of mapHits.rows) {
    precheck.blockers.push(`map_conflict:${m.id}:product_id=${m.product_id}`);
  }

  fs.writeFileSync(path.join(outDir, "precheck.json"), JSON.stringify(precheck, null, 2));

  const returnItem = (
    await client.query(
      `SELECT id::text, asin, fnsku, sku, resolved_product_id::text
       FROM public.return_items WHERE id = $1::uuid`,
      [RETURN_ITEM_ID],
    )
  ).rows[0];
  const returnAsinRaw = returnItem?.asin != null ? String(returnItem.asin) : "";
  const returnAsinNeedsNormalize =
    returnAsinRaw !== returnAsinRaw.trim() || returnAsinRaw.includes("\r") || returnAsinRaw.includes("\n");

  if (precheck.blockers.length > 0 && execute) {
    const spineAlreadyDone =
      precheck.afi_already_resolved &&
      productHits.rows.length > 0 &&
      String(afi.resolved_product_id) === String(productHits.rows[0]?.id);
    if (spineAlreadyDone) {
      const result = {
        run_id: runId,
        staging_ref: STAGING_REF,
        mode: "execute_idempotent_skip",
        product_id: productHits.rows[0]?.id,
        map_id: mapHits.rows[0]?.id,
        afi_id: AFI_ROW_ID,
        return_items_touched: false,
        return_item_asin_needs_normalize: returnAsinNeedsNormalize,
        note: "Spine already applied; no duplicate INSERT.",
      };
      fs.writeFileSync(path.join(outDir, "execute-result.json"), JSON.stringify(result, null, 2));
      fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(result, null, 2));
      fs.writeFileSync(
        path.join(outDir, "execute-summary.md"),
        [
          "# BD5BF0D6 spine promotion — idempotent (already applied)",
          "",
          `- product_id: \`${result.product_id}\``,
          `- map_id: \`${result.map_id}\``,
          `- prior run: \`20260521T210000Z\``,
          "- return_items: **not modified**",
          `- return_item ASIN CRLF: **${returnAsinNeedsNormalize ? "still present — use separate V188 cleanup approval" : "clean"}**`,
        ].join("\n"),
      );
      await client.end();
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    throw new Error(`Precheck blocked: ${precheck.blockers.join(", ")}`);
  }

  if (!execute) {
    fs.writeFileSync(
      path.join(outDir, "plan-summary.md"),
      [
        "# BD5BF0D6 spine promotion — plan only",
        "",
        `- AFI row: \`${AFI_ROW_ID}\``,
        `- SKU / ASIN / FNSKU: \`${SKU}\` / \`${ASIN}\` / \`${FNSKU}\``,
        `- blockers: ${precheck.blockers.length ? precheck.blockers.join(", ") : "none"}`,
        `- return_item ASIN CRLF pending: **${returnAsinNeedsNormalize ? "yes (separate V188)" : "no"}**`,
        "",
        "Run with `--execute` after `APPROVED_TO_RUN_STAGING=true`.",
        "",
        "**Will not** update `return_items`.",
      ].join("\n"),
    );
    await client.end();
    console.log(JSON.stringify({ mode: "plan", blockers: precheck.blockers }, null, 2));
    return;
  }

  if (!readApproval()) {
    throw new Error(`Set APPROVED_TO_RUN_STAGING=true in ${APPROVAL_PATH}`);
  }

  const newProductId = randomUUID();
  const preimage = {
    products_before: productHits.rows,
    map_before: mapHits.rows,
    afi_before: {
      id: afi.id,
      resolved_product_id: afi.resolved_product_id,
      identifier_resolution_status: afi.identifier_resolution_status,
    },
  };
  fs.writeFileSync(path.join(outDir, "preimage.json"), JSON.stringify(preimage, null, 2));

  try {
    await client.query("BEGIN");

    const insProduct = await client.query(
      `INSERT INTO public.products (
         id, organization_id, store_id, sku, asin, fnsku, product_name,
         status, merge_status, metadata, amazon_raw,
         last_seen_at, last_catalog_sync_at, first_seen_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7,
         'active', 'active',
         $8::jsonb, $9::jsonb,
         now(), now(), now()
       )
       RETURNING id::text`,
      [
        newProductId,
        SAM_ORG,
        SAM_STORE,
        SKU,
        ASIN,
        FNSKU,
        SKU,
        JSON.stringify({
          audit_prompt: "RETURN-ITEMS-BD5BF0D6-SPINE-PROMOTION-V187",
          source_table: "amazon_amazon_fulfilled_inventory",
          source_afi_id: AFI_ROW_ID,
          return_item_id: RETURN_ITEM_ID,
          source_upload_id: afi.source_upload_id,
          run_id: runId,
        }),
        JSON.stringify({
          seller_sku: SKU,
          asin: ASIN,
          fnsku: FNSKU,
          source_upload_id: afi.source_upload_id,
          source_physical_row_number: afi.source_physical_row_number,
        }),
      ],
    );

    const insMap = await client.query(
      `INSERT INTO public.product_identifier_map (
         organization_id, store_id, product_id, seller_sku, msku, asin, fnsku,
         source_upload_id, source_file_sha256, source_physical_row_number,
         match_source, confidence_score, is_primary, linked_from_report_family,
         linked_from_target_table, first_seen_at, last_seen_at, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $4, $5, $6,
         $7::uuid, $8, $9,
         'afi_spine_promotion_v187', 1.0, true, 'amazon_fulfilled_inventory', 'products',
         now(), now(), now(), now()
       )
       RETURNING id::text`,
      [
        SAM_ORG,
        SAM_STORE,
        newProductId,
        SKU,
        ASIN,
        FNSKU,
        afi.source_upload_id,
        afi.source_file_sha256,
        afi.source_physical_row_number,
      ],
    );

    const updAfi = await client.query(
      `UPDATE public.amazon_amazon_fulfilled_inventory
       SET resolved_product_id = $1::uuid,
           resolved_catalog_product_id = NULL,
           identifier_resolution_status = 'resolved',
           identifier_resolution_confidence = 1.0,
           updated_at = now()
       WHERE id = $2::uuid AND resolved_product_id IS NULL
       RETURNING id::text`,
      [newProductId, AFI_ROW_ID],
    );

    if ((updAfi.rowCount ?? 0) !== 1) {
      throw new Error("AFI update did not affect exactly 1 row");
    }

    await client.query("COMMIT");

    const result = {
      run_id: runId,
      staging_ref: STAGING_REF,
      product_id: insProduct.rows[0]?.id ?? newProductId,
      map_id: insMap.rows[0]?.id,
      afi_id: AFI_ROW_ID,
      return_items_touched: false,
    };

    fs.writeFileSync(path.join(outDir, "execute-result.json"), JSON.stringify(result, null, 2));
    fs.writeFileSync(
      path.join(outDir, "rollback.sql"),
      [
        "-- Rollback RETURN-ITEMS-BD5BF0D6-SPINE-PROMOTION-V187",
        `UPDATE public.amazon_amazon_fulfilled_inventory SET resolved_product_id = NULL, identifier_resolution_status = NULL, identifier_resolution_confidence = NULL, updated_at = now() WHERE id = '${AFI_ROW_ID}'::uuid;`,
        `UPDATE public.product_identifier_map SET deleted_at = now() WHERE product_id = '${newProductId}'::uuid;`,
        `UPDATE public.products SET deleted_at = now() WHERE id = '${newProductId}'::uuid;`,
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          prompt: "RETURN-ITEMS-BD5BF0D6-SPINE-PROMOTION-V187",
          run_id: runId,
          staging_ref: STAGING_REF,
          mode: "execute",
          ...result,
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(outDir, "execute-summary.md"),
      [
        "# BD5BF0D6 spine promotion — executed",
        "",
        `- product_id: \`${result.product_id}\``,
        `- map_id: \`${result.map_id}\``,
        `- AFI \`${AFI_ROW_ID}\` → resolved`,
        "- return_items: **not modified**",
        "",
        "Re-run FBM dry-run; fix return_item FNSKU/ASIN CRLF separately if tiers still miss.",
      ].join("\n"),
    );

    await client.end();
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    await client.query("ROLLBACK");
    await client.end();
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
