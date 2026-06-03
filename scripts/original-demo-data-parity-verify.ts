/**
 * Post-apply verify: staging vs original scoped demo rows.
 *   npx tsx scripts/original-demo-data-parity-verify.ts
 */
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const CLAIMABLE = [
  "damaged_product", "scratched", "wrong_item", "wrong_item_different", "wrong_item_junk",
  "expired", "missing_parts", "missing_item", "empty_box", "damaged_box", "damaged_warehouse",
  "damaged_customer", "damaged_carrier", "wet", "counterfeit_suspect", "operator_other",
];

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const stag = new pg.Client({ connectionString: process.env.STAGING_DIRECT_POSTGRES_URL });
  const orig = new pg.Client({ connectionString: process.env.ORIGINAL_DIRECT_POSTGRES_URL });
  await stag.connect();
  await orig.connect();

  const riIds = (
    await stag.query(
      `SELECT id::text FROM return_items WHERE organization_id = $1::uuid AND deleted_at IS NULL`,
      [ORG_ID],
    )
  ).rows.map((r) => r.id as string);

  const pkgIds = [
    ...new Set(
      (
        await stag.query(`SELECT id::text FROM packages WHERE organization_id = $1::uuid`, [ORG_ID])
      ).rows.map((r) => r.id as string),
    ),
  ];

  const mismatches: unknown[] = [];
  for (const id of riIds) {
    const s = await stag.query(
      `SELECT expected_item_id::text, resolved_product_id::text, package_id::text, pallet_id::text
       FROM return_items WHERE id = $1::uuid`,
      [id],
    );
    const o = await orig.query(
      `SELECT expected_item_id::text, resolved_product_id::text, package_id::text, pallet_id::text
       FROM return_items WHERE id = $1::uuid`,
      [id],
    );
    if (!o.rows.length) {
      mismatches.push({ table: "return_items", id, issue: "missing_on_original" });
      continue;
    }
    const sr = s.rows[0];
    const or = o.rows[0];
    for (const k of ["expected_item_id", "resolved_product_id", "package_id", "pallet_id"]) {
      if (String(sr[k] ?? "") !== String(or[k] ?? "")) {
        mismatches.push({ table: "return_items", id, field: k, staging: sr[k], original: or[k] });
      }
    }
  }

  for (const id of pkgIds) {
    const s = await stag.query(
      `SELECT tracking_number, package_code, deleted_at::text, pallet_id::text FROM packages WHERE id = $1::uuid`,
      [id],
    );
    const o = await orig.query(
      `SELECT tracking_number, package_code, deleted_at::text, pallet_id::text FROM packages WHERE id = $1::uuid`,
      [id],
    );
    if (!o.rows.length) {
      mismatches.push({ table: "packages", id, issue: "missing_on_original" });
      continue;
    }
    const sr = s.rows[0];
    const or = o.rows[0];
    for (const k of ["tracking_number", "package_code", "pallet_id"]) {
      if (String(sr[k] ?? "") !== String(or[k] ?? "")) {
        mismatches.push({ table: "packages", id, field: k, staging: sr[k], original: or[k] });
      }
    }
  }

  const poolSql = `
    SELECT count(*)::int AS n FROM return_items ri
    WHERE ri.deleted_at IS NULL AND ri.organization_id = $1::uuid
      AND ri.package_id IS NOT NULL
      AND NOT (ri.expected_item_id IS NOT NULL AND ri.package_id IS NULL AND ri.pallet_id IS NULL)
      AND ri.conditions && $2::text[]`;

  const dup = await orig.query(
    `SELECT tracking_number, count(*)::int AS n
     FROM packages
     WHERE organization_id = $1::uuid AND deleted_at IS NULL
       AND tracking_number IS NOT NULL AND tracking_number <> ''
     GROUP BY tracking_number HAVING count(*) > 1`,
    [ORG_ID],
  );

  const policy = await orig.query(
    `SELECT claim_policy FROM organization_settings WHERE organization_id = $1::uuid`,
    [ORG_ID],
  );

  const fkOrphans = await orig.query(
    `SELECT ri.id::text
     FROM return_items ri
     WHERE ri.organization_id = $1::uuid AND ri.deleted_at IS NULL
       AND (
         (ri.expected_item_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM expected_packages ep WHERE ep.id = ri.expected_item_id
         ))
         OR (ri.resolved_product_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM products p WHERE p.id = ri.resolved_product_id
         ))
       )`,
    [ORG_ID],
  );

  const caseCount = await orig.query(
    `SELECT count(*)::int AS n FROM claim_cases WHERE organization_id = $1::uuid`,
    [ORG_ID],
  );

  console.log(
    JSON.stringify(
      {
        ok: mismatches.length === 0 && dup.rows.length === 0 && fkOrphans.rows.length === 0,
        ri_count: riIds.length,
        pkg_scope: pkgIds.length,
        mismatches,
        draft_pool_staging: (await stag.query(poolSql, [ORG_ID, CLAIMABLE])).rows[0]?.n,
        draft_pool_original: (await orig.query(poolSql, [ORG_ID, CLAIMABLE])).rows[0]?.n,
        duplicate_tracking: dup.rows,
        fk_orphans: fkOrphans.rows,
        claim_cases: caseCount.rows[0]?.n,
        claim_policy: policy.rows[0]?.claim_policy,
      },
      null,
      2,
    ),
  );

  await stag.end();
  await orig.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
