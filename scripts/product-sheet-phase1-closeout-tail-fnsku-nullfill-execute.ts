/**
 * Tail apply: 8 spreadsheet rows / 5 products — FNSKU-only null-fill (governed).
 * Run after closeout pool head consumed conflict-skipped rows without applying safe tail.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";
import { getStagingProjectRef, loadEnvLocalIntoProcess, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const PARENT_RUN = "20260601T150000Z";
const OUT_BASE = ".cursor/audit-reports/product-sheet-phase1-closeout-safe-waves";

const TAIL_FILLS = [
  { spreadsheet_rows: ["4283", "4284"], product_id: "e0041ff8-420f-4eea-82a4-a1f2becc5c6a", seller_sku: "LIT-TOR-VEN-05890", patch_fnsku: "X004K47VSR" },
  { spreadsheet_rows: ["4288", "4289", "4290"], product_id: "b54c622f-eead-4965-a896-e95f3716bb2e", seller_sku: "LIT-TOR-VEN-05991", patch_fnsku: "X003XSL2DV" },
  { spreadsheet_rows: ["4324"], product_id: "2f075469-2b30-444f-b250-b110629cf403", seller_sku: "B00OKMUW9I-VEN", patch_fnsku: "X004FC8BVP" },
  { spreadsheet_rows: ["4325"], product_id: "fb46e5ad-f5b3-40cd-b802-ece86c36b306", seller_sku: "B016VWI6KQ-VEN", patch_fnsku: "X004FC4TIT" },
  { spreadsheet_rows: ["4331"], product_id: "6b90f255-45aa-4c6c-8dc0-f3c854c9ce33", seller_sku: "B09NFMKZSX-VEN", patch_fnsku: "X004FCD4F3" },
] as const;

function sqlLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  const runId = `${PARENT_RUN}-tail-fnsku-nullfill`;
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (!dbUrl || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const ids = TAIL_FILLS.map((r) => r.product_id);
  const before = await client.query(
    `SELECT id::text, sku, asin, fnsku, product_name, vendor_name FROM public.products WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const beforeById = new Map(before.rows.map((r) => [String(r.id), r]));

  const preimage = { tail_fills: TAIL_FILLS, products_before: before.rows };
  fs.writeFileSync(path.join(outDir, "preimage.json"), JSON.stringify(preimage, null, 2));

  const rollbackLines = [`-- tail FNSKU null-fill run_id=${runId}`, ""];
  const updated: Record<string, unknown>[] = [];

  await client.query("BEGIN");
  try {
    for (const row of TAIL_FILLS) {
      const pre = beforeById.get(row.product_id);
      if (!pre) throw new Error(`Missing product ${row.product_id}`);
      if (pre.fnsku) throw new Error(`Product ${row.product_id} already has fnsku=${pre.fnsku}`);
      const conflict = await client.query(
        `SELECT id::text FROM public.products
         WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
           AND fnsku = $3 AND id <> $4::uuid LIMIT 1`,
        [ORG, STORE, row.patch_fnsku, row.product_id],
      );
      if (conflict.rows.length) {
        throw new Error(`FNSKU conflict ${row.patch_fnsku} on product ${conflict.rows[0]!.id}`);
      }
      const upd = await client.query(
        `UPDATE public.products SET fnsku = $1, updated_at = now()
         WHERE id = $2::uuid AND organization_id = $3::uuid AND store_id = $4::uuid
           AND deleted_at IS NULL AND fnsku IS NULL
         RETURNING id::text, sku, asin, fnsku, product_name, vendor_name`,
        [row.patch_fnsku, row.product_id, ORG, STORE],
      );
      if (!upd.rowCount) throw new Error(`No-op update for ${row.product_id}`);
      updated.push({ ...row, after: upd.rows[0] });
      rollbackLines.push(
        `UPDATE public.products SET fnsku = NULL, updated_at = now() WHERE id = ${sqlLit(row.product_id)}::uuid;`,
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  const after = await client.query(
    `SELECT id::text, sku, asin, fnsku FROM public.products WHERE id = ANY($1::uuid[])`,
    [ids],
  );

  const manifest = {
    prompt: "PRODUCT-SHEET-PHASE1-CLOSEOUT-SAFE-WAVES-TAIL-FNSKU-NULLFILL",
    parent_run: PARENT_RUN,
    run_id: runId,
    staging_ref: STAGING_REF,
    spreadsheet_rows_touched: TAIL_FILLS.flatMap((r) => r.spreadsheet_rows).length,
    products_updated: updated.length,
    rows_updated: updated.length,
    only_fields: ["fnsku"],
    forbidden_touched: ["product_name", "vendor_name", "category_id", "images"],
    SAFE_TO_CONTINUE: "yes",
  };

  fs.writeFileSync(path.join(outDir, "rollback.sql"), `${rollbackLines.join("\n")}\n`);
  fs.writeFileSync(path.join(outDir, "products-updated.json"), JSON.stringify(updated, null, 2));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    `# Tail FNSKU null-fill\n\n- Products updated: **${updated.length}** (8 spreadsheet rows)\n- Fields: \`fnsku\` only\n`,
  );

  await client.end();
  console.log(JSON.stringify({ ...manifest, before_after: { before: before.rows, after: after.rows } }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
