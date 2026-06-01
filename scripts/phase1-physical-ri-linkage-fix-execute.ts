/**
 * PHASE1-PHYSICAL-RI-LINKAGE-FIX-EXECUTE — single governed return_item resolution
 *   npx tsx scripts/phase1-physical-ri-linkage-fix-execute.ts --run-id=<UTC>
 *   npx tsx scripts/phase1-physical-ri-linkage-fix-execute.ts --run-id=<UTC> --apply
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
const TARGET_RI = "512cd6ce-1769-494f-a752-a743509cae94";
const AUDIT_RUN = "20260521T231500Z";
const AUDIT_DIR = `.cursor/audit-reports/phase1-product-linkage-remaining-critical-fix/${AUDIT_RUN}`;
const APPROVAL_PATH = ".cursor/operator-approvals/phase1-physical-ri-linkage-fix-approval.md";
const OUT_BASE = ".cursor/audit-reports/phase1-physical-ri-linkage-fix-execute";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApproval(): boolean {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_PHASE1_PHYSICAL_RI_LINKAGE_FIX\s*=\s*true/i.test(text) &&
    new RegExp(`APPROVED_RETURN_ITEM_IDS\\s*=\\s*${TARGET_RI}`, "i").test(text) &&
    /APPROVED_PRODUCT_INSERT\s*=\s*false/i.test(text) &&
    new RegExp(`TARGET_SUPABASE_REF\\s*=\\s*${STAGING_REF}`, "i").test(text)
  );
}

function sqlLit(v: string | null): string {
  if (v == null) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}

async function countPhysicalUnresolved(client: pg.Client): Promise<number> {
  const r = await client.query(`
    SELECT COUNT(*)::int AS c FROM return_items ri
    WHERE ri.deleted_at IS NULL AND ri.package_id IS NOT NULL
      AND NOT (ri.expected_item_id IS NOT NULL AND ri.package_id IS NULL AND ri.pallet_id IS NULL)
      AND ri.resolved_product_id IS NULL
  `);
  return (r.rows[0] as { c: number }).c;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  if (!readApproval()) throw new Error(`Approval missing: ${APPROVAL_PATH}`);

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (
    !dbUrl ||
    getStagingProjectRef({ loadEnv: false }) !== STAGING_REF ||
    !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)
  ) {
    throw new Error("Staging ref guard failed");
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const beforePhysical = await countPhysicalUnresolved(client);
  const beforeProducts = await client.query(`SELECT COUNT(*)::int AS c FROM products`);

  const pre = await client.query(
    `
    SELECT
      ri.id::text,
      ri.resolved_product_id::text,
      ri.resolved_catalog_product_id::text,
      ri.identifier_resolution_status,
      ri.identifier_resolution_confidence,
      ri.expected_item_id::text,
      ri.sku,
      ri.fnsku,
      ri.asin,
      ep.resolved_product_id::text AS ep_resolved_product_id,
      (
        SELECT COUNT(DISTINCT m.product_id)::int
        FROM product_identifier_map m
        WHERE m.deleted_at IS NULL
          AND m.organization_id = ri.organization_id
          AND m.store_id = ri.store_id
          AND (
            (NULLIF(btrim(ri.fnsku),'') IS NOT NULL AND upper(btrim(m.fnsku))=upper(btrim(ri.fnsku)))
            OR (NULLIF(btrim(ri.sku),'') IS NOT NULL AND upper(btrim(m.seller_sku))=upper(btrim(ri.sku)))
          )
      ) AS map_product_count,
      (
        SELECT MIN(m.product_id::text)
        FROM product_identifier_map m
        WHERE m.deleted_at IS NULL
          AND m.organization_id = ri.organization_id
          AND m.store_id = ri.store_id
          AND (
            (NULLIF(btrim(ri.fnsku),'') IS NOT NULL AND upper(btrim(m.fnsku))=upper(btrim(ri.fnsku)))
            OR (NULLIF(btrim(ri.sku),'') IS NOT NULL AND upper(btrim(m.seller_sku))=upper(btrim(ri.sku)))
          )
      ) AS map_product_id
    FROM return_items ri
    LEFT JOIN expected_packages ep ON ep.id = ri.expected_item_id
    WHERE ri.id = $1::uuid AND ri.deleted_at IS NULL
    `,
    [TARGET_RI],
  );

  const row = pre.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error(`return_item ${TARGET_RI} not found`);

  const blockers: string[] = [];
  if (row.resolved_product_id) blockers.push("already_resolved");
  if (!row.expected_item_id) blockers.push("missing_expected_item_id");
  if (!row.ep_resolved_product_id) blockers.push("ep_unresolved");
  if (Number(row.map_product_count) !== 1) blockers.push(`map_product_count=${row.map_product_count}`);
  if (String(row.map_product_id) !== String(row.ep_resolved_product_id)) {
    blockers.push("map_product_id_ne_ep_resolved_product_id");
  }

  const preimage = { before_physical_unresolved: beforePhysical, row, blockers };
  fs.writeFileSync(path.join(outDir, "preimage.json"), JSON.stringify(preimage, null, 2));

  if (blockers.length > 0) {
    await client.end();
    throw new Error(`Pre-flight blockers: ${blockers.join("; ")}`);
  }

  const targetProductId = String(row.ep_resolved_product_id);

  let applied = false;
  if (apply) {
    const upd = await client.query(
      `
      UPDATE public.return_items ri
      SET
        resolved_product_id = ep.resolved_product_id,
        identifier_resolution_status = 'resolved',
        identifier_resolution_confidence = 1.0,
        updated_at = now()
      FROM public.expected_packages ep
      WHERE ri.id = $1::uuid
        AND ri.deleted_at IS NULL
        AND ri.resolved_product_id IS NULL
        AND ri.expected_item_id = ep.id
        AND ep.resolved_product_id IS NOT NULL
        AND ep.resolved_product_id = $2::uuid
      RETURNING ri.id::text, ri.resolved_product_id::text, ri.identifier_resolution_status
      `,
      [TARGET_RI, targetProductId],
    );
    applied = (upd.rowCount ?? 0) === 1;
  }

  const afterPhysical = await countPhysicalUnresolved(client);
  const afterProducts = await client.query(`SELECT COUNT(*)::int AS c FROM products`);

  const rollback = `-- Rollback phase1 physical RI linkage fix
UPDATE public.return_items SET
  resolved_product_id = ${row.resolved_product_id ? `${sqlLit(String(row.resolved_product_id))}::uuid` : "NULL"},
  resolved_catalog_product_id = ${row.resolved_catalog_product_id ? `${sqlLit(String(row.resolved_catalog_product_id))}::uuid` : "NULL"},
  identifier_resolution_status = ${sqlLit(row.identifier_resolution_status as string | null)},
  identifier_resolution_confidence = ${row.identifier_resolution_confidence ?? "NULL"},
  updated_at = now()
WHERE id = ${sqlLit(TARGET_RI)}::uuid;
`;
  fs.writeFileSync(path.join(outDir, "rollback.sql"), rollback);

  const verification = {
    applied,
    return_item_id: TARGET_RI,
    resolved_product_id: targetProductId,
    physical_unresolved_before: beforePhysical,
    physical_unresolved_after: afterPhysical,
    products_before: (beforeProducts.rows[0] as { c: number }).c,
    products_after: (afterProducts.rows[0] as { c: number }).c,
    product_count_unchanged:
      (beforeProducts.rows[0] as { c: number }).c === (afterProducts.rows[0] as { c: number }).c,
  };
  fs.writeFileSync(path.join(outDir, "verification.json"), JSON.stringify(verification, null, 2));

  await client.end();

  const manifest = {
    prompt: "PHASE1-PHYSICAL-RI-LINKAGE-FIX-EXECUTE",
    run_id: runId,
    audit_run_id: AUDIT_RUN,
    mode: apply ? "apply" : "dry-run",
    status: apply && applied && verification.product_count_unchanged ? "PASS" : apply ? "FAIL" : "DRY-RUN",
    verification,
    rollback_path: `${OUT_BASE}/${runId}/rollback.sql`,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
