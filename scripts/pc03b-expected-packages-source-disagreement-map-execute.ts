/**
 * PC03B — EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-MAP-EXECUTE
 *
 * Governed map-only insert from PC03 map-bridge-preview.json.
 * No products created; expected_packages not updated.
 *
 *   npx tsx scripts/pc03b-expected-packages-source-disagreement-map-execute.ts --run-id=<UTC_Z>
 *   npx tsx scripts/pc03b-expected-packages-source-disagreement-map-execute.ts --pc03-run-id=20260523T010000Z
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
const PC03_DEFAULT = "20260523T010000Z";
const PC03_BASE = ".cursor/audit-reports/pc03-expected-packages-source-disagreement-reconcile";
const APPROVAL_PATH =
  ".cursor/operator-approvals/expected-packages-source-disagreement-map-pc03b-approval.md";
const OUT_BASE = ".cursor/audit-reports/pc03b-expected-packages-source-disagreement-map-execute";
const MATCH_SOURCE = "expected_packages_pc03b_source_disagreement_map";

type PreviewRow = {
  cluster_key: string;
  organization_id: string;
  store_id: string;
  product_id: string;
  fnsku: string | null;
  seller_sku: string | null;
  asin: string | null;
  recommended_product_id: string;
};

type InsertRow = {
  organization_id: string;
  store_id: string;
  product_id: string;
  seller_sku: string | null;
  msku: string | null;
  fnsku: string | null;
  asin: string | null;
  match_source: string;
  source_report_type: string;
  external_listing_id: string;
  cluster_key: string;
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

function pc03RunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--pc03-run-id="));
  return a ? a.split("=")[1]!.trim() : PC03_DEFAULT;
}

function readApproval(): boolean {
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_EXPECTED_PACKAGES_SOURCE_DISAGREEMENT_MAP_PC03B\s*=\s*true/i.test(text)
  );
}

function loadPreview(pc03RunId: string): PreviewRow[] {
  const p = path.join(process.cwd(), PC03_BASE, pc03RunId, "map-bridge-preview.json");
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}`);
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as { rows: PreviewRow[] };
  return raw.rows ?? [];
}

function toInsertPlan(rows: PreviewRow[], executeRunId: string): InsertRow[] {
  const out: InsertRow[] = [];
  for (const row of rows) {
    if (row.product_id !== row.recommended_product_id) {
      throw new Error(`product_id mismatch on cluster ${row.cluster_key}`);
    }
    if (!row.fnsku && !row.seller_sku) {
      throw new Error(`No identifier on cluster ${row.cluster_key}`);
    }
    const idPart = row.fnsku ? `fnsku:${row.fnsku}` : `sku:${row.seller_sku}`;
    out.push({
      organization_id: row.organization_id,
      store_id: row.store_id,
      product_id: row.product_id,
      seller_sku: row.seller_sku,
      msku: row.seller_sku,
      fnsku: row.fnsku,
      asin: row.asin,
      match_source: MATCH_SOURCE,
      source_report_type: MATCH_SOURCE,
      external_listing_id: `pc03b|${executeRunId}|${row.cluster_key}|${idPart}`,
      cluster_key: row.cluster_key,
    });
  }
  return out;
}

async function coverage(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(`
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id,
        NULLIF(TRIM(e.sku), '') AS sku, NULLIF(TRIM(e.fnsku), '') AS fnsku, e.resolved_product_id
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM ep
      JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku = ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku = ep.sku OR m.msku = ep.sku)
      GROUP BY ep.id
    ),
    classified AS (
      SELECT ep.id,
        CASE
          WHEN ep.resolved_product_id IS NOT NULL THEN 'resolved'
          WHEN COALESCE((SELECT c FROM map_fnsku mf WHERE mf.id = ep.id), 0) = 1 THEN 'resolved'
          WHEN COALESCE((SELECT c FROM map_sku ms WHERE ms.id = ep.id), 0) = 1 THEN 'resolved'
          WHEN COALESCE((SELECT c FROM map_fnsku mf WHERE mf.id = ep.id), 0) > 1
            OR COALESCE((SELECT c FROM map_sku ms WHERE ms.id = ep.id), 0) > 1 THEN 'ambiguous'
          ELSE 'unresolved'
        END AS bucket
      FROM ep
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket = 'resolved')::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE bucket = 'unresolved')::int AS unresolved,
      COUNT(*) FILTER (WHERE bucket = 'ambiguous')::int AS ambiguous
    FROM classified
  `);
  return r.rows[0] as Record<string, number>;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const pc03RunId = pc03RunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  if (!readApproval()) {
    throw new Error(`Approval flags not true in ${APPROVAL_PATH}`);
  }

  const preview = loadPreview(pc03RunId);
  const plan = toInsertPlan(preview, runId);
  if (plan.length !== 6) {
    throw new Error(`Expected 6 map rows from PC03 preview, got ${plan.length}`);
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

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const productIds = [...new Set(plan.map((p) => p.product_id))];
  const spineCheck = await client.query(
    `SELECT id::text FROM public.products WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [productIds],
  );
  if (spineCheck.rows.length !== productIds.length) {
    throw new Error("One or more product_id not found in products spine");
  }

  const beforeCoverage = await coverage(client);
  const beforeCounts = await client.query(
    `
    SELECT
      (SELECT COUNT(*)::int FROM public.products WHERE deleted_at IS NULL) AS products,
      (SELECT COUNT(*)::int FROM public.expected_packages) AS expected_packages,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS active_map_rows
  `,
  );

  const externalIds = plan.map((r) => r.external_listing_id);
  const preExisting = await client.query(
    `SELECT id::text, product_id::text, seller_sku, fnsku, external_listing_id
     FROM public.product_identifier_map WHERE external_listing_id = ANY($1::text[])`,
    [externalIds],
  );

  const conflictRows = await client.query(
    `
    WITH input AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
        organization_id uuid, store_id uuid, product_id uuid,
        seller_sku text, msku text, fnsku text, external_listing_id text
      )
    )
  SELECT i.external_listing_id, i.product_id::text AS planned_product_id,
      m.id::text AS existing_map_id, m.product_id::text AS existing_product_id,
      m.seller_sku, m.fnsku, 'seller_sku_conflict' AS conflict_type
    FROM input i
    JOIN public.product_identifier_map m
      ON m.organization_id = i.organization_id AND m.store_id = i.store_id
     AND m.deleted_at IS NULL AND i.seller_sku IS NOT NULL
     AND (m.seller_sku = i.seller_sku OR m.msku = i.seller_sku)
    WHERE m.product_id IS DISTINCT FROM i.product_id
    UNION ALL
    SELECT i.external_listing_id, i.product_id::text, m.id::text, m.product_id::text,
      m.seller_sku, m.fnsku, 'fnsku_conflict'
    FROM input i
    JOIN public.product_identifier_map m
      ON m.organization_id = i.organization_id AND m.store_id = i.store_id
     AND m.deleted_at IS NULL AND i.fnsku IS NOT NULL AND m.fnsku = i.fnsku
    WHERE m.product_id IS DISTINCT FROM i.product_id
    `,
    [JSON.stringify(plan)],
  );

  fs.writeFileSync(
    path.join(outDir, "preimage.json"),
    JSON.stringify(
      {
        pc03_run_id: pc03RunId,
        plan_rows: plan.length,
        before_counts: beforeCounts.rows[0],
        before_coverage: beforeCoverage,
        pre_existing: preExisting.rows,
        conflicts: conflictRows.rows,
      },
      null,
      2,
    ),
  );

  if (conflictRows.rows.length > 0) {
    await client.end();
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      `# Blocked\n\n${conflictRows.rows.length} conflicting active map row(s). No inserts.\n`,
    );
    throw new Error("Conflicting active product_identifier_map rows; no inserts executed.");
  }

  const insertable = plan.filter(
    (row) => !preExisting.rows.some((r) => r.external_listing_id === row.external_listing_id),
  );

  let insertedRows: Record<string, unknown>[] = [];
  if (insertable.length) {
    await client.query("BEGIN");
    try {
      const ins = await client.query(
        `
        WITH input AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
            organization_id uuid, store_id uuid, product_id uuid,
            seller_sku text, msku text, fnsku text, asin text,
            match_source text, source_report_type text, external_listing_id text
          )
        ),
        inserted AS (
          INSERT INTO public.product_identifier_map (
            organization_id, store_id, product_id, seller_sku, msku, fnsku, asin,
            match_source, source_report_type, external_listing_id,
            is_primary, first_seen_at, last_seen_at, created_at, updated_at
          )
          SELECT i.organization_id, i.store_id, i.product_id, i.seller_sku, i.msku, i.fnsku, i.asin,
            i.match_source, i.source_report_type, i.external_listing_id,
            true, now(), now(), now(), now()
          FROM input i
          WHERE NOT EXISTS (
            SELECT 1 FROM public.product_identifier_map m
            WHERE m.external_listing_id = i.external_listing_id
          )
          RETURNING id::text, product_id::text, seller_sku, msku, fnsku, asin, external_listing_id
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
  }

  const afterCoverage = await coverage(client);
  const afterCounts = await client.query(
    `
    SELECT
      (SELECT COUNT(*)::int FROM public.products WHERE deleted_at IS NULL) AS products,
      (SELECT COUNT(*)::int FROM public.expected_packages) AS expected_packages,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS active_map_rows,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE match_source = $1 AND deleted_at IS NULL) AS pc03b_map_rows
  `,
    [MATCH_SOURCE],
  );
  await client.end();

  fs.writeFileSync(path.join(outDir, "inserted-map-rows.json"), JSON.stringify(insertedRows, null, 2));
  fs.writeFileSync(path.join(outDir, "skipped-existing.json"), JSON.stringify(preExisting.rows, null, 2));

  const rollbackIds = insertedRows.map((r) => `'${String(r.external_listing_id).replace(/'/g, "''")}'`);
  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    rollbackIds.length
      ? [
          "-- Rollback PC03B map-only execute batch",
          "DELETE FROM public.product_identifier_map",
          `WHERE external_listing_id IN (${rollbackIds.join(", ")});`,
          "",
        ].join("\n")
      : "-- No rows inserted\n",
  );

  const manifest = {
    prompt: "PC03B — EXPECTED-PACKAGES-SOURCE-DISAGREEMENT-MAP-EXECUTE",
    run_id: runId,
    pc03_run_id: pc03RunId,
    staging_ref: STAGING_REF,
    status: insertedRows.length > 0 || insertable.length === 0 ? "PASS" : "PARTIAL",
    approval_file: APPROVAL_PATH,
    preview_rows: plan.length,
    inserted_rows: insertedRows.length,
    skipped_existing: preExisting.rows.length,
    match_source: MATCH_SOURCE,
    before_coverage: beforeCoverage,
    after_coverage: afterCoverage,
    coverage_delta: {
      read_layer_resolved: (afterCoverage.read_layer_resolved ?? 0) - (beforeCoverage.read_layer_resolved ?? 0),
      unresolved: (afterCoverage.unresolved ?? 0) - (beforeCoverage.unresolved ?? 0),
    },
    forbidden: {
      products_created: false,
      expected_packages_updated: false,
      production: false,
      amazon_api: false,
    },
    next_prompt: "PC03 — EXPECTED-PACKAGES-DIRTY-SOURCE-QUARANTINE-PLAN",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    [
      "# PC03B map execute",
      "",
      `- Inserted: **${insertedRows.length}** map rows`,
      `- Read-layer resolved: ${beforeCoverage.read_layer_resolved} → **${afterCoverage.read_layer_resolved}**`,
      `- Unresolved: ${beforeCoverage.unresolved} → **${afterCoverage.unresolved}**`,
      "",
      "No products created. No expected_packages updated.",
    ].join("\n") + "\n",
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
