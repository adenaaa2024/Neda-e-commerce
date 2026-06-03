/**
 * ORIGINAL-DEMO-DATA-PARITY-APPLY — scoped staging → original demo flow data replace.
 *
 *   npx tsx scripts/original-demo-data-parity-apply.ts          # dry-run
 *   npx tsx scripts/original-demo-data-parity-apply.ts --apply  # execute
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

async function cols(client: pg.Client, table: string): Promise<string[]> {
  const r = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map((x) => x.column_name);
}

async function intersectCols(stag: pg.Client, orig: pg.Client, table: string): Promise<string[]> {
  const s = await cols(stag, table);
  const o = new Set(await cols(orig, table));
  return s.filter((c) => o.has(c));
}

type Scope = {
  returnItemIds: string[];
  packageIds: string[];
  palletIds: string[];
  expectedPackageIds: string[];
  productIds: string[];
  claimCaseIds: string[];
  claimLineIds: string[];
  claimSubmissionIds: string[];
  slipContentIds: string[];
  pimMapIds: string[];
};

async function buildScope(stag: pg.Client): Promise<Scope> {
  const riRows = await stag.query(
    `SELECT id::text, package_id::text, pallet_id::text, expected_item_id::text,
            resolved_product_id::text, product_id::text, fnsku, sku, asin
     FROM return_items WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
    [ORG_ID],
  );
  const returnItemIds = riRows.rows.map((r) => r.id as string);
  const packageIds = [
    ...new Set(riRows.rows.map((r) => r.package_id).filter(Boolean) as string[]),
  ];
  const palletIds = [
    ...new Set(riRows.rows.map((r) => r.pallet_id).filter(Boolean) as string[]),
  ];

  // Include all org pallets/packages referenced in staging demo (active staging list)
  const palAll = await stag.query(`SELECT id::text FROM pallets WHERE organization_id=$1::uuid AND deleted_at IS NULL`, [
    ORG_ID,
  ]);
  for (const r of palAll.rows) if (!palletIds.includes(r.id)) palletIds.push(r.id);

  const pkgAll = await stag.query(`SELECT id::text, tracking_number FROM packages WHERE organization_id=$1::uuid`, [ORG_ID]);
  for (const r of pkgAll.rows) if (!packageIds.includes(r.id)) packageIds.push(r.id);

  const palTrack = await stag.query(
    `SELECT DISTINCT tracking_number FROM pallets
     WHERE organization_id=$1::uuid AND tracking_number IS NOT NULL AND tracking_number <> ''`,
    [ORG_ID],
  );
  const trackings = [
    ...new Set([
      ...pkgAll.rows.map((r) => String(r.tracking_number ?? "").trim()).filter(Boolean),
      ...palTrack.rows.map((r) => String(r.tracking_number ?? "").trim()).filter(Boolean),
    ]),
  ];

  const expectedFromRi = riRows.rows.map((r) => r.expected_item_id).filter(Boolean) as string[];
  const epRows = await stag.query(
    `SELECT id::text FROM expected_packages
     WHERE organization_id=$1::uuid AND (
       id = ANY($2::uuid[])
       OR tracking_number = ANY($3::text[])
       OR id_slip_contents IN (
         SELECT DISTINCT id_slip_contents FROM packages
         WHERE organization_id=$1::uuid AND id_slip_contents IS NOT NULL
       )
     )`,
    [ORG_ID, expectedFromRi, trackings],
  );
  let expectedPackageIds = [...new Set(epRows.rows.map((r) => r.id as string))];
  // Include parent expected_packages for FK chain
  for (let i = 0; i < 5; i++) {
    const parents = await stag.query(
      `SELECT DISTINCT parent_expected_package_id::text AS id
       FROM expected_packages
       WHERE id = ANY($1::uuid[]) AND parent_expected_package_id IS NOT NULL`,
      [expectedPackageIds],
    );
    let added = false;
    for (const r of parents.rows) {
      if (r.id && !expectedPackageIds.includes(r.id)) {
        expectedPackageIds.push(r.id);
        added = true;
      }
    }
    if (!added) break;
  }

  const productIds = [
    ...new Set(
      riRows.rows.flatMap((r) => [r.resolved_product_id, r.product_id].filter(Boolean) as string[]),
    ),
  ];

  const clRows = returnItemIds.length
    ? await stag.query(
        `SELECT id::text, claim_case_id::text FROM claim_lines
         WHERE organization_id=$1::uuid AND return_item_id = ANY($2::uuid[])`,
        [ORG_ID, returnItemIds],
      )
    : { rows: [] };
  const claimLineIds = clRows.rows.map((r) => r.id as string);
  const claimCaseIds = [...new Set(clRows.rows.map((r) => r.claim_case_id).filter(Boolean) as string[])];

  const subRows = returnItemIds.length
    ? await stag.query(
        `SELECT id::text FROM claim_submissions
         WHERE organization_id=$1::uuid AND return_id = ANY($2::uuid[])`,
        [ORG_ID, returnItemIds],
      )
    : { rows: [] };
  const claimSubmissionIds = subRows.rows.map((r) => r.id as string);

  const slipRows = packageIds.length
    ? await stag.query(`SELECT id::text FROM slip_contents WHERE package_id = ANY($1::uuid[])`, [packageIds])
    : { rows: [] };
  const slipContentIds = slipRows.rows.map((r) => r.id as string);

  const fnskus = [...new Set(riRows.rows.map((r) => r.fnsku).filter(Boolean) as string[])];
  const skus = [...new Set(riRows.rows.map((r) => r.sku).filter(Boolean) as string[])];
  const asins = [...new Set(riRows.rows.map((r) => r.asin).filter(Boolean) as string[])];

  const pimRows = productIds.length
    ? await stag.query(
        `SELECT id::text FROM product_identifier_map
         WHERE organization_id=$1::uuid AND (
           product_id = ANY($2::uuid[])
           OR fnsku = ANY($3::text[])
           OR seller_sku = ANY($4::text[])
           OR asin = ANY($5::text[])
         )`,
        [ORG_ID, productIds, fnskus, skus, asins],
      )
    : { rows: [] };
  const pimMapIds = pimRows.rows.map((r) => r.id as string);

  return {
    returnItemIds,
    packageIds,
    palletIds,
    expectedPackageIds,
    productIds,
    claimCaseIds,
    claimLineIds,
    claimSubmissionIds,
    slipContentIds,
    pimMapIds,
    trackings,
  };
}

async function copyTableByIds(
  stag: pg.Client,
  orig: pg.Client,
  table: string,
  ids: string[],
  stats: Record<string, { inserted: number; updated: number }>,
  sortIds?: (ids: string[], stag: pg.Client) => Promise<string[]>,
): Promise<void> {
  if (!ids.length) return;
  const ordered = sortIds ? await sortIds(ids, stag) : ids;
  const useCols = await intersectCols(stag, orig, table);
  if (!useCols.includes("id")) throw new Error(`${table}: missing id column`);
  const colList = useCols.map((c) => `"${c}"`).join(", ");
  const placeholders = useCols.map((_, i) => `$${i + 1}`).join(", ");
  const updates = useCols.filter((c) => c !== "id").map((c) => `"${c}"=EXCLUDED."${c}"`).join(", ");

  stats[table] = stats[table] ?? { inserted: 0, updated: 0 };

  async function fkExists(tableName: string, id: unknown): Promise<boolean> {
    if (!id) return false;
    const r = await orig.query(`SELECT 1 FROM public.${tableName} WHERE id = $1::uuid`, [id]);
    return r.rows.length > 0;
  }

  for (const id of ordered) {
    const src = await stag.query(`SELECT ${colList} FROM public.${table} WHERE id=$1::uuid`, [id]);
    if (!src.rows.length) continue;
    const row = { ...src.rows[0] } as Record<string, unknown>;

    if (table === "expected_packages") {
      if (row.upload_id && !(await fkExists("raw_report_uploads", row.upload_id))) {
        row.upload_id = null;
      }
      if (row.source_staging_id && !(await fkExists("amazon_staging", row.source_staging_id))) {
        row.source_staging_id = null;
      }
      if (row.source_detail_row_id && !(await fkExists("amazon_removals", row.source_detail_row_id))) {
        row.source_detail_row_id = null;
      }
      if (row.source_shipment_row_id && !(await fkExists("amazon_removal_shipments", row.source_shipment_row_id))) {
        row.source_shipment_row_id = null;
      }
    }

    const vals = useCols.map((c) => row[c]);
    const exists = await orig.query(`SELECT 1 FROM public.${table} WHERE id=$1::uuid`, [id]);
    await orig.query(
      `INSERT INTO public.${table} (${colList}) VALUES (${placeholders})
       ON CONFLICT (id) DO UPDATE SET ${updates}`,
      vals,
    );
    if (exists.rows.length) stats[table].updated += 1;
    else stats[table].inserted += 1;
  }
}

async function backupTable(
  orig: pg.Client,
  table: string,
  backupName: string,
  whereSql: string,
  params: unknown[],
): Promise<number> {
  await orig.query(`DROP TABLE IF EXISTS public.${backupName}`);
  await orig.query(
    `CREATE TABLE public.${backupName} AS
     SELECT * FROM public.${table} WHERE ${whereSql}`,
    params,
  );
  const c = await orig.query(`SELECT count(*)::int AS n FROM public.${backupName}`);
  return Number(c.rows[0]?.n ?? 0);
}

async function countWhere(client: pg.Client, table: string, where: string, params: unknown[] = []): Promise<number> {
  const r = await client.query(`SELECT count(*)::int AS n FROM public.${table} WHERE ${where}`, params);
  return Number(r.rows[0]?.n ?? 0);
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, `${rid}-apply`);
  fs.mkdirSync(outDir, { recursive: true });

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (refFromPgUrl(stagingUrl) !== STAGING_REF) throw new Error("staging ref mismatch");
  if (refFromPgUrl(originalUrl) !== ORIGINAL_REF) throw new Error("original ref mismatch");

  const stag = new pg.Client({ connectionString: stagingUrl });
  const orig = new pg.Client({ connectionString: originalUrl });
  await stag.connect();
  await orig.connect();

  const scope = await buildScope(stag);
  const stats: Record<string, unknown> = {
    run_id: rid,
    apply,
    scope,
    before: {},
    after: {},
    backup_tables: {} as Record<string, number>,
    rows_deleted_scoped: {} as Record<string, number>,
    rows_inserted: {} as Record<string, number>,
    rows_updated: {} as Record<string, number>,
    soft_deleted_extras: {} as Record<string, number>,
  };

  const touchTables = [
    "claim_evidence",
    "claim_case_events",
    "claim_lines",
    "claim_submissions",
    "claim_cases",
    "slip_contents",
    "return_items",
    "packages",
    "pallets",
    "expected_packages",
    "products",
    "product_identifier_map",
  ];

  for (const t of touchTables) {
    (stats.before as Record<string, number>)[t] = await countWhere(orig, t, "organization_id = $1::uuid", [ORG_ID]);
  }
  (stats.before as Record<string, number>).claim_submissions = await countWhere(
    orig,
    "claim_submissions",
    "organization_id = $1::uuid",
    [ORG_ID],
  );

  if (!apply) {
    const origExtraRi = await orig.query(
      `SELECT count(*)::int n FROM return_items
       WHERE organization_id=$1::uuid AND deleted_at IS NULL AND NOT (id = ANY($2::uuid[]))`,
      [ORG_ID, scope.returnItemIds],
    );
    fs.writeFileSync(
      path.join(outDir, "dry_run.json"),
      JSON.stringify({ ...stats, orig_extra_return_items: origExtraRi.rows[0]?.n }, null, 2),
    );
    console.log(JSON.stringify({ ok: true, dry_run: true, outDir, scope, orig_extra_ri: origExtraRi.rows[0]?.n }));
    await stag.end();
    await orig.end();
    return;
  }

  const bkSuffix = rid.replace(/[^0-9A-Za-z]/g, "");
  const backups: string[] = [];

  try {
    await orig.query("BEGIN");

    // Backups
    const backupDefs: { table: string; where: string; params: unknown[] }[] = [
      {
        table: "return_items",
        where: "organization_id = $1::uuid AND (id = ANY($2::uuid[]) OR (deleted_at IS NULL AND NOT (id = ANY($2::uuid[]))))",
        params: [ORG_ID, scope.returnItemIds],
      },
      {
        table: "packages",
        where: "organization_id = $1::uuid AND (id = ANY($2::uuid[]) OR (deleted_at IS NULL AND NOT (id = ANY($2::uuid[]))))",
        params: [ORG_ID, scope.packageIds],
      },
      {
        table: "pallets",
        where: "organization_id = $1::uuid AND (id = ANY($2::uuid[]) OR (deleted_at IS NULL AND NOT (id = ANY($2::uuid[]))))",
        params: [ORG_ID, scope.palletIds],
      },
      {
        table: "expected_packages",
        where: "organization_id = $1::uuid AND id = ANY($2::uuid[])",
        params: [ORG_ID, scope.expectedPackageIds],
      },
      {
        table: "slip_contents",
        where: "organization_id = $1::uuid AND package_id = ANY($2::uuid[])",
        params: [ORG_ID, scope.packageIds],
      },
      {
        table: "claim_cases",
        where: "organization_id = $1::uuid",
        params: [ORG_ID],
      },
      {
        table: "claim_lines",
        where: "organization_id = $1::uuid",
        params: [ORG_ID],
      },
      {
        table: "claim_submissions",
        where: "organization_id = $1::uuid AND return_id = ANY($2::uuid[])",
        params: [ORG_ID, scope.returnItemIds],
      },
      {
        table: "products",
        where: "id = ANY($1::uuid[])",
        params: [scope.productIds],
      },
      {
        table: "product_identifier_map",
        where: "id = ANY($1::uuid[])",
        params: [scope.pimMapIds],
      },
    ];

    for (const b of backupDefs) {
      const name = `_backup_demo_replace_${b.table}_${bkSuffix}`;
      const n = await backupTable(orig, b.table, name, b.where, b.params);
      (stats.backup_tables as Record<string, number>)[name] = n;
      backups.push(name);
    }

    // Delete dependents (scoped demo org claims first)
    if (scope.claimCaseIds.length) {
      const d1 = await orig.query(`DELETE FROM claim_evidence WHERE claim_case_id = ANY($1::uuid[])`, [
        scope.claimCaseIds,
      ]);
      (stats.rows_deleted_scoped as Record<string, number>).claim_evidence = d1.rowCount ?? 0;
    }
    const d2 = await orig.query(`DELETE FROM claim_case_events WHERE organization_id = $1::uuid`, [ORG_ID]);
    (stats.rows_deleted_scoped as Record<string, number>).claim_case_events = d2.rowCount ?? 0;
    const d3 = await orig.query(`DELETE FROM claim_lines WHERE organization_id = $1::uuid`, [ORG_ID]);
    (stats.rows_deleted_scoped as Record<string, number>).claim_lines = d3.rowCount ?? 0;
    const d4 = await orig.query(
      `DELETE FROM claim_submissions WHERE organization_id = $1::uuid AND return_id = ANY($2::uuid[])`,
      [ORG_ID, scope.returnItemIds],
    );
    (stats.rows_deleted_scoped as Record<string, number>).claim_submissions = d4.rowCount ?? 0;
    const d5 = await orig.query(`DELETE FROM claim_cases WHERE organization_id = $1::uuid`, [ORG_ID]);
    (stats.rows_deleted_scoped as Record<string, number>).claim_cases = d5.rowCount ?? 0;

    // Slip contents for demo packages
    const d6 = await orig.query(`DELETE FROM slip_contents WHERE package_id = ANY($1::uuid[])`, [scope.packageIds]);
    (stats.rows_deleted_scoped as Record<string, number>).slip_contents = d6.rowCount ?? 0;

    // Copy parents first
    const copyStats: Record<string, { inserted: number; updated: number }> = {};
    await copyTableByIds(stag, orig, "products", scope.productIds, copyStats);
    await copyTableByIds(stag, orig, "product_identifier_map", scope.pimMapIds, copyStats);

    if (scope.expectedPackageIds.length) {
      const stagingEps = await stag.query(`SELECT * FROM expected_packages WHERE id = ANY($1::uuid[])`, [
        scope.expectedPackageIds,
      ]);
      const trackingsForEp = [
        ...new Set(stagingEps.rows.map((r) => r.tracking_number).filter(Boolean) as string[]),
      ];
      const dEpById = await orig.query(
        `DELETE FROM expected_packages
         WHERE organization_id = $1::uuid
           AND (id = ANY($2::uuid[]) OR tracking_number = ANY($3::text[]))`,
        [ORG_ID, scope.expectedPackageIds, trackingsForEp],
      );
      let dEpKeys = 0;
      for (const row of stagingEps.rows) {
        if (!row.source_detail_row_id || !row.allocation_group_key) continue;
        const dk = await orig.query(
          `DELETE FROM expected_packages
           WHERE organization_id = $1::uuid
             AND source_detail_row_id = $2::uuid
             AND allocation_group_key = $3
             AND id <> $4::uuid`,
          [ORG_ID, row.source_detail_row_id, row.allocation_group_key, row.id],
        );
        dEpKeys += dk.rowCount ?? 0;
      }
      (stats.rows_deleted_scoped as Record<string, number>).expected_packages =
        (dEpById.rowCount ?? 0) + dEpKeys;
    }
    await copyTableByIds(stag, orig, "expected_packages", scope.expectedPackageIds, copyStats, async (ids, s) => {
      const rows = await s.query(
        `SELECT id::text, parent_expected_package_id::text FROM expected_packages WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      const byId = new Map(rows.rows.map((r) => [r.id as string, r.parent_expected_package_id as string | null]));
      const sorted: string[] = [];
      const visiting = new Set<string>();
      const visit = (id: string) => {
        if (sorted.includes(id) || visiting.has(id)) return;
        visiting.add(id);
        const p = byId.get(id);
        if (p && ids.includes(p)) visit(p);
        sorted.push(id);
        visiting.delete(id);
      };
      for (const id of ids) visit(id);
      return sorted;
    });
    await copyTableByIds(stag, orig, "pallets", scope.palletIds, copyStats);
    await copyTableByIds(stag, orig, "packages", scope.packageIds, copyStats);
    await copyTableByIds(stag, orig, "slip_contents", scope.slipContentIds, copyStats);
    await copyTableByIds(stag, orig, "return_items", scope.returnItemIds, copyStats);

    // claim_cases ↔ claim_lines circular FK: cases first with primary_claim_line_id null, then lines, then patch
    if (scope.claimCaseIds.length) {
      const caseCols = await intersectCols(stag, orig, "claim_cases");
      const caseList = caseCols.map((c) => `"${c}"`).join(", ");
      const casePh = caseCols.map((_, i) => `$${i + 1}`).join(", ");
      const caseUp = caseCols
        .filter((c) => c !== "id" && c !== "primary_claim_line_id")
        .map((c) => `"${c}"=EXCLUDED."${c}"`)
        .join(", ");
      copyStats.claim_cases = { inserted: 0, updated: 0 };
      for (const id of scope.claimCaseIds) {
        const src = await stag.query(`SELECT ${caseList} FROM claim_cases WHERE id=$1::uuid`, [id]);
        if (!src.rows.length) continue;
        const row = { ...src.rows[0], primary_claim_line_id: null };
        const vals = caseCols.map((c) => (c === "primary_claim_line_id" ? null : row[c]));
        const ex = await orig.query(`SELECT 1 FROM claim_cases WHERE id=$1::uuid`, [id]);
        await orig.query(
          `INSERT INTO claim_cases (${caseList}) VALUES (${casePh})
           ON CONFLICT (id) DO UPDATE SET ${caseUp}, primary_claim_line_id=NULL`,
          vals,
        );
        if (ex.rows.length) copyStats.claim_cases.updated += 1;
        else copyStats.claim_cases.inserted += 1;
      }
    }

    await copyTableByIds(stag, orig, "claim_lines", scope.claimLineIds, copyStats);

    for (const id of scope.claimCaseIds) {
      const src = await stag.query(
        `SELECT primary_claim_line_id::text FROM claim_cases WHERE id=$1::uuid`,
        [id],
      );
      const pl = src.rows[0]?.primary_claim_line_id;
      if (pl) {
        await orig.query(`UPDATE claim_cases SET primary_claim_line_id = $2::uuid WHERE id = $1::uuid`, [id, pl]);
      }
    }

    await copyTableByIds(stag, orig, "claim_submissions", scope.claimSubmissionIds, copyStats);

    // claim_case_events from staging for cases
    if (scope.claimCaseIds.length) {
      const evCols = await intersectCols(stag, orig, "claim_case_events");
      const evList = evCols.map((c) => `"${c}"`).join(", ");
      const evSrc = await stag.query(
        `SELECT ${evList} FROM claim_case_events WHERE claim_case_id = ANY($1::uuid[])`,
        [scope.claimCaseIds],
      );
      const ph = evCols.map((_, i) => `$${i + 1}`).join(", ");
      const evUp = evCols.filter((c) => c !== "id").map((c) => `"${c}"=EXCLUDED."${c}"`).join(", ");
      copyStats.claim_case_events = { inserted: 0, updated: 0 };
      for (const row of evSrc.rows) {
        const vals = evCols.map((c) => row[c]);
        const ex = await orig.query(`SELECT 1 FROM claim_case_events WHERE id=$1::uuid`, [row.id]);
        await orig.query(
          `INSERT INTO claim_case_events (${evList}) VALUES (${ph}) ON CONFLICT (id) DO UPDATE SET ${evUp}`,
          vals,
        );
        if (ex.rows.length) copyStats.claim_case_events.updated += 1;
        else copyStats.claim_case_events.inserted += 1;
      }
    }

    stats.rows_inserted = Object.fromEntries(
      Object.entries(copyStats).map(([k, v]) => [k, v.inserted]),
    );
    stats.rows_updated = Object.fromEntries(Object.entries(copyStats).map(([k, v]) => [k, v.updated]));

    // Soft-delete original-only fake demo rows (not in staging scope)
    const now = new Date().toISOString();
    const sdRi = await orig.query(
      `UPDATE return_items SET deleted_at = $3, updated_at = $3
       WHERE organization_id = $1::uuid AND deleted_at IS NULL AND NOT (id = ANY($2::uuid[]))`,
      [ORG_ID, scope.returnItemIds, now],
    );
    (stats.soft_deleted_extras as Record<string, number>).return_items = sdRi.rowCount ?? 0;

    const sdPkg = await orig.query(
      `UPDATE packages SET deleted_at = $3, updated_at = $3
       WHERE organization_id = $1::uuid AND deleted_at IS NULL AND NOT (id = ANY($2::uuid[]))`,
      [ORG_ID, scope.packageIds, now],
    );
    (stats.soft_deleted_extras as Record<string, number>).packages = sdPkg.rowCount ?? 0;

    const sdPal = await orig.query(
      `UPDATE pallets SET deleted_at = $3, updated_at = $3
       WHERE organization_id = $1::uuid AND deleted_at IS NULL AND NOT (id = ANY($2::uuid[]))`,
      [ORG_ID, scope.palletIds, now],
    );
    (stats.soft_deleted_extras as Record<string, number>).pallets = sdPal.rowCount ?? 0;

    await orig.query("COMMIT");
  } catch (e) {
    await orig.query("ROLLBACK");
    throw e;
  }

  // Verify
  const poolSql = `
    SELECT count(*)::int n FROM return_items ri
    WHERE ri.deleted_at IS NULL AND ri.organization_id = $1::uuid
      AND ri.package_id IS NOT NULL
      AND NOT (ri.expected_item_id IS NOT NULL AND ri.package_id IS NULL AND ri.pallet_id IS NULL)
      AND ri.conditions && $2::text[]`;
  const pool = await orig.query(poolSql, [ORG_ID, CLAIMABLE]);

  const linkage = await orig.query(
    `SELECT ri.id::text,
            (ep.id IS NOT NULL) AS has_expected,
            (p.id IS NOT NULL) AS has_product
     FROM return_items ri
     LEFT JOIN expected_packages ep ON ep.id = ri.expected_item_id
     LEFT JOIN products p ON p.id = ri.resolved_product_id
     WHERE ri.organization_id = $1::uuid AND ri.deleted_at IS NULL AND ri.id = ANY($2::uuid[])`,
    [ORG_ID, scope.returnItemIds],
  );

  for (const t of touchTables) {
    if (t === "claim_evidence") continue;
    (stats.after as Record<string, number>)[t] =
      t === "product_identifier_map"
        ? await countWhere(orig, t, "organization_id = $1::uuid", [ORG_ID])
        : await countWhere(orig, t, "organization_id = $1::uuid", [ORG_ID]);
  }
  (stats.after as Record<string, number>).claim_submissions = await countWhere(
    orig,
    "claim_submissions",
    "organization_id = $1::uuid",
    [ORG_ID],
  );
  (stats.after as Record<string, number>).claim_cases = await countWhere(
    orig,
    "claim_cases",
    "organization_id = $1::uuid",
    [ORG_ID],
  );

  stats.verify = {
    draft_pool_count: pool.rows[0]?.n,
    linkage: linkage.rows,
    claim_cases: await countWhere(orig, "claim_cases", "organization_id = $1::uuid", [ORG_ID]),
    claim_lines: await countWhere(orig, "claim_lines", "organization_id = $1::uuid", [ORG_ID]),
    claim_submissions_demo: await countWhere(
      orig,
      "claim_submissions",
      "organization_id = $1::uuid AND return_id = ANY($2::uuid[])",
      [ORG_ID, scope.returnItemIds],
    ),
  };

  // Rollback SQL
  const rollbackLines = backups.map(
    (b) =>
      `-- Restore from ${b}:\n-- INSERT INTO ... SELECT * FROM public.${b} ON CONFLICT ... (manual review)`,
  );
  fs.writeFileSync(path.join(outDir, "99_rollback.sql"), rollbackLines.join("\n\n") + "\n");
  fs.writeFileSync(path.join(outDir, "apply_result.json"), JSON.stringify(stats, null, 2));

  console.log(JSON.stringify({ ok: true, outDir, stats: { scope, verify: stats.verify, soft_deleted_extras: stats.soft_deleted_extras } }));

  await stag.end();
  await orig.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
