/**
 * ORIGINAL SAFE BULK PRODUCT LINKAGE EXPANSION
 *
 * Phase 1: Safe governed map replay (Wave B plan — skip if already applied).
 * Phase 2: Deterministic safe product+map promotion from staging lineage + direct ownership link.
 *
 *   npx tsx scripts/original-safe-bulk-product-linkage-expansion-execute.ts --run-id=<UTC_Z>
 *   npx tsx scripts/original-safe-bulk-product-linkage-expansion-execute.ts --run-id=<UTC_Z> --apply
 */
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const PLAN_RUN_ID = "20260528T220709Z";
const PLAN_DIR = `.cursor/audit-reports/original-parity-wave-b-governed-map-replay-plan/${PLAN_RUN_ID}`;
const APPROVAL_PATH =
  ".cursor/operator-approvals/original-parity-wave-b-governed-map-replay-approval.md";
const OUT_BASE = ".cursor/audit-reports/original-safe-bulk-product-linkage-expansion";
const EXPANSION_MATCH_SOURCE = "original_parity_safe_linkage_expansion_v1";
const DERIVED_SOURCES = ["detail_shipment", "detail_remainder"] as const;

type PlanMapRow = {
  replay_key: string;
  match_source: string;
  product_id: string;
  fnsku: string | null;
  seller_sku: string | null;
  match_via: string;
  governed_execute: string;
  map_only: boolean;
  expected_package_ids: string[];
  expected_package_count: number;
};

type CreateCandidate = {
  expected_package_id: string;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  upc: string | null;
  staging_match_source: string;
  staging_product_id: string;
  staging_map_id: string;
  match_via: string;
  governed_execute: string;
};

