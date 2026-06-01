/**
 * PRODUCT-LINKAGE-RESOLVER-WAVE-STAGING-EXECUTE
 * Governed staging wave: EP map tiers + return_items resolver + EP→RI copy.
 *
 *   npx tsx scripts/product-linkage-resolver-wave-staging-execute.ts --run-id=<UTC>
 *   npx tsx scripts/product-linkage-resolver-wave-staging-execute.ts --run-id=<UTC> --execute
 *   npx tsx scripts/product-linkage-resolver-wave-staging-execute.ts --run-id=<UTC> --execute --continue-all
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  ensureExpectedPackagesAuditTable,
  initExpectedPackagesAsinExpr,
  probeExpectedPackagesCoverage,
  type ExpectedPackagesTier,
} from "../lib/expected-packages-resolver-backfill-pg";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/product-linkage-resolver-wave-staging-execute";
const APPROVAL_PATH = ".cursor/operator-approvals/product-linkage-resolver-wave-staging-approval.md";
const WAVE_LIMIT_DEFAULT = 250;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function limitArg(): number {
  const a = process.argv.find((x) => x.startsWith("--limit="));
  if (a) return Math.max(1, Math.min(500, Number(a.split("=")[1]) || WAVE_LIMIT_DEFAULT));
  return WAVE_LIMIT_DEFAULT;
}

function readApproval(): boolean {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_PRODUCT_LINKAGE_RESOLVER_WAVE\s*=\s*true/i.test(text) &&
    /APPROVED_PRODUCT_CREATE\s*=\s*false/i.test(text) &&
    /APPROVED_MAP_INSERT\s*=\s*false/i.test(text)
  );
}

function auditTableName(runId: string): string {
  return `pl_wave_audit_${runId.replace(/[^a-z0-9]/gi, "_").slice(0, 24)}`;
}

type Counts = Record<string, number | string | null>;

async function spineCounts(client: pg.Client): Promise<Counts> {
  const r = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.products WHERE deleted_at IS NULL) AS products,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS product_identifier_map_active,
      (SELECT COUNT(*)::int FROM public.catalog_products) AS catalog_products
  `);
  return r.rows[0] as Counts;
}

async function returnItemCounts(client: pg.Client): Promise<Counts> {
  const r = await client.query(`
    SELECT
      COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND resolved_product_id IS NOT NULL)::int AS resolved,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL AND resolved_product_id IS NULL
          AND (
            NULLIF(BTRIM(asin), '') IS NOT NULL OR NULLIF(BTRIM(fnsku), '') IS NOT NULL
            OR NULLIF(BTRIM(sku), '') IS NOT NULL
          )
      )::int AS unresolved_with_identifiers,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL AND package_id IS NOT NULL
          AND NOT (expected_item_id IS NOT NULL AND package_id IS NULL AND pallet_id IS NULL)
      )::int AS physical_return_process,
      COUNT(*) FILTER (
        WHERE deleted_at IS NULL AND package_id IS NOT NULL AND resolved_product_id IS NOT NULL
      )::int AS physical_resolved
    FROM public.return_items
  `);
  return r.rows[0] as Counts;
}

async function dryrunBuckets(client: pg.Client): Promise<Record<string, number>> {
  await initExpectedPackagesAsinExpr(client);
  const r = await client.query(`
    WITH ep_unresolved AS (
      SELECT id, organization_id, store_id,
        NULLIF(BTRIM(fnsku), '') AS fnsku,
        NULLIF(BTRIM(sku), '') AS sku
      FROM public.expected_packages
      WHERE resolved_product_id IS NULL AND store_id IS NOT NULL AND organization_id IS NOT NULL
    ),
    ep_tier1 AS (
      SELECT e.id FROM ep_unresolved e
      WHERE e.fnsku IS NOT NULL
        AND (
          SELECT COUNT(DISTINCT m.product_id)
          FROM public.product_identifier_map m
          WHERE m.deleted_at IS NULL AND m.organization_id = e.organization_id AND m.store_id = e.store_id
            AND UPPER(BTRIM(m.fnsku)) = UPPER(e.fnsku) AND m.product_id IS NOT NULL
        ) = 1
    ),
    ep_tier3 AS (
      SELECT e.id FROM ep_unresolved e
      WHERE e.sku IS NOT NULL
        AND (
          SELECT COUNT(DISTINCT m.product_id)
          FROM public.product_identifier_map m
          WHERE m.deleted_at IS NULL AND m.organization_id = e.organization_id AND m.store_id = e.store_id
            AND (UPPER(BTRIM(m.seller_sku)) = UPPER(e.sku) OR UPPER(BTRIM(m.msku)) = UPPER(e.sku))
            AND m.product_id IS NOT NULL
        ) = 1
    ),
    ri_scope AS (
      SELECT id FROM public.return_items
      WHERE deleted_at IS NULL AND store_id IS NOT NULL AND organization_id IS NOT NULL
        AND resolved_product_id IS NULL
        AND (
          NULLIF(BTRIM(asin), '') IS NOT NULL OR NULLIF(BTRIM(fnsku), '') IS NOT NULL
          OR NULLIF(BTRIM(sku), '') IS NOT NULL
        )
        AND NOT (expected_item_id IS NOT NULL AND package_id IS NULL AND pallet_id IS NULL)
    ),
    ri_ep_copy AS (
      SELECT ri.id
      FROM public.return_items ri
      INNER JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
      WHERE ri.deleted_at IS NULL AND ri.package_id IS NOT NULL
        AND ri.resolved_product_id IS NULL AND ep.resolved_product_id IS NOT NULL
        AND (ri.product_id IS NULL OR ri.product_id = ep.resolved_product_id)
    ),
    ri_ambiguous AS (
      SELECT e.id FROM ep_unresolved e
      WHERE e.fnsku IS NOT NULL
        AND (
          SELECT COUNT(DISTINCT m.product_id)
          FROM public.product_identifier_map m
          WHERE m.deleted_at IS NULL AND m.organization_id = e.organization_id AND m.store_id = e.store_id
            AND UPPER(BTRIM(m.fnsku)) = UPPER(e.fnsku) AND m.product_id IS NOT NULL
        ) > 1
    )
    SELECT
      (SELECT COUNT(*)::int FROM ep_unresolved) AS ep_unresolved,
      (SELECT COUNT(*)::int FROM ep_tier1) AS ep_safe_tier1_fnsku,
      (SELECT COUNT(*)::int FROM ep_tier3) AS ep_safe_tier3_sku,
      (SELECT COUNT(*)::int FROM ri_scope) AS ri_resolver_candidates,
      (SELECT COUNT(*)::int FROM ri_ep_copy) AS ri_ep_copy_candidates,
      (SELECT COUNT(*)::int FROM ri_ambiguous) AS ep_ambiguous_fnsku_blocked,
      (SELECT COUNT(*)::int FROM public.return_items
        WHERE deleted_at IS NULL AND resolved_product_id IS NULL
          AND NULLIF(BTRIM(asin), '') IS NULL AND NULLIF(BTRIM(fnsku), '') IS NULL
          AND NULLIF(BTRIM(sku), '') IS NULL) AS ri_no_identifiers_blocked
  `);
  return r.rows[0] as Record<string, number>;
}

async function physicalStatus(client: pg.Client): Promise<Record<string, unknown>[]> {
  const r = await client.query(`
    SELECT ri.id::text AS return_item_id, ri.fnsku, ri.sku, ri.resolved_product_id::text,
           ri.identifier_resolution_status, p.product_name AS catalog_product_name
    FROM public.return_items ri
    LEFT JOIN public.products p ON p.id = ri.resolved_product_id
    WHERE ri.deleted_at IS NULL AND ri.package_id IS NOT NULL
    ORDER BY ri.updated_at DESC NULLS LAST
    LIMIT 20
  `);
  return r.rows;
}

async function applyEpCopy(
  client: pg.Client,
  budget: number,
  preimage: Array<Record<string, unknown>>,
): Promise<number> {
  if (budget <= 0) return 0;
  const pick = await client.query(
    `
    SELECT ri.id::text, ri.resolved_product_id::text AS old_rpid,
           ep.resolved_product_id::text AS new_rpid,
           ep.resolved_catalog_product_id::text AS new_rcpid
    FROM public.return_items ri
    INNER JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
    WHERE ri.deleted_at IS NULL AND ri.package_id IS NOT NULL
      AND ri.resolved_product_id IS NULL AND ep.resolved_product_id IS NOT NULL
      AND (ri.product_id IS NULL OR ri.product_id = ep.resolved_product_id)
    ORDER BY ri.id
    LIMIT $1
    `,
    [budget],
  );
  let applied = 0;
  for (const row of pick.rows) {
    preimage.push({
      table: "return_items",
      id: row.id,
      lane: "ep_copy",
      old_resolved_product_id: row.old_rpid,
      old_status: null,
    });
    const u = await client.query(
      `UPDATE public.return_items SET
         resolved_product_id = $2::uuid,
         resolved_catalog_product_id = $3::uuid,
         identifier_resolution_status = 'resolved',
         identifier_resolution_confidence = 1,
         updated_at = now()
       WHERE id = $1::uuid AND deleted_at IS NULL AND resolved_product_id IS NULL
       RETURNING id::text`,
      [row.id, row.new_rpid, row.new_rcpid],
    );
    if (u.rowCount) applied += 1;
  }
  return applied;
}

type RiRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  product_id: string | null;
};

async function applyRiResolver(
  supabase: ReturnType<typeof createClient>,
  client: pg.Client,
  budget: number,
  preimage: Array<Record<string, unknown>>,
): Promise<number> {
  if (budget <= 0) return 0;
  const res = await client.query(
    `SELECT id::text, organization_id::text, store_id::text, sku, fnsku, asin, product_id::text
     FROM public.return_items
     WHERE deleted_at IS NULL AND store_id IS NOT NULL AND organization_id IS NOT NULL
       AND resolved_product_id IS NULL
       AND (
         NULLIF(BTRIM(asin), '') IS NOT NULL OR NULLIF(BTRIM(fnsku), '') IS NOT NULL
         OR NULLIF(BTRIM(sku), '') IS NOT NULL
       )
       AND NOT (expected_item_id IS NOT NULL AND package_id IS NULL AND pallet_id IS NULL)
     ORDER BY id
     LIMIT $1`,
    [budget],
  );
  let applied = 0;
  for (const row of res.rows as RiRow[]) {
    const before = await client.query(
      `SELECT resolved_product_id::text, resolved_catalog_product_id::text,
              identifier_resolution_status, identifier_resolution_confidence::text
       FROM public.return_items WHERE id = $1::uuid`,
      [row.id],
    );
    const b = before.rows[0] as Record<string, string | null>;

    const resolved = await resolveScannerProductIdentifiers(supabase, {
      organizationId: row.organization_id,
      storeId: row.store_id,
      sku: row.sku,
      asin: row.asin,
      fnsku: row.fnsku,
      legacyProductId: row.product_id,
    });

    if (resolved.identifier_resolution_status !== "resolved" || !resolved.resolved_product_id) {
      continue;
    }

    const exists = await client.query(`SELECT 1 FROM public.products WHERE id = $1::uuid AND deleted_at IS NULL`, [
      resolved.resolved_product_id,
    ]);
    if (!exists.rowCount) continue;

    preimage.push({
      table: "return_items",
      id: row.id,
      lane: "resolver",
      old_resolved_product_id: b.resolved_product_id,
      old_resolved_catalog_product_id: b.resolved_catalog_product_id,
      old_status: b.identifier_resolution_status,
      old_confidence: b.identifier_resolution_confidence,
    });

    const u = await client.query(
      `UPDATE public.return_items t SET
         resolved_product_id = $2::uuid,
         resolved_catalog_product_id = $3::uuid,
         identifier_resolution_status = $4,
         identifier_resolution_confidence = $5,
         updated_at = now()
       FROM public.products pr
       WHERE t.id = $1::uuid AND t.deleted_at IS NULL AND pr.id = $2::uuid
       RETURNING t.id::text`,
      [
        row.id,
        resolved.resolved_product_id,
        resolved.resolved_catalog_product_id,
        resolved.identifier_resolution_status,
        resolved.identifier_resolution_confidence,
      ],
    );
    if (u.rowCount) applied += 1;
  }
  return applied;
}

/** Single capped batch per tier (map-only exact single match). */
async function applyEpTierOnce(
  client: pg.Client,
  tier: ExpectedPackagesTier,
  runId: string,
  auditTable: string,
  limit: number,
): Promise<number> {
  if (limit <= 0) return 0;
  await initExpectedPackagesAsinExpr(client);

  if (tier === 1) {
    const q = `
      WITH picked AS (
        SELECT t.id FROM public.expected_packages t
        WHERE t.resolved_product_id IS NULL AND t.store_id IS NOT NULL AND t.organization_id IS NOT NULL
          AND NULLIF(TRIM(t.fnsku), '') IS NOT NULL
        ORDER BY t.id LIMIT ${limit}
      ),
      winners AS (
        SELECT p.id AS row_id,
          (array_agg(m.product_id ORDER BY m.product_id))[1] AS product_id,
          (array_agg(m.catalog_product_id ORDER BY m.catalog_product_id))[1] AS catalog_product_id
        FROM picked p
        INNER JOIN public.expected_packages t ON t.id = p.id
        INNER JOIN public.product_identifier_map m
          ON m.organization_id = t.organization_id AND m.store_id = t.store_id
          AND m.deleted_at IS NULL
          AND NULLIF(TRIM(m.fnsku), '') = NULLIF(TRIM(t.fnsku), '')
        WHERE m.product_id IS NOT NULL
        GROUP BY p.id
        HAVING COUNT(DISTINCT m.product_id) = 1
      ),
      updated AS (
        UPDATE public.expected_packages t SET
          resolved_product_id = w.product_id,
          resolved_catalog_product_id = w.catalog_product_id,
          identifier_resolution_status = 'resolved',
          identifier_resolution_confidence = 1,
          updated_at = now()
        FROM winners w WHERE t.id = w.row_id
        RETURNING t.id, t.resolved_product_id, t.resolved_catalog_product_id
      )
      INSERT INTO public."${auditTable}" (
        run_id, source_table, source_row_id, match_tier,
        new_resolved_product_id, new_resolved_catalog_product_id,
        new_identifier_resolution_status, new_identifier_resolution_confidence
      )
      SELECT $1, 'expected_packages', u.id, 1, u.resolved_product_id, u.resolved_catalog_product_id, 'resolved', 1
      FROM updated u
      RETURNING id
    `;
    const res = await client.query(q, [runId]);
    return res.rowCount ?? 0;
  }

  if (tier === 3) {
    const q = `
      WITH picked AS (
        SELECT t.id FROM public.expected_packages t
        WHERE t.resolved_product_id IS NULL AND t.store_id IS NOT NULL AND t.organization_id IS NOT NULL
          AND NULLIF(TRIM(t.sku), '') IS NOT NULL
        ORDER BY t.id LIMIT ${limit}
      ),
      winners AS (
        SELECT p.id AS row_id,
          (array_agg(m.product_id ORDER BY m.product_id))[1] AS product_id,
          (array_agg(m.catalog_product_id ORDER BY m.catalog_product_id))[1] AS catalog_product_id
        FROM picked p
        INNER JOIN public.expected_packages t ON t.id = p.id
        INNER JOIN public.product_identifier_map m
          ON m.organization_id = t.organization_id AND m.store_id = t.store_id
          AND m.deleted_at IS NULL
          AND (NULLIF(TRIM(m.seller_sku), '') = NULLIF(TRIM(t.sku), '')
            OR NULLIF(TRIM(m.msku), '') = NULLIF(TRIM(t.sku), ''))
        WHERE m.product_id IS NOT NULL
        GROUP BY p.id
        HAVING COUNT(DISTINCT m.product_id) = 1
      ),
      updated AS (
        UPDATE public.expected_packages t SET
          resolved_product_id = w.product_id,
          resolved_catalog_product_id = w.catalog_product_id,
          identifier_resolution_status = 'matched',
          identifier_resolution_confidence = 0.85,
          updated_at = now()
        FROM winners w WHERE t.id = w.row_id
        RETURNING t.id, t.resolved_product_id, t.resolved_catalog_product_id
      )
      INSERT INTO public."${auditTable}" (
        run_id, source_table, source_row_id, match_tier,
        new_resolved_product_id, new_resolved_catalog_product_id,
        new_identifier_resolution_status, new_identifier_resolution_confidence
      )
      SELECT $1, 'expected_packages', u.id, 3, u.resolved_product_id, u.resolved_catalog_product_id, 'matched', 0.85
      FROM updated u
      RETURNING id
    `;
    const res = await client.query(q, [runId]);
    return res.rowCount ?? 0;
  }

  return 0;
}

