/**
 * ORIGINAL-DEMO-DATA-PARITY — read-only census (staging scope vs original conflicts).
 *   npx tsx scripts/original-demo-data-parity-census.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const OUT_BASE = ".cursor/audit-reports/original-demo-data-parity";

const CLAIMABLE = [
  "damaged_product", "scratched", "wrong_item", "wrong_item_different", "wrong_item_junk",
  "expired", "missing_parts", "missing_item", "empty_box", "damaged_box", "damaged_warehouse",
  "damaged_customer", "damaged_carrier", "wet", "counterfeit_suspect", "operator_other",
];

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function refFromPgUrl(url: string): string | null {
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? refFromSupabaseUrl(url);
}

async function q<T extends pg.QueryResultRow>(client: pg.Client, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query<T>(sql, params)).rows;
}

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const r = await q<{ e: boolean }>(client, `SELECT to_regclass($1) IS NOT NULL AS e`, [`public.${table}`]);
  return Boolean(r[0]?.e);
}

async function count(client: pg.Client, table: string, where = "TRUE"): Promise<number> {
  if (!(await tableExists(client, table))) return -1;
  const r = await q<{ c: string }>(client, `SELECT count(*)::bigint AS c FROM public.${table} WHERE ${where}`);
  return Number(r[0]?.c ?? 0);
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (refFromPgUrl(stagingUrl) !== STAGING_REF) throw new Error("staging ref mismatch");
  if (refFromPgUrl(originalUrl) !== ORIGINAL_REF) throw new Error("original ref mismatch");

  const stag = new pg.Client({ connectionString: stagingUrl });
  const orig = new pg.Client({ connectionString: originalUrl });
  await stag.connect();
  await orig.connect();

  const manifest: Record<string, unknown> = { run_id: rid, org_id: ORG_ID };

  // Staging demo scope: active org rows
  const stagingReturnItems = await q(
    stag,
    `SELECT id::text, package_id::text, pallet_id::text, expected_item_id::text,
            product_id::text, resolved_product_id::text, resolved_catalog_product_id::text,
            sku, fnsku, asin, conditions, deleted_at::text
     FROM return_items
     WHERE organization_id = $1::uuid AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [ORG_ID],
  );
  manifest.staging_return_items = stagingReturnItems;

  const stagingPackages = await q(
    stag,
    `SELECT id::text, pallet_id::text, package_code, tracking_number, id_slip_contents,
            status, deleted_at::text
     FROM packages
     WHERE organization_id = $1::uuid AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [ORG_ID],
  );
  manifest.staging_packages = stagingPackages;

  const stagingPallets = await q(
    stag,
    `SELECT id::text, pallet_number, tracking_number, status, deleted_at::text
     FROM pallets
     WHERE organization_id = $1::uuid AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [ORG_ID],
  );
  manifest.staging_pallets = stagingPallets;

  const pkgIds = stagingPackages.map((p) => p.id);
  const palletIds = stagingPallets.map((p) => p.id);
  const riIds = stagingReturnItems.map((r) => r.id);

  const stagingSlip = pkgIds.length
    ? await q(stag, `SELECT * FROM slip_contents WHERE package_id = ANY($1::uuid[])`, [pkgIds])
    : [];
  manifest.staging_slip_contents_count = stagingSlip.length;

  const trackings = [
    ...new Set(
      [...stagingPackages, ...stagingPallets]
        .map((r) => String(r.tracking_number ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const stagingEp = trackings.length
    ? await q(
        stag,
        `SELECT id::text, tracking_number, id_slip_contents, sku, fnsku,
                organization_id::text, store_id::text
         FROM expected_packages
         WHERE organization_id = $1::uuid
           AND (tracking_number = ANY($2::text[])
                OR id_slip_contents IN (
                  SELECT DISTINCT id_slip_contents FROM packages
                  WHERE organization_id = $1::uuid AND deleted_at IS NULL AND id_slip_contents IS NOT NULL
                ))`,
        [ORG_ID, trackings],
      )
    : [];
  manifest.staging_expected_packages = stagingEp;

  const epIds = [
    ...new Set(
      stagingReturnItems
        .map((r) => r.expected_item_id)
        .filter((id): id is string => !!id),
    ),
    ...stagingEp.map((e) => e.id),
  ];

  const stagingClaimLines = riIds.length
    ? await q(
        stag,
        `SELECT id::text, return_item_id::text, claim_case_id::text, line_grain, status, idempotency_key
         FROM claim_lines WHERE organization_id = $1::uuid AND return_item_id = ANY($2::uuid[])`,
        [ORG_ID, riIds],
      )
    : [];
  manifest.staging_claim_lines = stagingClaimLines;

  const caseIds = [...new Set(stagingClaimLines.map((l) => l.claim_case_id).filter(Boolean))];
  const stagingClaimCases = caseIds.length
    ? await q(stag, `SELECT * FROM claim_cases WHERE id = ANY($1::uuid[])`, [caseIds])
    : [];
  manifest.staging_claim_cases = stagingClaimCases;

  const stagingSubs = riIds.length
    ? await q(
        stag,
        `SELECT id::text, return_id::text, status, report_url, claim_amount
         FROM claim_submissions WHERE organization_id = $1::uuid AND return_id = ANY($2::uuid[])`,
        [ORG_ID, riIds],
      )
    : [];
  manifest.staging_claim_submissions = stagingSubs;

  const productIds = [
    ...new Set(
      [
        ...stagingReturnItems.map((r) => r.resolved_product_id),
        ...stagingReturnItems.map((r) => r.product_id),
      ].filter((id): id is string => !!id),
    ),
  ];
  manifest.staging_product_ids_needed = productIds;

  // Original counts
  manifest.original_counts = {
    return_items_active: await count(orig, "return_items", `organization_id = '${ORG_ID}'::uuid AND deleted_at IS NULL`),
    packages_active: await count(orig, "packages", `organization_id = '${ORG_ID}'::uuid AND deleted_at IS NULL`),
    pallets_active: await count(orig, "pallets", `organization_id = '${ORG_ID}'::uuid AND deleted_at IS NULL`),
    slip_contents: pkgIds.length
      ? (
          await q<{ c: string }>(
            orig,
            `SELECT count(*)::bigint c FROM slip_contents WHERE package_id = ANY($1::uuid[])`,
            [pkgIds],
          )
        )[0]?.c
      : 0,
    claim_lines: await count(orig, "claim_lines", `organization_id = '${ORG_ID}'::uuid`),
    claim_cases: await count(orig, "claim_cases", `organization_id = '${ORG_ID}'::uuid`),
    claim_submissions: await count(orig, "claim_submissions", `organization_id = '${ORG_ID}'::uuid`),
  };

  // ID overlap
  manifest.id_overlap = {
    return_items: riIds.filter((id) =>
      stagingReturnItems.some((s) => s.id === id),
    ).length,
    packages_same_id: pkgIds.filter(async () => false),
  };
  const origRiIds = new Set(
    (await q<{ id: string }>(orig, `SELECT id::text FROM return_items WHERE organization_id = $1`, [ORG_ID])).map(
      (r) => r.id,
    ),
  );
  manifest.id_overlap = {
    return_items_in_both: riIds.filter((id) => origRiIds.has(id)).length,
    return_items_staging_only: riIds.filter((id) => !origRiIds.has(id)).length,
    packages_in_both: pkgIds.filter(
      (id) =>
        stagingPackages.some((p) => p.id === id) &&
        true,
    ).length,
  };
  const origPkgIds = new Set(
    (await q<{ id: string }>(orig, `SELECT id::text FROM packages WHERE organization_id = $1`, [ORG_ID])).map(
      (r) => r.id,
    ),
  );
  manifest.id_overlap = {
    ...(manifest.id_overlap as object),
    return_items_in_both: riIds.filter((id) => origRiIds.has(id)).length,
    return_items_staging_only: riIds.filter((id) => !origRiIds.has(id)).length,
    packages_in_both: pkgIds.filter((id) => origPkgIds.has(id)).length,
    packages_staging_only: pkgIds.filter((id) => !origPkgIds.has(id)).length,
  };

  // Duplicate keys on original (different id, same tracking/package_code)
  const dupTracking = await q(
    orig,
    `SELECT tracking_number, count(*)::int n, array_agg(id::text) ids
     FROM packages
     WHERE organization_id = $1::uuid AND deleted_at IS NULL AND tracking_number IS NOT NULL AND tracking_number <> ''
     GROUP BY tracking_number HAVING count(*) > 1`,
    [ORG_ID],
  );
  const dupPackageCode = await q(
    orig,
    `SELECT package_code, count(*)::int n, array_agg(id::text) ids
     FROM packages
     WHERE organization_id = $1::uuid AND deleted_at IS NULL AND package_code IS NOT NULL AND package_code <> ''
     GROUP BY package_code HAVING count(*) > 1`,
    [ORG_ID],
  );
  manifest.original_duplicate_keys = { tracking_number: dupTracking, package_code: dupPackageCode };

  // Staging tracking codes vs original conflicts
  const stagingTrackings = stagingPackages
    .map((p) => ({ tracking: String(p.tracking_number ?? "").trim(), id: p.id, package_code: p.package_code }))
    .filter((x) => x.tracking);
  const conflicts: unknown[] = [];
  for (const st of stagingTrackings) {
    const origRows = await q(
      orig,
      `SELECT id::text, tracking_number, package_code FROM packages
       WHERE organization_id = $1::uuid AND deleted_at IS NULL
         AND (tracking_number = $2 OR package_code = $3)
         AND id <> $4::uuid`,
      [ORG_ID, st.tracking, st.package_code ?? "", st.id],
    );
    if (origRows.length) conflicts.push({ staging: st, original_conflicts: origRows });
  }
  manifest.tracking_package_conflicts = conflicts;

  // Draft pool counts
  const poolSql = `
    ri.deleted_at IS NULL AND ri.organization_id = $1::uuid
    AND ri.package_id IS NOT NULL
    AND NOT (ri.expected_item_id IS NOT NULL AND ri.package_id IS NULL AND ri.pallet_id IS NULL)
    AND ri.conditions && $2::text[]`;
  for (const [label, client] of [
    ["staging", stag],
    ["original", orig],
  ] as const) {
    const r = await q<{ n: number }>(
      client,
      `SELECT count(*)::int n FROM return_items ri WHERE ${poolSql}`,
      [ORG_ID, CLAIMABLE],
    );
    manifest[`${label}_draft_pool_count`] = r[0]?.n ?? 0;
  }

  // Product linkage gaps on original for staging RI
  const linkageGaps: unknown[] = [];
  for (const ri of stagingReturnItems.slice(0, 50)) {
    const gaps: string[] = [];
    if (ri.resolved_product_id) {
      const ex = await q(orig, `SELECT 1 FROM products WHERE id = $1::uuid`, [ri.resolved_product_id]);
      if (!ex.length) gaps.push("missing_resolved_product");
    }
    if (ri.expected_item_id) {
      const ex = await q(orig, `SELECT 1 FROM expected_packages WHERE id = $1::uuid`, [ri.expected_item_id]);
      if (!ex.length) gaps.push("missing_expected_item");
    }
    if (gaps.length) linkageGaps.push({ return_item_id: ri.id, gaps });
  }
  manifest.original_linkage_gaps_for_staging_rows = linkageGaps;

  // Column lists for copy
  for (const t of ["return_items", "packages", "pallets", "slip_contents", "expected_packages", "products"]) {
    const cols = await q<{ column_name: string }>(
      stag,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      [t],
    );
    manifest[`${t}_columns`] = cols.map((c) => c.column_name);
  }

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: true, run_id: rid, outDir, summary: {
    staging_ri: stagingReturnItems.length,
    staging_pkg: stagingPackages.length,
    staging_pallet: stagingPallets.length,
    staging_ep: stagingEp.length,
    staging_claim_cases: stagingClaimCases.length,
    staging_claim_lines: stagingClaimLines.length,
    staging_subs: stagingSubs.length,
    product_ids_needed: productIds.length,
    conflicts: conflicts.length,
    staging_draft_pool: manifest.staging_draft_pool_count,
    original_draft_pool: manifest.original_draft_pool_count,
  }}));

  await stag.end();
  await orig.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
