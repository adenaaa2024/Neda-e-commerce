/**
 * PC03-EXEC — EXPECTED-PACKAGES-DIRTY-SOURCE-FIX-EXECUTE
 *
 * Approval-gated staging execute:
 * 1) Fix 21 high-confidence dirty EP sku/fnsku from quarantine plan
 * 2) Map-only insert for post-fix deterministic rows
 * 3) Quarantine 17 operator-manual dirty EP rows (status flag, no delete)
 * 4) return_items / slip_contents map-only backfill where deterministic after map gap fill
 *
 *   npx tsx scripts/pc03-exec-expected-packages-dirty-source-fix-execute.ts --run-id=<UTC_Z>
 *   npx tsx scripts/pc03-exec-expected-packages-dirty-source-fix-execute.ts --plan-run-id=20260523T050000Z
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
const PLAN_DEFAULT = "20260523T050000Z";
const PLAN_BASE = ".cursor/audit-reports/pc03-expected-packages-dirty-source-quarantine-plan";
const APPROVAL_PATH =
  ".cursor/operator-approvals/pc03-expected-packages-dirty-source-fix-execute-approval.md";
const OUT_BASE = ".cursor/audit-reports/pc03-exec-expected-packages-dirty-source-fix-execute";
const MATCH_SOURCE = "expected_packages_pc03exec_dirty_source_map";
const QUARANTINE_STATUS = "quarantined_dirty_source";

type ApplyRow = {
  expected_package_id: string;
  current: { sku: string | null; fnsku: string | null };
  proposed: { sku: string | null; fnsku: string | null };
  fix_basis: string;
};

type HighConfidenceRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string;
  misplaced_asin: string | null;
  proposed_fix: { sku: string | null; fnsku: string | null };
  post_fix_map_only: {
    eligible: boolean;
    recommended_product_id: string | null;
  };
};

type DirtyRow = {
  expected_package_id: string;
  quarantine_action: string;
  sku: string | null;
  fnsku: string | null;
};

type MapInsert = {
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
  expected_package_id: string;
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

function planRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--plan-run-id="));
  return a ? a.split("=")[1]!.trim() : PLAN_DEFAULT;
}

function readApproval(): boolean {
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_PC03_EXPECTED_PACKAGES_DIRTY_SOURCE_FIX\s*=\s*true/i.test(text)
  );
}

function loadPlan(planRunId: string) {
  const dir = path.join(process.cwd(), PLAN_BASE, planRunId);
  const fixes = JSON.parse(
    fs.readFileSync(path.join(dir, "proposed-source-fixes.json"), "utf8"),
  ) as { apply_on_execute: ApplyRow[]; high_confidence_fixes: HighConfidenceRow[] };
  const dirty = JSON.parse(fs.readFileSync(path.join(dir, "dirty-rows-detail.json"), "utf8")) as {
    rows: DirtyRow[];
  };
  return { dir, fixes, dirty };
}

async function epCoverage(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(`
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id,
        NULLIF(TRIM(e.sku), '') AS sku, NULLIF(TRIM(e.fnsku), '') AS fnsku, e.resolved_product_id
      FROM public.expected_packages e
    ),
    map_fnsku AS (
      SELECT ep.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM ep
      LEFT JOIN public.product_identifier_map m
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
          WHEN COALESCE(mf.c,0)=1 OR COALESCE(ms.c,0)=1 THEN 'resolved'
          WHEN COALESCE(mf.c,0)>1 OR COALESCE(ms.c,0)>1 THEN 'ambiguous'
          ELSE 'unresolved'
        END AS bucket
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id=ep.id
      LEFT JOIN map_sku ms ON ms.id=ep.id
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket='resolved')::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE bucket='unresolved')::int AS unresolved,
      COUNT(*) FILTER (WHERE bucket='ambiguous')::int AS ambiguous
    FROM classified
  `);
  return r.rows[0] as Record<string, number>;
}

async function itemTableCoverage(
  client: pg.Client,
  table: "return_items" | "slip_contents",
): Promise<{ total: number; resolved: number; unresolved: number }> {
  const filter = table === "return_items" ? "deleted_at IS NULL" : "TRUE";
  const hasSku = table === "return_items";
  const skuExpr = hasSku ? "NULLIF(TRIM(sku),'')" : "NULL::text";
  const mapSkuCte = hasSku
    ? `
    map_sku AS (
      SELECT b.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM base b
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id=b.organization_id AND m.store_id=b.store_id
       AND m.deleted_at IS NULL AND b.sku IS NOT NULL AND (m.seller_sku=b.sku OR m.msku=b.sku)
      GROUP BY b.id
    )`
    : `map_sku AS (SELECT b.id, 0::int AS c FROM base b)`;
  const resolvedCheck =
    table === "return_items"
      ? "b.resolved_product_id IS NOT NULL OR b.product_id IS NOT NULL"
      : "b.resolved_product_id IS NOT NULL";

  const r = await client.query(`
    WITH base AS (
      SELECT id, organization_id, store_id, ${skuExpr} AS sku,
        NULLIF(TRIM(fnsku),'') AS fnsku,
        resolved_product_id${table === "return_items" ? ", product_id" : ""}
      FROM public.${table} WHERE ${filter}
    ),
    map_fnsku AS (
      SELECT b.id, COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS c
      FROM base b
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id=b.organization_id AND m.store_id=b.store_id
       AND m.deleted_at IS NULL AND b.fnsku IS NOT NULL AND m.fnsku=b.fnsku
      GROUP BY b.id
    ),
    ${mapSkuCte},
    classified AS (
      SELECT b.id,
        CASE
          WHEN ${resolvedCheck} THEN 'resolved'
          WHEN COALESCE(mf.c,0)=1 OR COALESCE(ms.c,0)=1 THEN 'resolved'
          ELSE 'unresolved'
        END AS bucket
      FROM base b
      LEFT JOIN map_fnsku mf ON mf.id=b.id
      LEFT JOIN map_sku ms ON ms.id=b.id
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket='resolved')::int AS resolved,
      COUNT(*) FILTER (WHERE bucket='unresolved')::int AS unresolved
    FROM classified
  `);
  return r.rows[0] as { total: number; resolved: number; unresolved: number };
}

function dedupeMapPlan(rows: MapInsert[]): MapInsert[] {
  const seen = new Set<string>();
  const out: MapInsert[] = [];
  for (const row of rows) {
    const key = `${row.organization_id}|${row.store_id}|${row.seller_sku ?? ""}|${row.fnsku ?? ""}|${row.product_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function toMapPlan(rows: HighConfidenceRow[], executeRunId: string): MapInsert[] {
  const out: MapInsert[] = [];
  for (const row of rows) {
    if (!row.post_fix_map_only.eligible || !row.post_fix_map_only.recommended_product_id) continue;
    const sku = row.proposed_fix.sku;
    const fnsku = row.proposed_fix.fnsku;
    if (!sku && !fnsku) continue;
    out.push({
      organization_id: row.organization_id,
      store_id: row.store_id,
      product_id: row.post_fix_map_only.recommended_product_id,
      seller_sku: sku,
      msku: sku,
      fnsku,
      asin: row.misplaced_asin,
      match_source: MATCH_SOURCE,
      source_report_type: MATCH_SOURCE,
      external_listing_id: `pc03exec|${executeRunId}|${row.expected_package_id}`,
      expected_package_id: row.expected_package_id,
    });
  }
  return dedupeMapPlan(out);
}

async function backfillDeterministic(
  client: pg.Client,
  table: "return_items" | "slip_contents",
): Promise<Array<{ id: string; product_id: string }>> {
  const filter = table === "return_items" ? "AND e.deleted_at IS NULL" : "";
  const hasSku = table === "return_items";
  const skuJoin = hasSku
    ? `OR (e.sku IS NOT NULL AND (m.seller_sku = e.sku OR m.msku = e.sku))`
    : "";
  const resolvedNull =
    table === "return_items"
      ? "e.resolved_product_id IS NULL AND (e.product_id IS NULL)"
      : "e.resolved_product_id IS NULL";
  const setClause =
    table === "return_items"
      ? `resolved_product_id = s.product_id::uuid,
          identifier_resolution_status = 'resolved',
          updated_at = now()`
      : `resolved_product_id = s.product_id::uuid,
          identifier_resolution_status = 'resolved'`;

  const r = await client.query(`
    WITH matches AS (
      SELECT e.id, ARRAY_AGG(DISTINCT m.product_id) AS pids
      FROM public.${table} e
      JOIN public.product_identifier_map m
        ON m.organization_id = e.organization_id AND m.store_id = e.store_id
       AND m.deleted_at IS NULL
       AND (
         (e.fnsku IS NOT NULL AND m.fnsku = e.fnsku)
         ${skuJoin}
       )
      WHERE ${resolvedNull} ${filter}
      GROUP BY e.id
    ),
    single AS (
      SELECT id, pids[1]::text AS product_id
      FROM matches
      WHERE CARDINALITY(pids) = 1
    ),
    updated AS (
      UPDATE public.${table} t
      SET ${setClause}
      FROM single s
      WHERE t.id = s.id
      RETURNING t.id::text, s.product_id
    )
    SELECT * FROM updated
  `);
  return r.rows as Array<{ id: string; product_id: string }>;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const planRunId = planRunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  if (!readApproval()) {
    throw new Error(`Approval flags not true in ${APPROVAL_PATH}`);
  }

  const { fixes, dirty } = loadPlan(planRunId);
  const applyRows = fixes.apply_on_execute ?? [];
  const mapPlan = toMapPlan(fixes.high_confidence_fixes ?? [], runId);
  const quarantineRows = dirty.rows.filter((r) => r.quarantine_action === "operator_manual");

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (
    !dbUrl ||
    getStagingProjectRef({ loadEnv: false }) !== STAGING_REF ||
    !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)
  ) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const beforeEp = await epCoverage(client);
  const beforeRi = await itemTableCoverage(client, "return_items");
  const beforeSc = await itemTableCoverage(client, "slip_contents");

  const epIds = applyRows.map((r) => r.expected_package_id);
  const preimageEp = await client.query(
    `SELECT id::text, sku, fnsku, order_id, order_type, disposition,
            identifier_resolution_status, identifier_resolution_confidence
     FROM public.expected_packages WHERE id = ANY($1::uuid[])`,
    [epIds],
  );
  const quarantineIds = quarantineRows.map((r) => r.expected_package_id);
  const preimageQuarantine = await client.query(
    `SELECT id::text, sku, fnsku, identifier_resolution_status, identifier_resolution_confidence
     FROM public.expected_packages WHERE id = ANY($1::uuid[])`,
    [quarantineIds],
  );

  const duplicateBlocked = await client.query(
    `
    WITH input AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
        expected_package_id uuid, proposed_sku text, proposed_fnsku text
      )
    ),
    ctx AS (
      SELECT i.expected_package_id, i.proposed_sku, i.proposed_fnsku,
        e.organization_id, e.store_id, e.order_id, e.order_type, e.disposition
      FROM input i
      JOIN public.expected_packages e ON e.id = i.expected_package_id
    )
    SELECT c.expected_package_id::text, e2.id::text AS existing_row_id
    FROM ctx c
    JOIN public.expected_packages e2
      ON e2.organization_id = c.organization_id AND e2.store_id = c.store_id
     AND e2.order_id IS NOT DISTINCT FROM c.order_id
     AND e2.order_type IS NOT DISTINCT FROM c.order_type
     AND e2.disposition IS NOT DISTINCT FROM c.disposition
     AND COALESCE(NULLIF(TRIM(e2.sku), ''), '') = COALESCE(c.proposed_sku, '')
     AND COALESCE(NULLIF(TRIM(e2.fnsku), ''), '') = COALESCE(c.proposed_fnsku, '')
     AND e2.id IS DISTINCT FROM c.expected_package_id
    `,
    [
      JSON.stringify(
        applyRows.map((r) => ({
          expected_package_id: r.expected_package_id,
          proposed_sku: r.proposed.sku,
          proposed_fnsku: r.proposed.fnsku,
        })),
      ),
    ],
  );
  const blockedIds = new Set(
    (duplicateBlocked.rows as Array<{ expected_package_id: string }>).map((r) => r.expected_package_id),
  );
  const safeApplyRows = applyRows.filter((r) => !blockedIds.has(r.expected_package_id));
  const skippedDuplicateRows = applyRows.filter((r) => blockedIds.has(r.expected_package_id));

  const productIds = [...new Set(mapPlan.map((p) => p.product_id))];
  if (productIds.length) {
    const spine = await client.query(
      `SELECT id::text FROM public.products WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [productIds],
    );
    if (spine.rows.length !== productIds.length) {
      throw new Error("Map plan references missing/deleted products");
    }
  }

  const externalIds = mapPlan.map((r) => r.external_listing_id);
  const preExistingMap = externalIds.length
    ? await client.query(
        `SELECT id::text, external_listing_id, product_id::text FROM public.product_identifier_map
         WHERE external_listing_id = ANY($1::text[])`,
        [externalIds],
      )
    : { rows: [] as Record<string, unknown>[] };

  const mapConflictRows = mapPlan.length
    ? await client.query(
        `
        WITH input AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
            organization_id uuid, store_id uuid, product_id uuid,
            seller_sku text, fnsku text, external_listing_id text
          )
        )
        SELECT i.external_listing_id, 'fnsku_conflict' AS conflict_type, m.id::text AS map_id
        FROM input i
        JOIN public.product_identifier_map m
          ON m.organization_id=i.organization_id AND m.store_id=i.store_id
         AND m.deleted_at IS NULL AND i.fnsku IS NOT NULL AND m.fnsku=i.fnsku
        WHERE m.product_id IS DISTINCT FROM i.product_id
        UNION ALL
        SELECT i.external_listing_id, 'sku_conflict', m.id::text
        FROM input i
        JOIN public.product_identifier_map m
          ON m.organization_id=i.organization_id AND m.store_id=i.store_id
         AND m.deleted_at IS NULL AND i.seller_sku IS NOT NULL
         AND (m.seller_sku=i.seller_sku OR m.msku=i.seller_sku)
        WHERE m.product_id IS DISTINCT FROM i.product_id
      `,
        [JSON.stringify(mapPlan)],
      )
    : { rows: [] as Record<string, unknown>[] };

  if (mapConflictRows.rows.length > 0) {
    fs.writeFileSync(path.join(outDir, "map-product-conflicts.json"), JSON.stringify(mapConflictRows.rows, null, 2));
  }

  fs.writeFileSync(path.join(outDir, "skipped-duplicate-canonical.json"), JSON.stringify(skippedDuplicateRows, null, 2));

  fs.writeFileSync(
    path.join(outDir, "preimage.json"),
    JSON.stringify(
      {
        plan_run_id: planRunId,
        apply_rows: applyRows.length,
        safe_apply_rows: safeApplyRows.length,
        skipped_duplicate_canonical: skippedDuplicateRows.length,
        map_plan_rows: mapPlan.length,
        quarantine_rows: quarantineRows.length,
        before_ep_coverage: beforeEp,
        before_return_items: beforeRi,
        before_slip_contents: beforeSc,
        expected_packages_preimage: preimageEp.rows,
        quarantine_preimage: preimageQuarantine.rows,
      },
      null,
      2,
    ),
  );

  let sourceFixUpdates: Record<string, unknown>[] = [];
  let insertedMap: Record<string, unknown>[] = [];
  let quarantined: Record<string, unknown>[] = [];
  let returnBackfill: Array<{ id: string; product_id: string }> = [];
  let slipBackfill: Array<{ id: string; product_id: string }> = [];
  let skippedMapExisting: MapInsert[] = [];

  await client.query("BEGIN");
  try {
    if (safeApplyRows.length) {
      const upd = await client.query(
        `
        WITH input AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
            expected_package_id uuid,
            current_sku text, current_fnsku text,
            proposed_sku text, proposed_fnsku text
          )
        ),
        updated AS (
          UPDATE public.expected_packages e
          SET sku = i.proposed_sku,
              fnsku = i.proposed_fnsku,
              identifier_resolution_status = 'unresolved',
              identifier_resolution_confidence = NULL,
              updated_at = now()
          FROM input i
          WHERE e.id = i.expected_package_id
            AND COALESCE(NULLIF(TRIM(e.sku), ''), '') = COALESCE(i.current_sku, '')
            AND COALESCE(NULLIF(TRIM(e.fnsku), ''), '') = COALESCE(i.current_fnsku, '')
          RETURNING e.id::text, i.current_sku, i.current_fnsku, e.sku AS new_sku, e.fnsku AS new_fnsku
        )
        SELECT * FROM updated
      `,
        [
          JSON.stringify(
            safeApplyRows.map((r) => ({
              expected_package_id: r.expected_package_id,
              current_sku: r.current.sku,
              current_fnsku: r.current.fnsku,
              proposed_sku: r.proposed.sku,
              proposed_fnsku: r.proposed.fnsku,
            })),
          ),
        ],
      );
      sourceFixUpdates = upd.rows;
      if (sourceFixUpdates.length !== safeApplyRows.length) {
        throw new Error(
          `Expected ${safeApplyRows.length} source fixes, applied ${sourceFixUpdates.length} (preimage mismatch?)`,
        );
      }
    }

    const skippedQuarantineIds = skippedDuplicateRows.map((r) => r.expected_package_id);
    if (skippedQuarantineIds.length) {
      const sq = await client.query(
        `
        UPDATE public.expected_packages e
        SET identifier_resolution_status = $2,
            identifier_resolution_confidence = 0,
            updated_at = now()
        WHERE e.id = ANY($1::uuid[])
        RETURNING e.id::text, e.sku, e.fnsku, e.identifier_resolution_status
      `,
        [skippedQuarantineIds, QUARANTINE_STATUS],
      );
      quarantined.push(...sq.rows);
    }

    const insertable = mapPlan.filter((row) => {
      if (preExistingMap.rows.some((r) => r.external_listing_id === row.external_listing_id)) return false;
      return true;
    });

    const gapFillCheck = insertable.length
      ? await client.query(
          `
          WITH input AS (
            SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
              organization_id uuid, store_id uuid, product_id uuid,
              seller_sku text, fnsku text, external_listing_id text
            )
          )
          SELECT i.external_listing_id,
            EXISTS (
              SELECT 1 FROM public.product_identifier_map m
              WHERE m.organization_id=i.organization_id AND m.store_id=i.store_id
                AND m.deleted_at IS NULL AND i.fnsku IS NOT NULL AND m.fnsku=i.fnsku
            ) AS fnsku_exists,
            EXISTS (
              SELECT 1 FROM public.product_identifier_map m
              WHERE m.organization_id=i.organization_id AND m.store_id=i.store_id
                AND m.deleted_at IS NULL AND i.seller_sku IS NOT NULL
                AND (m.seller_sku=i.seller_sku OR m.msku=i.seller_sku)
            ) AS sku_exists
          FROM input i
        `,
          [JSON.stringify(insertable)],
        )
      : { rows: [] as Array<{ external_listing_id: string; fnsku_exists: boolean; sku_exists: boolean }> };

    const gapFillRows = insertable.filter((row) => {
      const chk = gapFillCheck.rows.find((r) => r.external_listing_id === row.external_listing_id);
      if (!chk) return true;
      const ok = !chk.fnsku_exists && !chk.sku_exists;
      if (!ok) skippedMapExisting.push(row);
      return ok;
    });

    if (gapFillRows.length) {
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
            SELECT 1 FROM public.product_identifier_map m WHERE m.external_listing_id = i.external_listing_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.product_identifier_map m
            WHERE m.organization_id=i.organization_id AND m.store_id=i.store_id
              AND m.deleted_at IS NULL AND i.fnsku IS NOT NULL AND m.fnsku=i.fnsku
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.product_identifier_map m
            WHERE m.organization_id=i.organization_id AND m.store_id=i.store_id
              AND m.deleted_at IS NULL AND i.seller_sku IS NOT NULL
              AND (m.seller_sku=i.seller_sku OR m.msku=i.seller_sku)
          )
          RETURNING id::text, product_id::text, seller_sku, fnsku, asin, external_listing_id
        )
        SELECT * FROM inserted
      `,
        [JSON.stringify(gapFillRows)],
      );
      insertedMap = ins.rows;
    }

    if (quarantineRows.length) {
      const q = await client.query(
        `
        UPDATE public.expected_packages e
        SET identifier_resolution_status = $2,
            identifier_resolution_confidence = 0,
            updated_at = now()
        WHERE e.id = ANY($1::uuid[])
          AND (
            UPPER(COALESCE(NULLIF(TRIM(e.sku), ''), '')) IN ('UNKNOW','UNKNOWN')
            OR COALESCE(NULLIF(TRIM(e.fnsku), ''), '') ~ '^B[0-9A-Z]{9}$'
          )
        RETURNING e.id::text, e.sku, e.fnsku, e.identifier_resolution_status
      `,
        [quarantineIds, QUARANTINE_STATUS],
      );
      quarantined = q.rows;
    }

    returnBackfill = await backfillDeterministic(client, "return_items");
    slipBackfill = await backfillDeterministic(client, "slip_contents");

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  const afterEp = await epCoverage(client);
  const afterRi = await itemTableCoverage(client, "return_items");
  const afterSc = await itemTableCoverage(client, "slip_contents");
  await client.end();

  fs.writeFileSync(path.join(outDir, "source-fix-updates.json"), JSON.stringify(sourceFixUpdates, null, 2));
  fs.writeFileSync(path.join(outDir, "inserted-map-rows.json"), JSON.stringify(insertedMap, null, 2));
  fs.writeFileSync(path.join(outDir, "quarantined-rows.json"), JSON.stringify(quarantined, null, 2));
  fs.writeFileSync(path.join(outDir, "return-slip-backfill.json"), JSON.stringify({ return_items: returnBackfill, slip_contents: slipBackfill }, null, 2));
  fs.writeFileSync(path.join(outDir, "skipped-map-existing-identifier.json"), JSON.stringify(skippedMapExisting, null, 2));

  const rollbackLines: string[] = ["-- PC03-EXEC rollback (staging only)", ""];
  if (insertedMap.length) {
    rollbackLines.push(
      "DELETE FROM public.product_identifier_map",
      `WHERE external_listing_id IN (${insertedMap.map((r) => `'${String(r.external_listing_id).replace(/'/g, "''")}'`).join(", ")});`,
      "",
    );
  }
  for (const row of sourceFixUpdates as Array<{
    id: string;
    current_sku: string;
    current_fnsku: string;
  }>) {
    rollbackLines.push(
      `UPDATE public.expected_packages SET sku = '${String(row.current_sku ?? "").replace(/'/g, "''")}', fnsku = '${String(row.current_fnsku ?? "").replace(/'/g, "''")}' WHERE id = '${row.id}'::uuid;`,
    );
  }
  rollbackLines.push("");
  for (const row of preimageQuarantine.rows as Array<{
    id: string;
    identifier_resolution_status: string | null;
    identifier_resolution_confidence: string | null;
  }>) {
    const st = row.identifier_resolution_status
      ? `'${String(row.identifier_resolution_status).replace(/'/g, "''")}'`
      : "NULL";
    const conf = row.identifier_resolution_confidence ?? "NULL";
    rollbackLines.push(
      `UPDATE public.expected_packages SET identifier_resolution_status = ${st}, identifier_resolution_confidence = ${conf} WHERE id = '${row.id}'::uuid;`,
    );
  }
  rollbackLines.push("");
  for (const row of [...returnBackfill, ...slipBackfill]) {
    const table = returnBackfill.some((x) => x.id === row.id) ? "return_items" : "slip_contents";
    rollbackLines.push(
      `UPDATE public.${table} SET resolved_product_id = NULL, identifier_resolution_status = 'unresolved' WHERE id = '${row.id}'::uuid;`,
    );
  }
  fs.writeFileSync(path.join(outDir, "rollback.sql"), rollbackLines.join("\n"));

  const manifest = {
    prompt: "PC03-EXEC — EXPECTED-PACKAGES-DIRTY-SOURCE-FIX-EXECUTE",
    run_id: runId,
    plan_run_id: planRunId,
    staging_ref: STAGING_REF,
    status: "PASS",
    approval_file: APPROVAL_PATH,
    source_fix_applied: sourceFixUpdates.length,
    source_fix_skipped_duplicate_canonical: skippedDuplicateRows.length,
    map_rows_inserted: insertedMap.length,
    map_rows_skipped_existing_identifier: skippedMapExisting.length,
    quarantined_rows: quarantined.length,
    return_items_backfilled: returnBackfill.length,
    slip_contents_backfilled: slipBackfill.length,
    expected_packages_coverage: {
      before: beforeEp,
      after: afterEp,
      delta_resolved: (afterEp.read_layer_resolved ?? 0) - (beforeEp.read_layer_resolved ?? 0),
      delta_unresolved: (afterEp.unresolved ?? 0) - (beforeEp.unresolved ?? 0),
    },
    return_items: { before: beforeRi, after: afterRi },
    slip_contents: { before: beforeSc, after: afterSc },
    match_source: MATCH_SOURCE,
    forbidden: {
      products_created: false,
      expected_packages_resolved_product_id_bulk: false,
      destructive_deletes: false,
      production: false,
      amazon_api: false,
    },
    next_prompt: "PRODUCT-LINKAGE-TABLE-COVERAGE-AUDIT (re-run) or PC03A re-run",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    [
      "# PC03-EXEC apply result",
      "",
      `- Source identifier fixes: **${sourceFixUpdates.length}**`,
      `- Map-only inserts: **${insertedMap.length}**`,
      `- Quarantined (operator manual): **${quarantined.length}**`,
      `- return_items backfill: **${returnBackfill.length}**`,
      `- slip_contents backfill: **${slipBackfill.length}**`,
      "",
      "## expected_packages read-layer",
      "",
      `- Resolved: ${beforeEp.read_layer_resolved} → **${afterEp.read_layer_resolved}**`,
      `- Unresolved: ${beforeEp.unresolved} → **${afterEp.unresolved}**`,
      "",
      "## return_items / slip_contents",
      "",
      `- return_items resolved: ${beforeRi.resolved} → **${afterRi.resolved}**`,
      `- slip_contents resolved: ${beforeSc.resolved} → **${afterSc.resolved}**`,
    ].join("\n") + "\n",
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