const WAVE_EP_TIERS: ExpectedPackagesTier[] = [1, 3];

async function applyEpTiers(
  client: pg.Client,
  runId: string,
  auditTable: string,
  budget: number,
): Promise<number> {
  let applied = 0;
  for (const tier of WAVE_EP_TIERS) {
    if (applied >= budget) break;
    const n = await applyEpTierOnce(client, tier, runId, auditTable, budget - applied);
    applied += n;
  }
  return applied;
}

function rollbackSql(preimage: Array<Record<string, unknown>>): string {
  const lines = ["-- PRODUCT-LINKAGE-RESOLVER-WAVE rollback", ""];
  for (const r of preimage) {
    if (r.table !== "return_items") continue;
    const rp = r.old_resolved_product_id ? `'${r.old_resolved_product_id}'::uuid` : "NULL";
    const rc = r.old_resolved_catalog_product_id
      ? `'${r.old_resolved_catalog_product_id}'::uuid`
      : "NULL";
    const st = r.old_status ? `'${r.old_status}'` : "NULL";
    const conf = r.old_confidence != null ? String(r.old_confidence) : "NULL";
    lines.push(
      `UPDATE public.return_items SET resolved_product_id=${rp}, resolved_catalog_product_id=${rc}, identifier_resolution_status=${st}, identifier_resolution_confidence=${conf}, updated_at=now() WHERE id='${r.id}'::uuid;`,
    );
  }
  lines.push("", "-- EP rollback: use audit table row snapshots if needed");
  return lines.join("\n");
}

