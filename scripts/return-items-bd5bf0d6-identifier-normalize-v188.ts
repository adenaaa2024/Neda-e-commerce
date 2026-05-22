/**
 * RETURN-ITEMS-BD5BF0D6-IDENTIFIER-NORMALIZE-V188
 *
 * Scan-parity only: trim ASIN CRLF + align FNSKU to AFI canonical on bd5bf0d6.
 * Does not touch resolver columns (resolved_product_id, status, confidence).
 *
 *   npx tsx scripts/return-items-bd5bf0d6-identifier-normalize-v188.ts --run-id=<id>
 *   npx tsx scripts/return-items-bd5bf0d6-identifier-normalize-v188.ts --run-id=<id> --execute
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
const OUT_BASE = ".cursor/audit-reports/return-items-bd5bf0d6-identifier-normalize-v188";
const APPROVAL_PATH = ".cursor/operator-approvals/return-items-bd5bf0d6-identifier-normalize-v188-approval.md";
const RETURN_ITEM_ID = "bd5bf0d6-500a-4696-80c6-7c0e65f539b6";
const AFI_ROW_ID = "10915375-04d5-4f02-9124-0f7fdad7bcbc";
const EXPECTED_ASIN = "B0BSDRJ85M";
const EXPECTED_SKU = "TU-8QKU-LV50";
const EXPECTED_FNSKU = "X00525Q5XZ";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApproval(): boolean {
  return /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(
    fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8"),
  );
}

function normalizeAsin(raw: string | null): string | null {
  if (raw == null) return null;
  const t = raw.replace(/\r/g, "").replace(/\n/g, "").trim();
  return t === "" ? null : t;
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function n(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
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

  const row = (
    await client.query(
      `SELECT id::text, asin, sku, fnsku, resolved_product_id::text,
              identifier_resolution_status, identifier_resolution_confidence::text, deleted_at
       FROM public.return_items WHERE id = $1::uuid`,
      [RETURN_ITEM_ID],
    )
  ).rows[0];

  if (!row) throw new Error(`return_item ${RETURN_ITEM_ID} not found`);
  if (row.deleted_at != null) throw new Error("return_item is soft-deleted");

  const afi = (
    await client.query(
      `SELECT seller_sku, fulfillment_channel_sku, asin
       FROM public.amazon_amazon_fulfilled_inventory WHERE id = $1::uuid`,
      [AFI_ROW_ID],
    )
  ).rows[0];

  if (!afi) throw new Error(`AFI row ${AFI_ROW_ID} not found`);
  if (afi.seller_sku !== EXPECTED_SKU || afi.asin !== EXPECTED_ASIN || afi.fulfillment_channel_sku !== EXPECTED_FNSKU) {
    throw new Error("AFI canonical identifiers drifted from expected values");
  }

  const product = (
    await client.query(
      `SELECT id::text, sku, asin, fnsku FROM public.products
       WHERE id = $1::uuid AND deleted_at IS NULL`,
      [row.resolved_product_id],
    )
  ).rows[0];

  const asinRaw = row.asin != null ? String(row.asin) : null;
  const fnskuRaw = row.fnsku != null ? String(row.fnsku) : null;
  const asinTarget = normalizeAsin(asinRaw);
  const fnskuTarget = EXPECTED_FNSKU;

  const plan = {
    return_item_id: RETURN_ITEM_ID,
    asin: { raw: asinRaw, target: asinTarget, change: asinTarget !== asinRaw },
    fnsku: { raw: fnskuRaw, target: fnskuTarget, change: fnskuRaw !== fnskuTarget },
    sku: { raw: n(row.sku), unchanged: EXPECTED_SKU },
    resolver_unchanged: true,
    already_clean: asinTarget === asinRaw && fnskuRaw === fnskuTarget,
  };

  if (asinTarget !== EXPECTED_ASIN) {
    throw new Error(`ASIN normalizes to "${asinTarget}", expected "${EXPECTED_ASIN}"`);
  }
  if (product && n(product.fnsku) !== EXPECTED_FNSKU) {
    throw new Error(`products.fnsku mismatch: ${product.fnsku}`);
  }

  fs.writeFileSync(path.join(outDir, "preimage-bd5bf0d6.json"), JSON.stringify(row, null, 2));
  fs.writeFileSync(
    path.join(outDir, "preimage-return-item.csv"),
    [
      "id,asin,sku,fnsku,resolved_product_id,identifier_resolution_status,identifier_resolution_confidence",
      [
        RETURN_ITEM_ID,
        csvEscape(asinRaw),
        csvEscape(row.sku),
        csvEscape(fnskuRaw),
        row.resolved_product_id,
        row.identifier_resolution_status,
        row.identifier_resolution_confidence,
      ].join(","),
    ].join("\n"),
  );
  fs.writeFileSync(path.join(outDir, "normalize-plan.json"), JSON.stringify(plan, null, 2));

  if (!execute) {
    fs.writeFileSync(
      path.join(outDir, "plan-summary.md"),
      [
        "# Identifier normalize V188 — plan",
        "",
        `- ASIN: ${JSON.stringify(asinRaw)} → \`${asinTarget}\` (change: ${plan.asin.change})`,
        `- FNSKU: \`${fnskuRaw}\` → \`${fnskuTarget}\` (change: ${plan.fnsku.change})`,
        `- SKU: \`${row.sku}\` (unchanged)`,
        "- Resolver columns: **not modified**",
      ].join("\n"),
    );
    await client.end();
    console.log(JSON.stringify({ mode: "plan", ...plan }, null, 2));
    return;
  }

  if (!readApproval()) {
    throw new Error(`Set APPROVED_TO_RUN_STAGING=true in ${APPROVAL_PATH}`);
  }

  if (plan.already_clean) {
    const manifest = {
      prompt: "RETURN-ITEMS-BD5BF0D6-IDENTIFIER-NORMALIZE-V188",
      run_id: runId,
      mode: "execute_idempotent_skip",
      rows_updated: 0,
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    await client.end();
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  const upd = await client.query(
    `UPDATE public.return_items
     SET asin = $2,
         fnsku = $3,
         updated_at = now()
     WHERE id = $1::uuid AND deleted_at IS NULL
     RETURNING id::text, asin, fnsku, resolved_product_id::text,
               identifier_resolution_status, identifier_resolution_confidence::text`,
    [RETURN_ITEM_ID, EXPECTED_ASIN, EXPECTED_FNSKU],
  );

  if ((upd.rowCount ?? 0) !== 1) throw new Error("UPDATE did not affect exactly one row");

  const post = upd.rows[0];
  const manifest = {
    prompt: "RETURN-ITEMS-BD5BF0D6-IDENTIFIER-NORMALIZE-V188",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "execute",
    asin_before: asinRaw,
    fnsku_before: fnskuRaw,
    asin_after: post.asin,
    fnsku_after: post.fnsku,
    resolved_product_id: post.resolved_product_id,
    identifier_resolution_status: post.identifier_resolution_status,
    rows_updated: 1,
    resolver_columns_touched: false,
  };

  const esc = (s: string | null) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      "-- Rollback identifier normalize V188",
      `UPDATE public.return_items SET asin = ${esc(asinRaw)}, fnsku = ${esc(fnskuRaw)}, updated_at = now() WHERE id = '${RETURN_ITEM_ID}'::uuid;`,
    ].join("\n"),
  );
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "execute-summary.md"),
    [
      "# Identifier normalize V188",
      "",
      `- ASIN: ${JSON.stringify(asinRaw)} → \`${post.asin}\``,
      `- FNSKU: \`${fnskuRaw}\` → \`${post.fnsku}\``,
      `- resolved_product_id: \`${post.resolved_product_id}\` (unchanged)`,
      `- status: \`${post.identifier_resolution_status}\` (unchanged)`,
    ].join("\n"),
  );

  await client.end();
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