type PromoteRow = {
  staging_product_id: string;
  staging_map_id: string;
  staging_match_source: string;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  upc: string | null;
  governed_execute: string;
  expected_package_ids: string[];
  blockers: string[];
  safe: boolean;
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

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

function readApproval(): boolean {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  return (
    /APPROVED_TO_RUN_ORIGINAL\s*=\s*true/i.test(text) &&
    /APPROVED_ORIGINAL_PARITY_WAVE_B_GOVERNED_MAP_REPLAY\s*=\s*true/i.test(text)
  );
}

function externalListingId(
  matchSource: string,
  productId: string,
  fnsku: string | null,
  sku: string | null,
): string {
  const key = [ORG_ID, STORE_ID, matchSource, productId, fnsku ?? "", sku ?? ""].join("|");
  return `${matchSource}:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

async function epCensus(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(
    `
    SELECT
      COUNT(*)::int AS ep_total,
      COUNT(*) FILTER (WHERE build_source IN ('detail_shipment','detail_remainder'))::int AS ep_derived,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS ep_resolved,
      COUNT(*) FILTER (
        WHERE build_source IN ('detail_shipment','detail_remainder') AND resolved_product_id IS NULL
      )::int AS ep_derived_unresolved,
      COUNT(*) FILTER (
        WHERE build_source IN ('detail_shipment','detail_remainder')
          AND identifier_resolution_status = 'ambiguous'
      )::int AS ep_ambiguous
    FROM public.expected_packages
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
    `,
    [ORG_ID, STORE_ID],
  );
  return r.rows[0] as Record<string, number>;
}

async function runResolverBackfill(client: pg.Client): Promise<{ set_resolved: number; ambiguous: number }> {
  const resolved = await client.query(
    `
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id,
        NULLIF(TRIM(e.sku), '') AS sku,
        NULLIF(TRIM(e.fnsku), '') AS fnsku,
        e.resolved_product_id
      FROM public.expected_packages e
      WHERE e.organization_id = $1::uuid AND e.store_id = $2::uuid
        AND e.build_source = ANY($3::text[])
        AND e.resolved_product_id IS NULL
    ),
    map_fnsku AS (
      SELECT ep.id,
        COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count,
        (ARRAY_AGG(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL))[1] AS product_id
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku = ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id,
        COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count,
        (ARRAY_AGG(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL))[1] AS product_id
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku = ep.sku OR m.msku = ep.sku)
      GROUP BY ep.id
    ),
    targets AS (
      SELECT ep.id,
        CASE
          WHEN COALESCE(mf.product_count, 0) = 1 THEN mf.product_id
          WHEN COALESCE(ms.product_count, 0) = 1 THEN ms.product_id
          ELSE NULL
        END AS product_id
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id = ep.id
      LEFT JOIN map_sku ms ON ms.id = ep.id
      WHERE COALESCE(mf.product_count, 0) <= 1 AND COALESCE(ms.product_count, 0) <= 1
        AND (COALESCE(mf.product_count, 0) = 1 OR COALESCE(ms.product_count, 0) = 1)
    )
    UPDATE public.expected_packages t
    SET resolved_product_id = tg.product_id,
        resolved_catalog_product_id = NULL,
        identifier_resolution_status = 'resolved',
        identifier_resolution_confidence = 1,
        updated_at = now()
    FROM targets tg
    JOIN public.products p ON p.id = tg.product_id AND p.deleted_at IS NULL
    WHERE t.id = tg.id AND tg.product_id IS NOT NULL
    RETURNING t.id::text
    `,
    [ORG_ID, STORE_ID, DERIVED_SOURCES],
  );

  const ambiguous = await client.query(
    `
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id,
        NULLIF(TRIM(e.sku), '') AS sku,
        NULLIF(TRIM(e.fnsku), '') AS fnsku
      FROM public.expected_packages e
      WHERE e.organization_id = $1::uuid AND e.store_id = $2::uuid
        AND e.build_source = ANY($3::text[])
        AND e.resolved_product_id IS NULL
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.fnsku IS NOT NULL AND m.fnsku = ep.fnsku
      GROUP BY ep.id
    ),
    map_sku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS product_count
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL AND ep.sku IS NOT NULL AND (m.seller_sku = ep.sku OR m.msku = ep.sku)
      GROUP BY ep.id
    ),
    targets AS (
      SELECT ep.id
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id = ep.id
      LEFT JOIN map_sku ms ON ms.id = ep.id
      WHERE COALESCE(mf.product_count, 0) > 1 OR COALESCE(ms.product_count, 0) > 1
    )
    UPDATE public.expected_packages t
    SET identifier_resolution_status = 'ambiguous',
        identifier_resolution_confidence = NULL,
        updated_at = now()
    FROM targets tg
    WHERE t.id = tg.id
    RETURNING t.id::text
    `,
    [ORG_ID, STORE_ID, DERIVED_SOURCES],
  );

  return { set_resolved: resolved.rowCount ?? 0, ambiguous: ambiguous.rowCount ?? 0 };
}

async function directOwnershipLink(client: pg.Client): Promise<number> {
  const r = await client.query(
    `
    WITH ep AS (
      SELECT e.id, NULLIF(TRIM(e.fnsku), '') AS fnsku
      FROM public.expected_packages e
      WHERE e.organization_id = $1::uuid AND e.store_id = $2::uuid
        AND e.build_source = ANY($3::text[])
        AND e.resolved_product_id IS NULL
        AND NULLIF(TRIM(e.fnsku), '') IS NOT NULL
    ),
    fnsku_owner AS (
      SELECT ep.id, (array_agg(p.id ORDER BY p.id))[1] AS product_id
      FROM ep
      JOIN public.products p
        ON p.organization_id = $1::uuid AND p.store_id = $2::uuid AND p.deleted_at IS NULL
       AND p.fnsku = ep.fnsku
      GROUP BY ep.id
      HAVING COUNT(DISTINCT p.id) = 1
    )
    UPDATE public.expected_packages t
    SET resolved_product_id = tg.product_id,
        identifier_resolution_status = 'resolved',
        identifier_resolution_confidence = 0.95,
        updated_at = now()
    FROM fnsku_owner tg
    JOIN public.products p ON p.id = tg.product_id AND p.deleted_at IS NULL
    WHERE t.id = tg.id
    RETURNING t.id::text
    `,
    [ORG_ID, STORE_ID, DERIVED_SOURCES],
  );
  return r.rowCount ?? 0;
}

function loadMapPlan(): PlanMapRow[] {
  const p = path.join(process.cwd(), PLAN_DIR, "safe-map-replay-plan.json");
  if (!fs.existsSync(p)) return [];
  return (JSON.parse(fs.readFileSync(p, "utf8")) as { rows?: PlanMapRow[] }).rows ?? [];
}

function loadCreateCandidates(): CreateCandidate[] {
  const p = path.join(process.cwd(), PLAN_DIR, "product-create-candidates.json");
  if (!fs.existsSync(p)) throw new Error(`Missing ${p}`);
  return (JSON.parse(fs.readFileSync(p, "utf8")) as { rows?: CreateCandidate[] }).rows ?? [];
}

function dedupePromoteRows(candidates: CreateCandidate[]): PromoteRow[] {
  const byProduct = new Map<string, PromoteRow>();
  for (const c of candidates) {
    const ex = byProduct.get(c.staging_product_id);
    if (ex) {
      ex.expected_package_ids.push(c.expected_package_id);
      continue;
    }
    byProduct.set(c.staging_product_id, {
      staging_product_id: c.staging_product_id,
      staging_map_id: c.staging_map_id,
      staging_match_source: c.staging_match_source,
      sku: c.sku,
      fnsku: c.fnsku,
      asin: c.asin,
      upc: c.upc,
      governed_execute: c.governed_execute,
      expected_package_ids: [c.expected_package_id],
      blockers: [],
      safe: false,
    });
  }
  return [...byProduct.values()];
}

async function assessPromoteSafety(
  staging: pg.Client,
  original: pg.Client,
  rows: PromoteRow[],
): Promise<void> {
  for (const row of rows) {
    const blockers: string[] = [];

    const stagingProd = await staging.query(
      `SELECT id::text, sku, fnsku, asin, vendor_name, product_name
       FROM public.products WHERE id = $1::uuid AND deleted_at IS NULL`,
      [row.staging_product_id],
    );
    if (!stagingProd.rows.length) blockers.push("staging_product_missing");

    const stagingMap = await staging.query(
      `SELECT id::text, product_id::text, fnsku, seller_sku, msku, asin, match_source
       FROM public.product_identifier_map WHERE id = $1::uuid AND deleted_at IS NULL`,
      [row.staging_map_id],
    );
    if (!stagingMap.rows.length) blockers.push("staging_map_missing");
    else if (String((stagingMap.rows[0] as { product_id: string }).product_id) !== row.staging_product_id) {
      blockers.push("staging_map_product_mismatch");
    }

    if (row.fnsku) {
      const sf = await staging.query(
        `SELECT COUNT(DISTINCT id)::int AS c FROM public.products
         WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL AND fnsku = $3`,
        [ORG_ID, STORE_ID, row.fnsku],
      );
      if ((sf.rows[0] as { c: number }).c !== 1) blockers.push("staging_fnsku_not_unique");

      const of = await original.query(
        `SELECT array_agg(id::text) AS ids FROM public.products
         WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL AND fnsku = $3`,
        [ORG_ID, STORE_ID, row.fnsku],
      );
      const ids = ((of.rows[0] as { ids: string[] | null }).ids ?? []).filter(Boolean);
      if (ids.length > 1) blockers.push("original_fnsku_ambiguous");
      if (ids.length === 1 && ids[0] !== row.staging_product_id) blockers.push("original_fnsku_owned_by_other_product");

      const om = await original.query(
        `SELECT COUNT(DISTINCT product_id)::int AS c FROM public.product_identifier_map
         WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
           AND fnsku = $3 AND product_id IS DISTINCT FROM $4::uuid`,
        [ORG_ID, STORE_ID, row.fnsku, row.staging_product_id],
      );
      if ((om.rows[0] as { c: number }).c > 0) blockers.push("original_map_fnsku_conflict");
    }

    if (row.sku) {
      const os = await original.query(
        `SELECT array_agg(id::text) AS ids FROM public.products
         WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL AND sku = $3`,
        [ORG_ID, STORE_ID, row.sku],
      );
      const ids = ((os.rows[0] as { ids: string[] | null }).ids ?? []).filter(Boolean);
      if (ids.length > 1) blockers.push("original_sku_ambiguous");
      if (ids.length === 1 && ids[0] !== row.staging_product_id) blockers.push("original_sku_owned_by_other_product");
    }

    const origExists = await original.query(
      `SELECT 1 FROM public.products WHERE id = $1::uuid AND deleted_at IS NULL`,
      [row.staging_product_id],
    );
    if (origExists.rows.length) {
      row.blockers = blockers.length ? blockers : ["product_exists_map_only"];
      row.safe = blockers.length === 0;
      continue;
    }

    const sp = stagingProd.rows[0] as { vendor_name?: string | null; sku?: string | null };
    if (/1883/i.test(String(sp.sku ?? "")) && String(sp.vendor_name ?? "").trim() === "1883") {
      blockers.push("staging_vendor_bare_1883");
    }

    row.blockers = blockers;
    row.safe = blockers.length === 0;
  }
}

async function insertMapReplayRows(
  original: pg.Client,
  planRows: PlanMapRow[],
): Promise<{ inserted: Record<string, unknown>[]; skipped: number }> {
  if (!planRows.length) return { inserted: [], skipped: 0 };
  const insertable = planRows.map((row) => ({
    organization_id: ORG_ID,
    store_id: STORE_ID,
    product_id: row.product_id,
    seller_sku: row.seller_sku,
    msku: row.seller_sku,
    fnsku: row.fnsku,
    match_source: row.match_source,
    source_report_type: row.match_source,
    external_listing_id: externalListingId(
      row.match_source,
      row.product_id,
      row.fnsku,
      row.seller_sku,
    ),
  }));

  const ins = await original.query(
    `
    WITH input AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
        organization_id uuid, store_id uuid, product_id uuid,
        seller_sku text, msku text, fnsku text,
        match_source text, source_report_type text, external_listing_id text
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
      RETURNING id::text, product_id::text, fnsku, external_listing_id
    )
    SELECT * FROM inserted
    `,
    [JSON.stringify(insertable)],
  );
  return { inserted: ins.rows as Record<string, unknown>[], skipped: planRows.length - ins.rowCount! };
}

async function promoteSafeProducts(
  staging: pg.Client,
  original: pg.Client,
  rows: PromoteRow[],
): Promise<{
  products_created: Record<string, unknown>[];
  maps_inserted: Record<string, unknown>[];
  blocked: PromoteRow[];
}> {
  const products_created: Record<string, unknown>[] = [];
  const maps_inserted: Record<string, unknown>[] = [];
  const blocked: PromoteRow[] = [];

  for (const row of rows) {
    if (!row.safe) {
      blocked.push(row);
      continue;
    }

    const exists = await original.query(
      `SELECT 1 FROM public.products WHERE id = $1::uuid AND deleted_at IS NULL`,
      [row.staging_product_id],
    );

    if (!exists.rows.length) {
      const sp = await staging.query(
        `SELECT id, organization_id, store_id, product_name, sku, fnsku, asin, vendor_name, status, metadata
         FROM public.products WHERE id = $1::uuid AND deleted_at IS NULL`,
        [row.staging_product_id],
      );
      const p = sp.rows[0] as Record<string, unknown>;
      const ins = await original.query(
        `INSERT INTO public.products (
          id, organization_id, store_id, product_name, sku, fnsku, asin, vendor_name, status,
          metadata, first_seen_at, last_seen_at, created_at, updated_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, COALESCE($9, 'active'),
          COALESCE($10::jsonb, '{}'::jsonb) || jsonb_build_object(
            'original_parity_expansion', $11::text,
            'staging_match_source', $12::text,
            'governed_execute', $13::text
          ),
          now(), now(), now(), now()
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING id::text, sku, fnsku, asin, vendor_name`,
        [
          p.id,
          p.organization_id,
          p.store_id,
          p.product_name,
          p.sku,
          p.fnsku,
          p.asin,
          p.vendor_name,
          p.status,
          p.metadata ? JSON.stringify(p.metadata) : null,
          EXPANSION_MATCH_SOURCE,
          row.staging_match_source,
          row.governed_execute,
        ],
      );
      if (ins.rows.length) products_created.push(ins.rows[0] as Record<string, unknown>);
    }

    const sm = await staging.query(
      `SELECT organization_id, store_id, product_id, seller_sku, msku, fnsku, asin, match_source, source_report_type
       FROM public.product_identifier_map WHERE id = $1::uuid AND deleted_at IS NULL`,
      [row.staging_map_id],
    );
    const m = sm.rows[0] as Record<string, unknown>;
    const extId = externalListingId(
      String(m.match_source ?? row.staging_match_source),
      row.staging_product_id,
      row.fnsku,
      row.sku,
    );

    const mapIns = await original.query(
      `INSERT INTO public.product_identifier_map (
        organization_id, store_id, product_id, seller_sku, msku, fnsku, asin,
        match_source, source_report_type, external_listing_id, is_primary,
        first_seen_at, last_seen_at, created_at, updated_at
      )
      SELECT $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7,
        $8, $9, $10, true, now(), now(), now(), now()
      WHERE NOT EXISTS (
        SELECT 1 FROM public.product_identifier_map m
        WHERE m.external_listing_id = $10 OR (
          m.organization_id = $1::uuid AND m.store_id = $2::uuid AND m.deleted_at IS NULL
          AND m.product_id = $3::uuid AND m.fnsku IS NOT DISTINCT FROM $6
        )
      )
      RETURNING id::text, product_id::text, external_listing_id, fnsku`,
      [
        m.organization_id,
        m.store_id,
        row.staging_product_id,
        m.seller_sku ?? row.sku,
        m.msku ?? row.sku,
        m.fnsku ?? row.fnsku,
        m.asin ?? row.asin,
        m.match_source ?? row.staging_match_source,
        m.source_report_type ?? row.staging_match_source,
        extId,
      ],
    );

    if (mapIns.rows.length) maps_inserted.push(mapIns.rows[0] as Record<string, unknown>);
    else {
      const hit = await original.query(
        `SELECT id::text FROM public.product_identifier_map
         WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
           AND product_id = $3::uuid AND fnsku IS NOT DISTINCT FROM $4`,
        [ORG_ID, STORE_ID, row.staging_product_id, row.fnsku],
      );
      if (!hit.rows.length) blocked.push({ ...row, blockers: [...row.blockers, "map_insert_failed"] });
    }
  }

  return { products_created, maps_inserted, blocked };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`branch=${branch}`);
  if (apply && !readApproval()) blockers.push("Approval flags not both true");
  if (!apply) blockers.push("Pass --apply to execute original writes");

  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!stagingUrl || !originalUrl) blockers.push("Missing postgres URLs");
  if (stagingUrl && refFromConnectionUrl(stagingUrl) !== STAGING_REF) blockers.push("Staging ref guard");
  if (originalUrl && refFromConnectionUrl(originalUrl) !== ORIGINAL_REF) blockers.push("Original ref guard");
  if (stagingUrl && originalUrl && stagingUrl === originalUrl) blockers.push("URLs must differ");

  const mapPlan = loadMapPlan();
  const createCandidates = loadCreateCandidates();
  const promoteRows = dedupePromoteRows(createCandidates);

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    throw new Error(blockers.join("; "));
  }

  const staging = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
  const original = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
  await staging.connect();
  await original.connect();
  await staging.query("SET statement_timeout = '600s'");
  await original.query("SET statement_timeout = '600s'");

  const beforeEp = await epCensus(original);
  const beforeProducts = (
    await original.query(`SELECT COUNT(*)::int AS c FROM public.products WHERE deleted_at IS NULL`)
  ).rows[0] as { c: number };
  const beforeMap = (
    await original.query(`SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`)
  ).rows[0] as { c: number };

  await assessPromoteSafety(staging, original, promoteRows);
  const safePromote = promoteRows.filter((r) => r.safe);
  const unsafePromote = promoteRows.filter((r) => !r.safe);

  fs.writeFileSync(
    path.join(outDir, "phase2-promote-assessment.json"),
    JSON.stringify(
      {
        total_distinct_products: promoteRows.length,
        safe_count: safePromote.length,
        unsafe_count: unsafePromote.length,
        safe_rows: safePromote,
        blocked_rows: unsafePromote,
      },
      null,
      2,
    ),
  );

  let phase1Maps: Record<string, unknown>[] = [];
  let phase1Skipped = 0;
  let phase2Products: Record<string, unknown>[] = [];
  let phase2Maps: Record<string, unknown>[] = [];
  let phase2Blocked: PromoteRow[] = [];
  let resolverAfterPhase1 = { set_resolved: 0, ambiguous: 0 };
  let resolverAfterPhase2 = { set_resolved: 0, ambiguous: 0 };
  let directLinked = 0;

  await original.query("BEGIN");
  try {
    if (mapPlan.length) {
      const p1 = await insertMapReplayRows(original, mapPlan);
      phase1Maps = p1.inserted;
      phase1Skipped = p1.skipped;
    }
    resolverAfterPhase1 = await runResolverBackfill(original);

    const p2 = await promoteSafeProducts(staging, original, safePromote);
    phase2Products = p2.products_created;
    phase2Maps = p2.maps_inserted;
    phase2Blocked = p2.blocked;

    resolverAfterPhase2 = await runResolverBackfill(original);
    directLinked = await directOwnershipLink(original);

    await original.query("COMMIT");
  } catch (e) {
    await original.query("ROLLBACK");
    throw e;
  }

  const afterEp = await epCensus(original);
  const afterProducts = (
    await original.query(`SELECT COUNT(*)::int AS c FROM public.products WHERE deleted_at IS NULL`)
  ).rows[0] as { c: number };
  const afterMap = (
    await original.query(`SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`)
  ).rows[0] as { c: number };

  await staging.end();
  await original.end();

  const rollbackParts = [
    "-- Rollback original safe bulk product linkage expansion",
    phase2Maps.length
      ? `DELETE FROM public.product_identifier_map WHERE external_listing_id IN (${phase2Maps
          .map((r) => `'${String(r.external_listing_id).replace(/'/g, "''")}'`)
          .join(", ")});`
      : "-- no phase2 maps",
    phase1Maps.length
      ? `DELETE FROM public.product_identifier_map WHERE external_listing_id IN (${phase1Maps
          .map((r) => `'${String(r.external_listing_id).replace(/'/g, "''")}'`)
          .join(", ")});`
      : "-- no phase1 maps",
    phase2Products.length
      ? `DELETE FROM public.products WHERE id IN (${phase2Products
          .map((r) => `'${String(r.id).replace(/'/g, "''")}'::uuid`)
          .join(", ")});`
      : "-- no products created",
  ];
  fs.writeFileSync(path.join(outDir, "rollback.sql"), rollbackParts.join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "inserted-map-rows.json"), JSON.stringify([...phase1Maps, ...phase2Maps], null, 2));
  fs.writeFileSync(path.join(outDir, "inserted-products.json"), JSON.stringify(phase2Products, null, 2));
  fs.writeFileSync(path.join(outDir, "conflict-queue.json"), JSON.stringify(phase2Blocked, null, 2));

  const exactBlockers =
    phase2Blocked.length > 0
      ? phase2Blocked.slice(0, 20).map((r) => `${r.staging_product_id}: ${r.blockers.join(", ")}`)
      : [];

  const manifest = {
    prompt: "ORIGINAL SAFE BULK PRODUCT LINKAGE EXPANSION",
    run_id: runId,
    plan_run_id: PLAN_RUN_ID,
    branch,
    original_ref: ORIGINAL_REF,
    staging_ref: STAGING_REF,
    phase1_map_replay_planned: mapPlan.length,
    maps_inserted_phase1: phase1Maps.length,
    maps_inserted_phase2: phase2Maps.length,
    maps_inserted_total: phase1Maps.length + phase2Maps.length,
    products_created: phase2Products.length,
    direct_ownership_linked: directLinked,
    resolved_before: beforeEp.ep_resolved,
    resolved_after: afterEp.ep_resolved,
    unresolved_before: beforeEp.ep_derived_unresolved,
    unresolved_after: afterEp.ep_derived_unresolved,
    ambiguous_after: afterEp.ep_ambiguous,
    conflict_queue_count: phase2Blocked.length,
    safe_promote_assessed: safePromote.length,
    unsafe_promote_assessed: unsafePromote.length,
    no_governed_match_remaining: Math.max(
      0,
      (afterEp.ep_derived_unresolved ?? 0) - safePromote.length,
    ),
    resolver_phase1_set_resolved: resolverAfterPhase1.set_resolved,
    resolver_phase2_set_resolved: resolverAfterPhase2.set_resolved,
    before_products: beforeProducts.c,
    after_products: afterProducts.c,
    before_map: beforeMap.c,
    after_map: afterMap.c,
    exact_blockers: exactBlockers,
    exact_next_prompt:
      afterEp.ep_derived_unresolved > 0
        ? "ORIGINAL-SAFE-LINKAGE-EXPANSION-REVIEW — triage conflict queue + no_governed_match cohort"
        : "ORIGINAL-PARITY-LINKAGE-CLOSEOUT — derived EP fully resolved",
  };

  fs.writeFileSync(
    path.join(outDir, "execute-result.md"),
    [
      "# Original safe bulk product linkage expansion",
      "",
      `| Metric | Before | After | Delta |`,
      `|--------|-------:|------:|------:|`,
      `| EP resolved (all) | ${beforeEp.ep_resolved} | **${afterEp.ep_resolved}** | +${afterEp.ep_resolved - beforeEp.ep_resolved} |`,
      `| EP unresolved (derived) | ${beforeEp.ep_derived_unresolved} | **${afterEp.ep_derived_unresolved}** | ${afterEp.ep_derived_unresolved - beforeEp.ep_derived_unresolved} |`,
      `| EP ambiguous | ${beforeEp.ep_ambiguous} | **${afterEp.ep_ambiguous}** | ${afterEp.ep_ambiguous - beforeEp.ep_ambiguous} |`,
      `| products | ${beforeProducts.c} | **${afterProducts.c}** | +${afterProducts.c - beforeProducts.c} |`,
      `| active map rows | ${beforeMap.c} | **${afterMap.c}** | +${afterMap.c - beforeMap.c} |`,
      "",
      "## Writes",
      "",
      `- Phase 1 map replay inserts: **${phase1Maps.length}** (planned ${mapPlan.length} — prior execute may have applied cohort)`,
      `- Phase 2 products created: **${phase2Products.length}**`,
      `- Phase 2 map inserts: **${phase2Maps.length}**`,
      `- Direct ownership EP links: **${directLinked}**`,
      `- Resolver set_resolved (phase1/phase2): **${resolverAfterPhase1.set_resolved}** / **${resolverAfterPhase2.set_resolved}**`,
      `- Conflict/blocked queue: **${phase2Blocked.length}**`,
      "",
      exactBlockers.length ? `## Sample blockers\n\n${exactBlockers.map((b) => `- ${b}`).join("\n")}` : "",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(path.join(outDir, "blockers.md"), exactBlockers.length ? exactBlockers.map((b) => `- ${b}`).join("\n") + "\n" : "# Blockers\n\nNone.\n");
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