async function runWave(
  client: pg.Client,
  supabase: ReturnType<typeof createClient>,
  runId: string,
  execute: boolean,
  waveLimit: number,
): Promise<{
  updated: Record<string, number>;
  preimage: Array<Record<string, unknown>>;
}> {
  const updated = {
    expected_packages: 0,
    return_items_ep_copy: 0,
    return_items_resolver: 0,
  };
  const preimage: Array<Record<string, unknown>> = [];
  if (!execute) return { updated, preimage };

  const auditTable = auditTableName(runId);
  await ensureExpectedPackagesAuditTable(client, auditTable);
  await initExpectedPackagesAsinExpr(client);

  let budget = waveLimit;
  const epApplied = await applyEpTiers(client, runId, auditTable, budget);
  updated.expected_packages = epApplied;
  budget -= epApplied;

  updated.return_items_ep_copy = await applyEpCopy(client, budget, preimage);
  budget -= updated.return_items_ep_copy;

  updated.return_items_resolver = await applyRiResolver(supabase, client, budget, preimage);
  return { updated, preimage };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const execute = hasFlag("--execute");
  const continueAll = hasFlag("--continue-all");
  const waveLimit = limitArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }
  if (execute && !readApproval()) {
    throw new Error(`Execute blocked — approval required at ${APPROVAL_PATH}`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const beforeSpine = await spineCounts(client);
  const beforeEp = await probeExpectedPackagesCoverage(client);
  const beforeRi = await returnItemCounts(client);
  const buckets = await dryrunBuckets(client);

  const supabase = createClient(
    publicUrl,
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "",
    { auth: { persistSession: false } },
  );

  const allWaves: Array<{ wave: number; updated: Record<string, number> }> = [];
  const allPreimage: Array<Record<string, unknown>> = [];

  if (execute) {
    let wave = 1;
    for (;;) {
      const { updated, preimage } = await runWave(client, supabase, `${runId}-w${wave}`, true, waveLimit);
      allWaves.push({ wave, updated });
      allPreimage.push(...preimage);
      const total =
        updated.expected_packages + updated.return_items_ep_copy + updated.return_items_resolver;
      if (!continueAll || total === 0) break;
      wave += 1;
      if (wave > 20) break;
    }
  }

  const afterSpine = execute ? await spineCounts(client) : beforeSpine;
  const afterEp = execute ? await probeExpectedPackagesCoverage(client) : beforeEp;
  const afterRi = execute ? await returnItemCounts(client) : beforeRi;
  const physical = await physicalStatus(client);
  await client.end();

  const rowsUpdated = allWaves.reduce(
    (acc, w) => {
      acc.expected_packages += w.updated.expected_packages;
      acc.return_items_ep_copy += w.updated.return_items_ep_copy;
      acc.return_items_resolver += w.updated.return_items_resolver;
      return acc;
    },
    { expected_packages: 0, return_items_ep_copy: 0, return_items_resolver: 0 },
  );

  fs.writeFileSync(path.join(outDir, "rollback-preimage.json"), JSON.stringify(allPreimage, null, 2));
  fs.writeFileSync(
    path.join(outDir, `rollback-preimage-${execute ? "execute" : "dryrun"}.json`),
    JSON.stringify(allPreimage, null, 2),
  );
  const rb = rollbackSql(allPreimage);
  fs.writeFileSync(path.join(outDir, "rollback.sql"), rb);
  if (allPreimage.length) {
    fs.writeFileSync(path.join(outDir, "rollback-wave-preimage.json"), JSON.stringify(allPreimage, null, 2));
  }

  const productsUnchanged = Number(beforeSpine.products) === Number(afterSpine.products);
  const mapUnchanged =
    Number(beforeSpine.product_identifier_map_active) === Number(afterSpine.product_identifier_map_active);
  const epDecreased =
    !execute ||
    (beforeEp && afterEp && afterEp.unresolved <= beforeEp.unresolved);
  const riDecreased =
    !execute ||
    Number(afterRi.unresolved_with_identifiers) <= Number(beforeRi.unresolved_with_identifiers);

  const safeToContinue =
    (!execute || (productsUnchanged && mapUnchanged && epDecreased && riDecreased)) &&
    buckets.ep_ambiguous_fnsku_blocked >= 0;

  const report = {
    prompt: "PRODUCT-LINKAGE-RESOLVER-WAVE-STAGING-EXECUTE",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: execute ? (continueAll ? "execute_continue_all" : "execute_wave") : "dry_run",
    wave_limit: waveLimit,
    BEFORE_COUNTS: {
      spine: beforeSpine,
      expected_packages: beforeEp,
      return_items: beforeRi,
    },
    DRYRUN_BUCKETS: buckets,
    ROWS_UPDATED_BY_TABLE: rowsUpdated,
    waves: allWaves,
    AFTER_COUNTS: execute
      ? { spine: afterSpine, expected_packages: afterEp, return_items: afterRi }
      : null,
    PHYSICAL_RETURN_PROCESS_STATUS: physical,
    BLOCKED_ROWS: {
      ri_no_identifiers: buckets.ri_no_identifiers_blocked,
      ep_ambiguous_fnsku: buckets.ep_ambiguous_fnsku_blocked,
      note: "ambiguous map matches and rows without identifiers are never updated",
    },
    ROLLBACK_PATHS: {
      preimage_json: path.join(outDir, "rollback-preimage.json"),
      rollback_sql: path.join(outDir, "rollback.sql"),
    },
    SAFE_TO_CONTINUE: safeToContinue ? "yes" : "no",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# PRODUCT-LINKAGE-RESOLVER-WAVE-STAGING-EXECUTE",
      "",
      `Run: \`${runId}\` · Mode: **${report.mode}**`,
      "",
      "## BEFORE_COUNTS",
      "```json",
      JSON.stringify(report.BEFORE_COUNTS, null, 2),
      "```",
      "",
      "## DRYRUN_BUCKETS",
      "```json",
      JSON.stringify(buckets, null, 2),
      "```",
      "",
      "## ROWS_UPDATED_BY_TABLE",
      "```json",
      JSON.stringify(rowsUpdated, null, 2),
      "```",
      execute && report.AFTER_COUNTS
        ? ["## AFTER_COUNTS", "```json", JSON.stringify(report.AFTER_COUNTS, null, 2), "```"].join("\n")
        : "",
      "",
      `## SAFE_TO_CONTINUE: **${report.SAFE_TO_CONTINUE}**`,
    ].join("\n"),
  );

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
