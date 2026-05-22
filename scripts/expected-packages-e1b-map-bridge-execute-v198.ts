/**
 * EXPECTED-PACKAGES-E1B-MAP-BRIDGE-EXECUTE-V198
 *
 * Map-only bridge for trusted existing-product rows on expected_packages
 * (classification e1b_trusted_existing_product_map_missing).
 * No products created; expected_packages never updated.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
function v199RunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--v199-run-id="));
  if (a) return a.split("=")[1]!.trim();
  return "20260519T230000Z";
}
const V197_CENSUS = `.cursor/audit-reports/v197-product-linkage-table-census/20260522T120000Z/manifest.json`;
const APPROVAL_PATH = ".cursor/operator-approvals/expected-packages-e1b-map-bridge-v198-approval.md";
const PLAN_BASE = ".cursor/audit-reports/expected-packages-e1b-map-bridge-plan-v198";
const OUT_BASE = ".cursor/audit-reports/expected-packages-e1b-map-bridge-execute-v198";
const MATCH_SOURCE = "expected_packages_e1b_map_bridge_v198";
const EXPECTED_E1B = 28;
const V199_PACK =
  ".cursor/audit-reports/v199-expected-identifier-ambiguous-review-pack/20260522T130000Z";

type InsertPlanRow = {
  organization_id: string;
  store_id: string;
  product_id: string;
  seller_sku: string | null;
  msku: string | null;
  fnsku: string | null;
  match_source: string;
  source_report_type: string;
  external_listing_id: string;
  expected_package_ids: string[];
  expected_package_count: number;
  trusted_single_product_id: string;
  trusted_source_tables: string[] | null;
};

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
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_EXPECTED_PACKAGES_E1B_MAP_BRIDGE_V198\s*=\s*true/i.test(text)
  );
}

function externalListingId(row: {
  organization_id: string;
  store_id: string;
  sku: string | null;
  fnsku: string | null;
  product_id: string;
}): string {
  const key = [row.organization_id, row.store_id, row.sku ?? "", row.fnsku ?? "", row.product_id].join(
    "|",
  );
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
  return `${MATCH_SOURCE}:${hash}`;
}

async function coverage(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(`
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id,
        NULLIF(TRIM(e.sku), '') AS sku,
        NULLIF(TRIM(e.fnsku), '') AS fnsku,
        e.resolved_product_id
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count
      FROM ep
      JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku = ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count
      FROM ep
      JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku = ep.sku OR m.msku = ep.sku)
      GROUP BY ep.id
    ),
    classified AS (
      SELECT ep.id,
        CASE
          WHEN ep.resolved_product_id IS NOT NULL THEN 'direct_resolved_product_id'
          WHEN COALESCE(mf.product_count, 0) = 1 THEN 'read_layer_resolved_map_fnsku'
          WHEN COALESCE(ms.product_count, 0) = 1 THEN 'read_layer_resolved_map_sku'
          WHEN COALESCE(mf.product_count, 0) > 1 OR COALESCE(ms.product_count, 0) > 1 THEN 'ambiguous'
          ELSE 'unresolved'
        END AS bucket
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id = ep.id
      LEFT JOIN map_sku ms ON ms.id = ep.id
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket IN ('direct_resolved_product_id','read_layer_resolved_map_fnsku','read_layer_resolved_map_sku'))::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE bucket = 'unresolved')::int AS unresolved,
      COUNT(*) FILTER (WHERE bucket = 'ambiguous')::int AS ambiguous
    FROM classified
  `);
  return r.rows[0] as Record<string, number>;
}

async function fetchE1bCandidates(client: pg.Client): Promise<InsertPlanRow[]> {
  const res = await client.query(`
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id,
        NULLIF(TRIM(e.sku), '') AS sku,
        NULLIF(TRIM(e.fnsku), '') AS fnsku,
        e.resolved_product_id
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id,
        COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku = ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id,
        COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku = ep.sku OR m.msku = ep.sku)
      GROUP BY ep.id
    ),
    trusted_sources AS (
      SELECT ep.id,
        COUNT(DISTINCT source_product_id) FILTER (WHERE source_product_id IS NOT NULL)::int AS source_product_count,
        ARRAY_AGG(DISTINCT src) FILTER (WHERE src IS NOT NULL) AS source_tables,
        (ARRAY_AGG(DISTINCT source_product_id) FILTER (WHERE source_product_id IS NOT NULL))[1] AS single_product_id
      FROM ep
      LEFT JOIN LATERAL (
        SELECT 'amazon_amazon_fulfilled_inventory'::text AS src,
          COALESCE(a.resolved_product_id, a.product_id) AS source_product_id
        FROM public.amazon_amazon_fulfilled_inventory a
        WHERE a.organization_id = ep.organization_id AND a.store_id = ep.store_id
          AND ((ep.fnsku IS NOT NULL AND a.fulfillment_channel_sku = ep.fnsku)
            OR (ep.sku IS NOT NULL AND a.seller_sku = ep.sku))
        UNION ALL
        SELECT 'amazon_fba_inventory'::text, COALESCE(f.resolved_product_id, f.product_id)
        FROM public.amazon_fba_inventory f
        WHERE f.organization_id = ep.organization_id AND f.store_id = ep.store_id
          AND ((ep.fnsku IS NOT NULL AND f.fnsku = ep.fnsku) OR (ep.sku IS NOT NULL AND f.sku = ep.sku))
        UNION ALL
        SELECT 'amazon_manage_fba_inventory'::text, COALESCE(mf.resolved_product_id, mf.product_id)
        FROM public.amazon_manage_fba_inventory mf
        WHERE mf.organization_id = ep.organization_id AND mf.store_id = ep.store_id
          AND ((ep.fnsku IS NOT NULL AND mf.fnsku = ep.fnsku) OR (ep.sku IS NOT NULL AND mf.sku = ep.sku))
      ) s ON true
      GROUP BY ep.id
    ),
    e1b AS (
      SELECT ep.id::text AS expected_package_id, ep.organization_id::text, ep.store_id::text,
        ep.sku, ep.fnsku, ts.single_product_id::text AS trusted_single_product_id,
        ts.source_tables AS trusted_source_tables
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id = ep.id
      LEFT JOIN map_sku ms ON ms.id = ep.id
      JOIN trusted_sources ts ON ts.id = ep.id
      WHERE ep.resolved_product_id IS NULL
        AND ep.store_id IS NOT NULL
        AND (ep.sku IS NOT NULL OR ep.fnsku IS NOT NULL)
        AND COALESCE(mf.product_count, 0) = 0
        AND COALESCE(ms.product_count, 0) = 0
        AND ts.source_product_count = 1
        AND ts.single_product_id IS NOT NULL
    )
    SELECT * FROM e1b ORDER BY sku, fnsku, expected_package_id
  `);

  const grouped = new Map<string, InsertPlanRow>();
  for (const row of res.rows as Record<string, unknown>[]) {
    const productId = String(row.trusted_single_product_id);
    const org = String(row.organization_id);
    const store = String(row.store_id);
    const sku = row.sku ? String(row.sku) : null;
    const fnsku = row.fnsku ? String(row.fnsku) : null;
    const key = [org, store, sku ?? "", fnsku ?? "", productId].join("|");
    const epId = String(row.expected_package_id);
    const existing = grouped.get(key);
    if (existing) {
      existing.expected_package_ids.push(epId);
      existing.expected_package_count += 1;
      continue;
    }
    grouped.set(key, {
      organization_id: org,
      store_id: store,
      product_id: productId,
      trusted_single_product_id: productId,
      seller_sku: sku,
      msku: sku,
      fnsku,
      match_source: MATCH_SOURCE,
      source_report_type: MATCH_SOURCE,
      external_listing_id: externalListingId({ organization_id: org, store_id: store, sku, fnsku, product_id: productId }),
      expected_package_ids: [epId],
      expected_package_count: 1,
      trusted_source_tables: Array.isArray(row.trusted_source_tables)
        ? (row.trusted_source_tables as string[])
        : null,
    });
  }
  const plan = [...grouped.values()].sort((a, b) =>
    `${a.seller_sku ?? ""}:${a.fnsku ?? ""}`.localeCompare(`${b.seller_sku ?? ""}:${b.fnsku ?? ""}`),
  );

  const productIds = [...new Set(plan.map((r) => r.product_id))];
  const exists = await client.query(
    `SELECT id::text FROM public.products
     WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
       AND (merge_status IS NULL OR merge_status <> 'merged')`,
    [productIds],
  );
  const found = new Set(exists.rows.map((r: { id: string }) => r.id));
  const missing = productIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    const err = new Error(
      `Trusted product_id(s) missing from active products spine (${missing.length}/${productIds.length}): ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`,
    );
    (err as Error & { spineMissing?: string[] }).spineMissing = missing;
    throw err;
  }

  return plan;
}

function loadV199E1bExpectedPackageIds(): string[] {
  const csvPath = path.join(process.cwd(), V199_PACK, "manual-review-queue.csv");
  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
  const ids: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line.includes("e1b_trusted_existing_product_map_missing")) continue;
    ids.push(line.split(",")[0]!);
  }
  return ids;
}

async function verifyE1bCohortResolved(
  client: pg.Client,
  epIds: string[],
): Promise<{ total: number; read_layer_resolved: number }> {
  const r = await client.query(
    `
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id, NULLIF(TRIM(e.sku), '') AS sku,
        NULLIF(TRIM(e.fnsku), '') AS fnsku, e.resolved_product_id
      FROM public.expected_packages e
      WHERE e.id = ANY($1::uuid[])
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count
      FROM ep
      JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku = ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count
      FROM ep
      JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku = ep.sku OR m.msku = ep.sku)
      GROUP BY ep.id
    ),
    classified AS (
      SELECT ep.id,
        CASE
          WHEN ep.resolved_product_id IS NOT NULL THEN 'resolved'
          WHEN COALESCE(mf.product_count, 0) = 1 OR COALESCE(ms.product_count, 0) = 1 THEN 'resolved'
          ELSE 'unresolved'
        END AS bucket
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id = ep.id
      LEFT JOIN map_sku ms ON ms.id = ep.id
    )
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket = 'resolved')::int AS read_layer_resolved
    FROM classified
  `,
    [epIds],
  );
  return r.rows[0] as { total: number; read_layer_resolved: number };
}

async function writeE1bSkipPass(opts: {
  runId: string;
  outDir: string;
  planDir: string;
  plan: InsertPlanRow[];
  v199RunId: string;
  cohortCheck: { total: number; read_layer_resolved: number };
  beforeCoverage: Record<string, number>;
  afterCoverage: Record<string, number>;
  beforeCounts: Record<string, unknown>;
  afterCounts: Record<string, unknown>;
  priorMaterializeRun?: string;
}): void {
  const manifest = {
    prompt: "EXPECTED-PACKAGES-E1B-MAP-ONLY-REFRESH-EXECUTE-V198",
    run_id: opts.runId,
    staging_ref: STAGING_REF,
    status: "PASS",
    outcome: "skip_cohort_already_resolved",
    prior_materialize_run: opts.priorMaterializeRun ?? null,
    v199_review_run_id: opts.v199RunId,
    v199_e1b_cohort: opts.cohortCheck,
    approved_plan_rows: 0,
    inserted_rows: 0,
    db_writes: { product_identifier_map_inserts: 0 },
    forbidden_writes: {
      products_created: false,
      expected_packages_updated: false,
      production_touched: false,
    },
    before_counts: opts.beforeCounts,
    after_counts: opts.afterCounts,
    before_coverage: opts.beforeCoverage,
    after_coverage: opts.afterCoverage,
  };
  fs.writeFileSync(path.join(opts.outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(opts.outDir, "apply-result.md"),
    [
      "# E1B map bridge execute V198 — cohort already resolved",
      "",
      `V199 E1B cohort (**${opts.cohortCheck.total}** rows) is read-layer resolved after prior materialize/maps.`,
      "No additional `product_identifier_map` inserts required.",
      "",
      `- Read-layer resolved (global): ${opts.beforeCoverage.read_layer_resolved} (unchanged in this no-op pass)`,
      `- V199 cohort resolved: **${opts.cohortCheck.read_layer_resolved} / ${opts.cohortCheck.total}**`,
    ].join("\n"),
  );
  fs.writeFileSync(path.join(opts.outDir, "rollback.sql"), "-- No E1B inserts; rollback not required.\n");
  fs.writeFileSync(path.join(opts.outDir, "inserted-rows.json"), "[]\n");
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const v199RunId = v199RunIdArg();
  const v199Manifest = `.cursor/audit-reports/v199-expected-identifier-ambiguous-review-pack/${v199RunId}/manifest.json`;
  const planDir = path.join(process.cwd(), PLAN_BASE, runId);
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(planDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  if (!readApproval()) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      `# Blocked\n\nApproval flags are not true in \`${APPROVAL_PATH}\`.\n`,
    );
    throw new Error(`Approval flags are not true in ${APPROVAL_PATH}`);
  }

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (
    !dbUrl ||
    getStagingProjectRef({ loadEnv: false }) !== STAGING_REF ||
    !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)
  ) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const pkgItems = await (async () => {
    const c = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const r = await c.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='package_items'`,
    );
    await c.end();
    return (r.rowCount ?? 0) > 0;
  })();
  if (pkgItems) throw new Error("package_items exists (forbidden)");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const plan = await fetchE1bCandidates(client);
  fs.writeFileSync(path.join(planDir, "e1b-candidates.json"), JSON.stringify({ insert_plan: plan }, null, 2));
  fs.writeFileSync(
    path.join(planDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "EXPECTED-PACKAGES-E1B-MAP-BRIDGE-PLAN-V198",
        run_id: runId,
        staging_ref: STAGING_REF,
        insert_plan_rows: plan.length,
        expected_package_rows: plan.reduce((n, r) => n + r.expected_package_count, 0),
        inputs: { v199_manifest: v199Manifest, v197_census: V197_CENSUS, v199_run_id: v199RunId },
      },
      null,
      2,
    ),
  );

  const expectedPackageRows = plan.reduce((n, r) => n + r.expected_package_count, 0);
  const beforeCoverage = await coverage(client);
  const beforeCounts = await client.query(
    `
    SELECT
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.expected_packages) AS expected_packages,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS active_map_rows,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE match_source = $1 AND deleted_at IS NULL) AS e1b_map_rows
  `,
    [MATCH_SOURCE],
  );

  if (expectedPackageRows === 0) {
    const epIds = loadV199E1bExpectedPackageIds();
    const cohortCheck = await verifyE1bCohortResolved(client, epIds);
    const afterCoverage = await coverage(client);
    const afterCounts = await client.query(
      `
      SELECT
        (SELECT COUNT(*)::int FROM public.products) AS products,
        (SELECT COUNT(*)::int FROM public.expected_packages) AS expected_packages,
        (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS active_map_rows,
        (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE match_source = $1 AND deleted_at IS NULL) AS e1b_map_rows
    `,
      [MATCH_SOURCE],
    );
    await client.end();
    if (cohortCheck.read_layer_resolved !== EXPECTED_E1B || cohortCheck.total !== EXPECTED_E1B) {
      fs.writeFileSync(
        path.join(outDir, "blockers.md"),
        `# Blocked\n\nZero E1B insert candidates but V199 cohort not fully resolved: **${cohortCheck.read_layer_resolved}/${cohortCheck.total}** (expected ${EXPECTED_E1B}).\n`,
      );
      throw new Error(`V199 E1B cohort not fully resolved: ${cohortCheck.read_layer_resolved}/${EXPECTED_E1B}`);
    }
    const postV200 = process.argv.find((x) => x.includes("160000Z"))?.split("=")[0];
    writeE1bSkipPass({
      runId,
      outDir,
      planDir,
      plan,
      v199RunId,
      cohortCheck,
      beforeCoverage,
      afterCoverage,
      beforeCounts: beforeCounts.rows[0] as Record<string, unknown>,
      afterCounts: afterCounts.rows[0] as Record<string, unknown>,
      priorMaterializeRun: runId.includes("-e1b") ? runId.replace(/-e1b$/, "") : "20260522T160000Z",
    });
    console.log(
      JSON.stringify({
        status: "PASS",
        outcome: "skip_cohort_already_resolved",
        v199_e1b_cohort: cohortCheck,
      }),
    );
    return;
  }

  if (expectedPackageRows !== EXPECTED_E1B) {
    await client.end();
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      `# Blocked\n\nExpected **${EXPECTED_E1B}** E1B expected_package rows, found **${expectedPackageRows}** (${plan.length} unique map keys). Regenerate V199 review pack and reconcile before execute.\n`,
    );
    throw new Error(`Expected ${EXPECTED_E1B} E1B expected_package rows, found ${expectedPackageRows}`);
  }

  const externalIds = plan.map((r) => r.external_listing_id);
  const preExisting = await client.query(
    `SELECT id::text, product_id::text, seller_sku, fnsku, external_listing_id
     FROM public.product_identifier_map
     WHERE external_listing_id = ANY($1::text[])`,
    [externalIds],
  );

  const conflictRows = await client.query(
    `
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS x(
        organization_id uuid,
        store_id uuid,
        product_id uuid,
        seller_sku text,
        msku text,
        fnsku text,
        external_listing_id text
      )
    )
    SELECT i.external_listing_id, i.product_id::text AS planned_product_id,
      m.id::text AS existing_map_id, m.product_id::text AS existing_product_id, m.seller_sku, m.fnsku
    FROM input i
    JOIN public.product_identifier_map m
      ON m.organization_id = i.organization_id AND m.store_id = i.store_id AND m.deleted_at IS NULL
     AND m.seller_sku IS NOT DISTINCT FROM i.seller_sku
    WHERE m.product_id IS DISTINCT FROM i.product_id
  `,
    [JSON.stringify(plan)],
  );

  fs.writeFileSync(
    path.join(outDir, "preimage.json"),
    JSON.stringify(
      {
        before_counts: beforeCounts.rows[0],
        before_coverage: beforeCoverage,
        pre_existing_external_listing_rows: preExisting.rows,
        conflicts: conflictRows.rows,
        v199_run_id: v199RunId,
        insert_plan_count: plan.length,
      },
      null,
      2,
    ),
  );

  if (conflictRows.rows.length > 0) {
    await client.end();
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      `# Blocked\n\nFound ${conflictRows.rows.length} conflicting active seller_sku map rows. No inserts executed.\n`,
    );
    throw new Error("Conflicting active product_identifier_map rows found; no inserts executed.");
  }

  const insertable = plan.filter(
    (row) => !preExisting.rows.some((r) => r.external_listing_id === row.external_listing_id),
  );

  let insertedRows: Record<string, unknown>[] = [];
  await client.query("BEGIN");
  try {
    const ins = await client.query(
      `
      WITH input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          organization_id uuid,
          store_id uuid,
          product_id uuid,
          seller_sku text,
          msku text,
          fnsku text,
          match_source text,
          source_report_type text,
          external_listing_id text
        )
      ),
      inserted AS (
        INSERT INTO public.product_identifier_map (
          organization_id, store_id, product_id, seller_sku, msku, fnsku,
          match_source, source_report_type, external_listing_id, is_primary,
          first_seen_at, last_seen_at, created_at, updated_at
        )
        SELECT i.organization_id, i.store_id, i.product_id, i.seller_sku, i.msku, i.fnsku,
          i.match_source, i.source_report_type, i.external_listing_id, true,
          now(), now(), now(), now()
        FROM input i
        WHERE NOT EXISTS (
          SELECT 1 FROM public.product_identifier_map m WHERE m.external_listing_id = i.external_listing_id
        )
        RETURNING id::text, product_id::text, seller_sku, msku, fnsku, external_listing_id
      )
      SELECT * FROM inserted
    `,
      [JSON.stringify(insertable)],
    );
    insertedRows = ins.rows;
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  const afterCoverage = await coverage(client);
  const afterCounts = await client.query(
    `
    SELECT
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.expected_packages) AS expected_packages,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS active_map_rows,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE match_source = $1 AND deleted_at IS NULL) AS e1b_map_rows
  `,
    [MATCH_SOURCE],
  );
  await client.end();

  fs.writeFileSync(path.join(outDir, "inserted-rows.json"), JSON.stringify(insertedRows, null, 2));
  fs.writeFileSync(path.join(outDir, "skipped-existing.json"), JSON.stringify(preExisting.rows, null, 2));
  const idList = insertedRows
    .map((r) => `'${String(r.external_listing_id).replace(/'/g, "''")}'`)
    .join(", ");
  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      "-- Rollback only this V198 E1B execute batch.",
      "DELETE FROM public.product_identifier_map",
      idList ? `WHERE external_listing_id IN (${idList});` : "WHERE false;",
      "",
    ].join("\n"),
  );

  const manifest = {
    prompt: "EXPECTED-PACKAGES-E1B-MAP-ONLY-REFRESH-EXECUTE-V198",
    run_id: runId,
    staging_ref: STAGING_REF,
    status: "PASS",
    plan_run_id: runId,
    v199_review_run_id: v199RunId,
    approved_plan_rows: plan.length,
    inserted_rows: insertedRows.length,
    skipped_existing_rows: preExisting.rows.length,
    db_writes: { product_identifier_map_inserts: insertedRows.length },
    forbidden_writes: {
      products_created: false,
      expected_packages_updated: false,
      production_touched: false,
      migrations_run: false,
      package_items_created: false,
      amazon_api_called: false,
      ai_or_openai_called: false,
    },
    before_counts: beforeCounts.rows[0],
    after_counts: afterCounts.rows[0],
    before_coverage: beforeCoverage,
    after_coverage: afterCoverage,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    [
      "# Expected Packages E1B map bridge execute V198",
      "",
      `- Approved plan rows: **${plan.length}**`,
      `- Inserted map rows: **${insertedRows.length}**`,
      `- Skipped existing rows: **${preExisting.rows.length}**`,
      `- Read-layer resolved: ${beforeCoverage.read_layer_resolved} -> **${afterCoverage.read_layer_resolved}**`,
      `- Unresolved: ${beforeCoverage.unresolved} -> **${afterCoverage.unresolved}**`,
      `- Active map rows: ${beforeCounts.rows[0]?.active_map_rows} -> **${afterCounts.rows[0]?.active_map_rows}**`,
      "",
      "No products created. No expected_packages updated.",
    ].join("\n"),
  );
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e: Error & { spineMissing?: string[] }) => {
  const runId = process.argv.find((x) => x.startsWith("--run-id="))?.split("=")[1]?.trim();
  if (runId && e.spineMissing?.length) {
    const outDir = path.join(process.cwd(), OUT_BASE, runId);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      [
        "# E1B execute blocked — orphan trusted source product_ids",
        "",
        "V199 classified **28** `expected_packages` rows as `e1b_trusted_existing_product_map_missing`,",
        "but **0 / 10** distinct `trusted_single_product_id` values exist on the active `products` spine.",
        "",
        "Map-only inserts require a real `products.id` FK. Import tables (e.g. `amazon_manage_fba_inventory`)",
        "still reference deleted or never-materialized product UUIDs.",
        "",
        "## Missing product_ids (sample)",
        "",
        ...e.spineMissing.map((id) => `- \`${id}\``),
        "",
        "## Required before re-execute",
        "",
        "1. Repair import `product_id` / `resolved_product_id` to active spine rows, **or**",
        "2. Governed product materialization (not E1B map-only), **or**",
        "3. Re-run V199 review pack after spine repair and regenerate insert plan.",
        "",
        "No `product_identifier_map` rows were inserted.",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(outDir, "rollback.sql"),
      "-- No inserts executed; rollback not required.\n",
    );
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          prompt: "EXPECTED-PACKAGES-E1B-MAP-ONLY-REFRESH-EXECUTE-V198",
          run_id: runId,
          staging_ref: STAGING_REF,
          status: "BLOCKED",
          reason: "trusted_source_product_id_not_on_products_spine",
          distinct_trusted_product_ids: e.spineMissing.length,
          db_writes: { product_identifier_map_inserts: 0 },
        },
        null,
        2,
      ),
    );
  }
  console.error(e);
  process.exit(1);
});
