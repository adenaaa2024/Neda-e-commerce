/**
 * ORIGINAL-PARITY-WAVE-B-GOVERNED-MAP-REPLAY-EXECUTE-MAP-ONLY
 *
 * Inserts approved safe E1_V192 product_identifier_map rows on original only,
 * then re-runs expected_packages resolver backfill. No products. No staging writes.
 *
 *   npx tsx scripts/original-parity-wave-b-governed-map-replay-execute-map-only.ts --apply
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
const PLAN_JSON = `.cursor/audit-reports/original-parity-wave-b-governed-map-replay-plan/${PLAN_RUN_ID}/safe-map-replay-plan.json`;
const APPROVAL_PATH =
  ".cursor/operator-approvals/original-parity-wave-b-governed-map-replay-approval.md";
const OUT_BASE = ".cursor/audit-reports/original-parity-wave-b-governed-map-replay-execute-map-only";
const MATCH_SOURCE = "expected_packages_e1_map_bridge_v192";
const DERIVED_SOURCES = ["detail_shipment", "detail_remainder"] as const;
const EXPECTED_MAP_ROWS = 129;

type PlanRow = {
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
  expected_package_count: number;
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

function readApproval(): { valid: boolean; raw: Record<string, string> } {
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) return { valid: false, raw: {} };
  const text = fs.readFileSync(p, "utf8");
  const raw = {
    APPROVED_TO_RUN_ORIGINAL: /APPROVED_TO_RUN_ORIGINAL\s*=\s*(true|false)/i.exec(text)?.[1] ?? "false",
    APPROVED_ORIGINAL_PARITY_WAVE_B_GOVERNED_MAP_REPLAY:
      /APPROVED_ORIGINAL_PARITY_WAVE_B_GOVERNED_MAP_REPLAY\s*=\s*(true|false)/i.exec(text)?.[1] ?? "false",
  };
  return {
    valid:
      /^true$/i.test(raw.APPROVED_TO_RUN_ORIGINAL) &&
      /^true$/i.test(raw.APPROVED_ORIGINAL_PARITY_WAVE_B_GOVERNED_MAP_REPLAY),
    raw,
  };
}

function parseReplayKey(replayKey: string): { sku: string | null; fnsku: string | null } {
  const parts = replayKey.split("|");
  return {
    fnsku: parts[3]?.trim() || null,
    sku: parts[4]?.trim() || null,
  };
}

function externalListingId(row: {
  organization_id: string;
  store_id: string;
  sku: string | null;
  fnsku: string | null;
  product_id: string;
}): string {
  const key = [row.organization_id, row.store_id, row.sku ?? "", row.fnsku ?? "", row.product_id].join("|");
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
  return `${MATCH_SOURCE}:${hash}`;
}

function readInsertPlan(): InsertPlanRow[] {
  const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), PLAN_JSON), "utf8")) as {
    rows?: PlanRow[];
  };
  const rows = raw.rows ?? [];
  if (rows.length !== EXPECTED_MAP_ROWS) {
    throw new Error(`Expected ${EXPECTED_MAP_ROWS} plan rows, found ${rows.length}`);
  }
  const out: InsertPlanRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.match_source !== MATCH_SOURCE || row.governed_execute !== "E1_V192" || !row.map_only) {
      throw new Error(`Unexpected plan row source/execute: ${row.replay_key}`);
    }
    const parsed = parseReplayKey(row.replay_key);
    const sellerSku = row.seller_sku ?? parsed.sku;
    const fnsku = row.fnsku ?? parsed.fnsku;
    const externalId = externalListingId({
      organization_id: ORG_ID,
      store_id: STORE_ID,
      sku: sellerSku,
      fnsku,
      product_id: row.product_id,
    });
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    out.push({
      organization_id: ORG_ID,
      store_id: STORE_ID,
      product_id: row.product_id,
      seller_sku: sellerSku,
      msku: sellerSku,
      fnsku,
      match_source: MATCH_SOURCE,
      source_report_type: MATCH_SOURCE,
      external_listing_id: externalId,
      expected_package_count: row.expected_package_count,
    });
  }
  if (out.length !== EXPECTED_MAP_ROWS) {
    throw new Error(`Deduped insert plan has ${out.length} rows, expected ${EXPECTED_MAP_ROWS}`);
  }
  return out;
}

async function epCensus(client: pg.Client): Promise<{
  ep_derived: number;
  ep_resolved: number;
  ep_derived_unresolved: number;
  ep_status_ambiguous: number;
}> {
  const r = await client.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE build_source IN ('detail_shipment','detail_remainder'))::int AS ep_derived,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS ep_resolved,
      COUNT(*) FILTER (
        WHERE build_source IN ('detail_shipment','detail_remainder') AND resolved_product_id IS NULL
      )::int AS ep_derived_unresolved,
      COUNT(*) FILTER (
        WHERE build_source IN ('detail_shipment','detail_remainder')
          AND identifier_resolution_status = 'ambiguous'
      )::int AS ep_status_ambiguous
    FROM public.expected_packages
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
    `,
    [ORG_ID, STORE_ID],
  );
  return r.rows[0] as {
    ep_derived: number;
    ep_resolved: number;
    ep_derived_unresolved: number;
    ep_status_ambiguous: number;
  };
}

/** SQL bulk resolver — same read-layer map rules as governed backfill, no Supabase HTTP per row. */
async function runResolverBackfillSql(
  client: pg.Client,
): Promise<{ applied: number; summary: Record<string, number> }> {
  const censusBefore = await client.query(
    `
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id,
        NULLIF(TRIM(e.sku), '') AS sku,
        NULLIF(TRIM(e.fnsku), '') AS fnsku,
        e.resolved_product_id,
        e.identifier_resolution_status
      FROM public.expected_packages e
      WHERE e.organization_id = $1::uuid AND e.store_id = $2::uuid
        AND e.build_source = ANY($3::text[])
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
    classified AS (
      SELECT ep.id, ep.resolved_product_id,
        CASE
          WHEN ep.resolved_product_id IS NOT NULL THEN 'skip_already_resolved'
          WHEN COALESCE(mf.product_count, 0) > 1 OR COALESCE(ms.product_count, 0) > 1 THEN 'ambiguous'
          WHEN COALESCE(mf.product_count, 0) = 1 THEN 'map_fnsku'
          WHEN COALESCE(ms.product_count, 0) = 1 THEN 'map_sku'
          ELSE 'missing_product_needs_evidence'
        END AS bucket,
        CASE
          WHEN COALESCE(mf.product_count, 0) = 1 THEN mf.product_id
          WHEN COALESCE(ms.product_count, 0) = 1 THEN ms.product_id
          ELSE NULL
        END AS proposed_product_id
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id = ep.id
      LEFT JOIN map_sku ms ON ms.id = ep.id
    )
    SELECT
      COUNT(*)::int AS candidates_scanned,
      COUNT(*) FILTER (WHERE bucket = 'map_fnsku' OR bucket = 'map_sku')::int AS set_resolved_candidates,
      COUNT(*) FILTER (WHERE bucket = 'ambiguous')::int AS queue_ambiguous,
      COUNT(*) FILTER (WHERE bucket = 'missing_product_needs_evidence')::int AS queue_missing_product_needs_evidence,
      COUNT(*) FILTER (WHERE bucket = 'skip_already_resolved')::int AS skip_already_resolved
    FROM classified
    `,
    [ORG_ID, STORE_ID, DERIVED_SOURCES],
  );

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

  const census = censusBefore.rows[0] as Record<string, number>;
  return {
    applied: (resolved.rowCount ?? 0) + (ambiguous.rowCount ?? 0),
    summary: {
      candidates_scanned: census.candidates_scanned ?? 0,
      set_resolved: resolved.rowCount ?? 0,
      status_only: ambiguous.rowCount ?? 0,
      skip_unchanged: census.skip_already_resolved ?? 0,
      queue_missing_product_needs_evidence: census.queue_missing_product_needs_evidence ?? 0,
      queue_ambiguous: census.queue_ambiguous ?? 0,
    },
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (!approval.valid) blockers.push("Approval flags not both true");
  if (!apply) blockers.push("Pass --apply to execute original writes");

  const originalPg = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!originalPg) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL unset");
  if (originalPg && refFromConnectionUrl(originalPg) !== ORIGINAL_REF) {
    blockers.push(`ORIGINAL URL must target ${ORIGINAL_REF}`);
  }

  const plan = readInsertPlan();
  fs.writeFileSync(path.join(outDir, "insert-plan.json"), JSON.stringify(plan, null, 2));

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ status: "BLOCKED", run_id: runId, blockers }, null, 2),
    );
    console.log(JSON.stringify({ ok: false, blockers }, null, 2));
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: originalPg, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const beforeEp = await epCensus(client);
  const beforeMap = (
    await client.query(
      `SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`,
    )
  ).rows[0] as { c: number };

  const missingProducts = await client.query(
    `
    WITH input AS (
      SELECT DISTINCT product_id::uuid AS product_id
      FROM jsonb_to_recordset($1::jsonb) AS x(product_id text)
    )
    SELECT i.product_id::text
    FROM input i
    LEFT JOIN public.products p ON p.id = i.product_id AND p.deleted_at IS NULL
    WHERE p.id IS NULL
    `,
    [JSON.stringify(plan.map((r) => ({ product_id: r.product_id })))],
  );
  if (missingProducts.rows.length > 0) {
    await client.end();
    throw new Error(`Plan references ${missingProducts.rows.length} products missing on original`);
  }

  const externalIds = plan.map((r) => r.external_listing_id);
  const preExisting = await client.query(
    `SELECT id::text, product_id::text, fnsku, external_listing_id
     FROM public.product_identifier_map
     WHERE external_listing_id = ANY($1::text[])`,
    [externalIds],
  );

  const fnskuConflicts = await client.query(
    `
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS x(
        product_id uuid,
        fnsku text
      )
    )
    SELECT i.fnsku, i.product_id::text AS planned_product_id, m.id::text AS map_id, m.product_id::text AS existing_product_id
    FROM input i
    JOIN public.product_identifier_map m
      ON m.organization_id = $2::uuid
     AND m.store_id = $3::uuid
     AND m.deleted_at IS NULL
     AND m.fnsku IS NOT DISTINCT FROM i.fnsku
    WHERE m.product_id IS DISTINCT FROM i.product_id
    `,
    [JSON.stringify(plan), ORG_ID, STORE_ID],
  );

  fs.writeFileSync(
    path.join(outDir, "preimage.json"),
    JSON.stringify(
      {
        plan_run_id: PLAN_RUN_ID,
        before_ep: beforeEp,
        before_active_map_rows: beforeMap.c,
        pre_existing_external_listing_rows: preExisting.rows,
        fnsku_conflicts: fnskuConflicts.rows,
      },
      null,
      2,
    ),
  );

  if (fnskuConflicts.rows.length > 0) {
    await client.end();
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      `# Blocked\n\nFound ${fnskuConflicts.rows.length} FNSKU conflicts on original. No inserts executed.\n`,
    );
    throw new Error("FNSKU conflicts on original; no inserts executed");
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
          organization_id,
          store_id,
          product_id,
          seller_sku,
          msku,
          fnsku,
          match_source,
          source_report_type,
          external_listing_id,
          is_primary,
          first_seen_at,
          last_seen_at,
          created_at,
          updated_at
        )
        SELECT
          i.organization_id,
          i.store_id,
          i.product_id,
          i.seller_sku,
          i.msku,
          i.fnsku,
          i.match_source,
          i.source_report_type,
          i.external_listing_id,
          true,
          now(),
          now(),
          now(),
          now()
        FROM input i
        WHERE NOT EXISTS (
          SELECT 1 FROM public.product_identifier_map m
          WHERE m.external_listing_id = i.external_listing_id
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

  const resolver = await runResolverBackfillSql(client);

  const afterEp = await epCensus(client);
  const afterMap = (
    await client.query(
      `SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`,
    )
  ).rows[0] as { c: number };
  const productsCount = (
    await client.query(`SELECT COUNT(*)::int AS c FROM public.products WHERE deleted_at IS NULL`)
  ).rows[0] as { c: number };

  await client.end();

  fs.writeFileSync(path.join(outDir, "inserted-rows.json"), JSON.stringify(insertedRows, null, 2));
  fs.writeFileSync(path.join(outDir, "skipped-existing.json"), JSON.stringify(preExisting.rows, null, 2));
  fs.writeFileSync(
    path.join(outDir, "resolver-backfill-result.md"),
    [
      "# Resolver backfill result (original)",
      "",
      `- candidates_scanned: **${resolver.summary.candidates_scanned}**`,
      `- set_resolved (this pass): **${resolver.summary.set_resolved}**`,
      `- status_only: **${resolver.summary.status_only}**`,
      `- missing_product_needs_evidence: **${resolver.summary.queue_missing_product_needs_evidence}**`,
      `- ambiguous: **${resolver.summary.queue_ambiguous}**`,
      `- applied updates: **${resolver.applied}**`,
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      "-- Rollback Wave B map-only execute on original.",
      "DELETE FROM public.product_identifier_map",
      insertedRows.length
        ? `WHERE external_listing_id IN (${insertedRows
            .map((r) => `'${String(r.external_listing_id).replace(/'/g, "''")}'`)
            .join(", ")});`
        : "WHERE false;",
      "",
      "-- Re-run resolver backfill after rollback if needed.",
    ].join("\n"),
  );

  const nextPrompt =
    "ORIGINAL-PARITY-WAVE-B-GOVERNED-MAP-REPLAY-TRIAGE — review 293 product-create candidates + 447 no-governed-match rows; optional E2/V200 sub-executes";

  const manifest = {
    prompt_id: "ORIGINAL-PARITY-WAVE-B-GOVERNED-MAP-REPLAY-EXECUTE-MAP-ONLY",
    run_id: runId,
    branch,
    status: "PASS",
    plan_run_id: PLAN_RUN_ID,
    original_ref: ORIGINAL_REF,
    staging_touched: false,
    products_created: false,
    amazon_api_called: false,
    map_rows_planned: plan.length,
    map_rows_inserted: insertedRows.length,
    map_rows_skipped_existing: preExisting.rows.length,
    before: {
      ep_derived: beforeEp.ep_derived,
      ep_resolved: beforeEp.ep_resolved,
      ep_derived_unresolved: beforeEp.ep_derived_unresolved,
      active_map_rows: beforeMap.c,
      products_active: productsCount.c,
    },
    after: {
      ep_derived: afterEp.ep_derived,
      ep_resolved: afterEp.ep_resolved,
      ep_derived_unresolved: afterEp.ep_derived_unresolved,
      active_map_rows: afterMap.c,
      products_active: productsCount.c,
    },
    resolver: resolver.summary,
    deferred: {
      product_create_candidates: 293,
      no_governed_staging_match: 447,
    },
    approval_file: APPROVAL_PATH,
    exact_next_prompt: nextPrompt,
  };

  fs.writeFileSync(path.join(outDir, "apply-result.md"), [
    "# Wave B governed map replay execute (map-only)",
    "",
    `- Plan run: \`${PLAN_RUN_ID}\``,
    `- Map rows inserted: **${insertedRows.length}** / ${plan.length}`,
    `- Skipped existing: **${preExisting.rows.length}**`,
    `- Products created: **0**`,
    "",
    "## expected_packages (derived)",
    "",
    "| Metric | Before | After | Delta |",
    "|--------|-------:|------:|------:|",
    `| resolved | ${beforeEp.ep_resolved} | **${afterEp.ep_resolved}** | +${afterEp.ep_resolved - beforeEp.ep_resolved} |`,
    `| unresolved | ${beforeEp.ep_derived_unresolved} | **${afterEp.ep_derived_unresolved}** | ${afterEp.ep_derived_unresolved - beforeEp.ep_derived_unresolved} |`,
    `| ambiguous | ${beforeEp.ep_status_ambiguous} | **${afterEp.ep_status_ambiguous}** | ${afterEp.ep_status_ambiguous - beforeEp.ep_status_ambiguous} |`,
    "",
    "## Resolver pass",
    "",
    `- set_resolved proposals: **${resolver.summary.set_resolved}**`,
    `- missing_product_needs_evidence remaining: **${resolver.summary.queue_missing_product_needs_evidence}**`,
    "",
    "Deferred: 293 product-create candidates, 447 no-governed-match rows.",
  ].join("\n") + "\n");

  fs.writeFileSync(path.join(outDir, "blockers.md"), "- None\n");
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir,
        map_rows_inserted: insertedRows.length,
        resolved_before: beforeEp.ep_resolved,
        resolved_after: afterEp.ep_resolved,
        unresolved_before: beforeEp.ep_derived_unresolved,
        unresolved_after: afterEp.ep_derived_unresolved,
        nextPrompt,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
