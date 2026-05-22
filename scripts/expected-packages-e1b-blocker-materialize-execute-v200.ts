/**
 * EXPECTED-PACKAGES-E1B-BLOCKER-MATERIALIZE-EXECUTE-V200
 *
 * Governed product + map promotion for 10 E1B orphan import product_ids,
 * then scoped import FK remap. Re-runs E1B map-only when spine proof passes.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
function planPreimagePath(): string {
  const a = process.argv.find((x) => x.startsWith("--plan-run-id="));
  const planRunId = a ? a.split("=")[1]!.trim() : "20260522T150000Z";
  return path.join(
    process.cwd(),
    ".cursor/audit-reports/amazon-manage-fba-orphan-product-id-spine-repair-plan-v199",
    planRunId,
    "candidate-preimage.json",
  );
}

function v199RunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--v199-run-id="));
  return a ? a.split("=")[1]!.trim() : "20260519T230000Z";
}
const APPROVAL_PATH =
  ".cursor/operator-approvals/expected-packages-e1b-blocker-materialize-v200-approval.md";
const OUT_BASE = ".cursor/audit-reports/expected-packages-e1b-blocker-materialize-execute-v200";
const MATCH_SOURCE = "expected_packages_e1b_blocker_materialize_v200";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const EXPECTED_ORPHANS = 10;

type PlanCandidate = {
  orphan_product_id: string;
  expected_package_ids: string[];
  sample_sku: string | null;
  sample_fnsku: string | null;
};

type PromoRow = {
  orphan_product_id: string;
  organization_id: string;
  store_id: string;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  product_name: string;
  expected_package_ids: string[];
  expected_package_count: number;
  manage_row_ids: string[];
  afi_row_ids: string[];
  fba_row_ids: string[];
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
    /APPROVED_EXPECTED_PACKAGES_E1B_BLOCKER_MATERIALIZE_V200\s*=\s*true/i.test(text)
  );
}

async function coverage(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(`
    WITH ep AS (
      SELECT e.id, e.organization_id, e.store_id, NULLIF(TRIM(e.sku), '') AS sku,
        NULLIF(TRIM(e.fnsku), '') AS fnsku, e.resolved_product_id
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
          WHEN ep.resolved_product_id IS NOT NULL THEN 'direct'
          WHEN COALESCE(mf.product_count, 0) = 1 THEN 'map_fnsku'
          WHEN COALESCE(ms.product_count, 0) = 1 THEN 'map_sku'
          WHEN COALESCE(mf.product_count, 0) > 1 OR COALESCE(ms.product_count, 0) > 1 THEN 'ambiguous'
          ELSE 'unresolved'
        END AS bucket
      FROM ep
      LEFT JOIN map_fnsku mf ON mf.id = ep.id
      LEFT JOIN map_sku ms ON ms.id = ep.id
    )
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE bucket IN ('direct', 'map_fnsku', 'map_sku'))::int AS read_layer_resolved,
      COUNT(*) FILTER (WHERE bucket = 'unresolved')::int AS unresolved,
      COUNT(*) FILTER (WHERE bucket = 'ambiguous')::int AS ambiguous
    FROM classified
  `);
  return r.rows[0] as Record<string, number>;
}

async function buildPromoRows(
  client: pg.Client,
  planCandidates: PlanCandidate[],
): Promise<PromoRow[]> {
  const orphanIds = planCandidates.map((c) => c.orphan_product_id);
  const importRes = await client.query(
    `
    WITH orphans AS (SELECT unnest($1::uuid[]) AS orphan_product_id)
    SELECT o.orphan_product_id::text,
      mf.id::text AS row_id, 'amazon_manage_fba_inventory' AS src,
      mf.organization_id::text, mf.store_id::text,
      NULLIF(TRIM(mf.sku), '') AS sku, NULLIF(TRIM(mf.fnsku), '') AS fnsku,
      NULLIF(TRIM(mf.asin), '') AS asin, NULLIF(TRIM(mf.product_name), '') AS product_name
    FROM orphans o
    JOIN public.amazon_manage_fba_inventory mf
      ON COALESCE(mf.resolved_product_id, mf.product_id) = o.orphan_product_id
    UNION ALL
    SELECT o.orphan_product_id::text, a.id::text, 'amazon_amazon_fulfilled_inventory',
      a.organization_id::text, a.store_id::text,
      NULLIF(TRIM(a.seller_sku), ''), NULLIF(TRIM(a.fulfillment_channel_sku), ''),
      NULLIF(TRIM(a.asin), ''), NULL
    FROM orphans o
    JOIN public.amazon_amazon_fulfilled_inventory a
      ON COALESCE(a.resolved_product_id, a.product_id) = o.orphan_product_id
    UNION ALL
    SELECT o.orphan_product_id::text, f.id::text, 'amazon_fba_inventory',
      f.organization_id::text, f.store_id::text,
      NULLIF(TRIM(f.sku), ''), NULLIF(TRIM(f.fnsku), ''),
      NULLIF(TRIM(f.asin), ''), NULLIF(TRIM(f.product_name), '')
    FROM orphans o
    JOIN public.amazon_fba_inventory f
      ON COALESCE(f.resolved_product_id, f.product_id) = o.orphan_product_id
    `,
    [orphanIds],
  );

  const rows: PromoRow[] = [];
  for (const plan of planCandidates) {
    const hits = importRes.rows.filter(
      (r: { orphan_product_id: string }) => r.orphan_product_id === plan.orphan_product_id,
    );
    const manage = hits.filter((r: { src: string }) => r.src === "amazon_manage_fba_inventory");
    const names = [
      ...manage.map((r: { product_name: string | null }) => r.product_name),
      ...hits
        .filter((r: { src: string }) => r.src === "amazon_fba_inventory")
        .map((r: { product_name: string | null }) => r.product_name),
    ].filter(Boolean) as string[];
    if (names.length === 0) {
      throw new Error(`No trusted product_name for orphan ${plan.orphan_product_id}`);
    }
    const sku =
      plan.sample_sku ??
      (manage[0] as { sku: string | null } | undefined)?.sku ??
      (hits[0] as { sku: string | null }).sku;
    const fnsku =
      plan.sample_fnsku ??
      (manage[0] as { fnsku: string | null } | undefined)?.fnsku ??
      (hits[0] as { fnsku: string | null }).fnsku;
    const asin =
      (manage[0] as { asin: string | null } | undefined)?.asin ??
      (hits.find((r: { asin: string | null }) => r.asin) as { asin: string | null } | undefined)?.asin ??
      null;
    if (!sku && !fnsku) {
      throw new Error(`Missing sku/fnsku for orphan ${plan.orphan_product_id}`);
    }
    rows.push({
      orphan_product_id: plan.orphan_product_id,
      organization_id: ORG_ID,
      store_id: STORE_ID,
      sku,
      fnsku,
      asin,
      product_name: names.sort()[0]!,
      expected_package_ids: plan.expected_package_ids,
      expected_package_count: plan.expected_package_ids.length,
      manage_row_ids: manage.map((r: { row_id: string }) => r.row_id),
      afi_row_ids: hits
        .filter((r: { src: string }) => r.src === "amazon_amazon_fulfilled_inventory")
        .map((r: { row_id: string }) => r.row_id),
      fba_row_ids: hits
        .filter((r: { src: string }) => r.src === "amazon_fba_inventory")
        .map((r: { row_id: string }) => r.row_id),
    });
  }
  return rows.sort((a, b) => `${a.sku}:${a.fnsku}`.localeCompare(`${b.sku}:${b.fnsku}`));
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  if (!readApproval()) {
    throw new Error(`Approval flags are not true in ${APPROVAL_PATH}`);
  }

  const planPath = planPreimagePath();
  const planRaw = JSON.parse(fs.readFileSync(planPath, "utf8")) as {
    candidates: PlanCandidate[];
  };
  let planCandidates = planRaw.candidates.filter(
    (c) => c.orphan_product_id && (c as PlanCandidate).expected_package_ids,
  ) as PlanCandidate[];
  if (planCandidates.length === 0) {
    planCandidates = (planRaw.candidates as PlanCandidate[]).filter((c) => c.orphan_product_id);
    const byOrphan = new Map<string, PlanCandidate>();
    for (const c of planCandidates) {
      const existing = byOrphan.get(c.orphan_product_id);
      if (!existing) {
        byOrphan.set(c.orphan_product_id, {
          orphan_product_id: c.orphan_product_id,
          expected_package_ids: [...(c.expected_package_ids ?? [])],
          sample_sku: c.sample_sku ?? null,
          sample_fnsku: c.sample_fnsku ?? null,
        });
      } else {
        for (const id of c.expected_package_ids ?? []) {
          if (!existing.expected_package_ids.includes(id)) existing.expected_package_ids.push(id);
        }
      }
    }
    planCandidates = [...byOrphan.values()];
  }
  if (planCandidates.length !== EXPECTED_ORPHANS) {
    throw new Error(`Expected ${EXPECTED_ORPHANS} plan candidates, found ${planCandidates.length}`);
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
  await client.query("SET statement_timeout = '180s'");

  const pkgItems = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='package_items'`,
  );
  if ((pkgItems.rowCount ?? 0) > 0) throw new Error("package_items exists (forbidden)");

  const promoRows = await buildPromoRows(client, planCandidates);
  fs.writeFileSync(path.join(outDir, "candidate-preimage.json"), JSON.stringify(promoRows, null, 2));

  const beforeCoverage = await coverage(client);
  const beforeCounts = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS active_map_rows,
      (SELECT COUNT(*)::int FROM public.expected_packages) AS expected_packages
  `);

  const existingHits = await client.query(
    `
    WITH input AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
        orphan_product_id text, organization_id uuid, store_id uuid, sku text, fnsku text
      )
    )
    SELECT i.orphan_product_id, i.sku, i.fnsku,
      COUNT(p.id)::int AS hit_count,
      MIN(p.id::text) AS sole_product_id
    FROM input i
    LEFT JOIN public.products p
      ON p.organization_id = i.organization_id AND p.store_id = i.store_id
     AND p.deleted_at IS NULL AND (p.merge_status IS NULL OR p.merge_status <> 'merged')
     AND p.sku IS NOT DISTINCT FROM i.sku AND p.fnsku IS NOT DISTINCT FROM i.fnsku
    GROUP BY i.orphan_product_id, i.sku, i.fnsku
  `,
    [JSON.stringify(promoRows)],
  );
  const ambiguous = existingHits.rows.filter((r: { hit_count: number }) => r.hit_count > 1);
  if (ambiguous.length > 0) {
    fs.writeFileSync(path.join(outDir, "blockers.json"), JSON.stringify(ambiguous, null, 2));
    await client.end();
    throw new Error(`Ambiguous existing products for ${ambiguous.length} orphan(s); no V200 execute.`);
  }
  const linkExisting = new Map<string, string>();
  for (const r of existingHits.rows as { orphan_product_id: string; hit_count: number; sole_product_id: string | null }[]) {
    if (r.hit_count === 1 && r.sole_product_id) linkExisting.set(r.orphan_product_id, r.sole_product_id);
  }

  type Inserted = { orphan_product_id: string; new_product_id: string };
  const insertedProducts: Record<string, unknown>[] = [];
  const insertedMaps: Record<string, unknown>[] = [];
  const remaps: Inserted[] = [];
  const remapCounts = { manage: 0, afi: 0, fba: 0 };

  let productsInserted = 0;
  let mapsInserted = 0;
  let linkedExisting = 0;

  await client.query("BEGIN");
  try {
    for (const row of promoRows) {
      const existingId = linkExisting.get(row.orphan_product_id);
      let newId: string;

      if (existingId) {
        newId = existingId;
        linkedExisting += 1;
        insertedProducts.push({
          orphan_product_id: row.orphan_product_id,
          id: newId,
          sku: row.sku,
          fnsku: row.fnsku,
          asin: row.asin,
          product_name: row.product_name,
          linked_existing: true,
        });
        const mapHit = await client.query(
          `SELECT id::text FROM public.product_identifier_map
           WHERE organization_id = $1::uuid AND store_id = $2::uuid AND product_id = $3::uuid
             AND deleted_at IS NULL AND fnsku IS NOT DISTINCT FROM $4 AND seller_sku IS NOT DISTINCT FROM $5
           LIMIT 1`,
          [row.organization_id, row.store_id, newId, row.fnsku, row.sku],
        );
        if (mapHit.rows.length === 0) {
          const insM = await client.query(
            `INSERT INTO public.product_identifier_map (
              organization_id, store_id, product_id, seller_sku, msku, asin, fnsku,
              match_source, source_report_type, external_listing_id, is_primary,
              first_seen_at, last_seen_at, created_at, updated_at
            ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$4,$5,$6,$7,$7,$7||':'||$3::text,true,now(),now(),now(),now())
            RETURNING id::text, product_id::text, external_listing_id`,
            [
              row.organization_id,
              row.store_id,
              newId,
              row.sku,
              row.asin,
              row.fnsku,
              MATCH_SOURCE,
            ],
          );
          insertedMaps.push(insM.rows[0] as Record<string, unknown>);
          mapsInserted += 1;
        }
      } else {
        const ins = await client.query(
          `
          WITH ins_p AS (
            INSERT INTO public.products (
              organization_id, store_id, product_name, sku, fnsku, asin, status,
              metadata, first_seen_at, last_seen_at, created_at, updated_at
            ) VALUES (
              $1::uuid, $2::uuid, $3, $4, $5, $6, 'active',
              jsonb_build_object(
                'source', $7::text,
                'orphan_product_id', $8::text,
                'expected_package_ids', $9::jsonb
              ),
              now(), now(), now(), now()
            )
            RETURNING id
          ),
          ins_m AS (
            INSERT INTO public.product_identifier_map (
              organization_id, store_id, product_id, seller_sku, msku, asin, fnsku,
              match_source, source_report_type, external_listing_id, is_primary,
              first_seen_at, last_seen_at, created_at, updated_at
            )
            SELECT $1::uuid, $2::uuid, ins_p.id, $4, $4, $6, $5,
              $7::text, $7::text, $7::text || ':' || ins_p.id::text, true,
              now(), now(), now(), now()
            FROM ins_p
            RETURNING id, product_id, external_listing_id
          )
          SELECT ins_p.id::text AS product_id, ins_m.id::text AS map_id, ins_m.external_listing_id
          FROM ins_p, ins_m
          `,
          [
            row.organization_id,
            row.store_id,
            row.product_name,
            row.sku,
            row.fnsku,
            row.asin,
            MATCH_SOURCE,
            row.orphan_product_id,
            JSON.stringify(row.expected_package_ids),
          ],
        );
        newId = String(ins.rows[0]!.product_id);
        productsInserted += 1;
        mapsInserted += 1;
        insertedProducts.push({
          orphan_product_id: row.orphan_product_id,
          id: newId,
          sku: row.sku,
          fnsku: row.fnsku,
          asin: row.asin,
          product_name: row.product_name,
          linked_existing: false,
        });
        insertedMaps.push(ins.rows[0] as Record<string, unknown>);
      }
      remaps.push({ orphan_product_id: row.orphan_product_id, new_product_id: newId });

      const mUp = await client.query(
        `UPDATE public.amazon_manage_fba_inventory
         SET product_id = $2::uuid, resolved_product_id = $2::uuid
         WHERE COALESCE(resolved_product_id, product_id) = $1::uuid
         RETURNING id::text`,
        [row.orphan_product_id, newId],
      );
      remapCounts.manage += mUp.rowCount ?? 0;

      const aUp = await client.query(
        `UPDATE public.amazon_amazon_fulfilled_inventory
         SET product_id = $2::uuid, resolved_product_id = $2::uuid
         WHERE COALESCE(resolved_product_id, product_id) = $1::uuid
         RETURNING id::text`,
        [row.orphan_product_id, newId],
      );
      remapCounts.afi += aUp.rowCount ?? 0;

      const fUp = await client.query(
        `UPDATE public.amazon_fba_inventory
         SET product_id = $2::uuid, resolved_product_id = $2::uuid
         WHERE COALESCE(resolved_product_id, product_id) = $1::uuid
         RETURNING id::text`,
        [row.orphan_product_id, newId],
      );
      remapCounts.fba += fUp.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  const spineCheck = await client.query(
    `SELECT id::text FROM public.products WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
     AND (merge_status IS NULL OR merge_status <> 'merged')`,
    [remaps.map((r) => r.new_product_id)],
  );
  if (spineCheck.rows.length !== EXPECTED_ORPHANS) {
    await client.end();
    throw new Error(`Spine proof failed after materialize: ${spineCheck.rows.length}/${EXPECTED_ORPHANS}`);
  }

  const afterCoverage = await coverage(client);
  const afterCounts = await client.query(
    `
    SELECT
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS active_map_rows,
      (SELECT COUNT(*)::int FROM public.expected_packages) AS expected_packages,
      (SELECT COUNT(*)::int FROM public.product_identifier_map
       WHERE match_source = $1 AND deleted_at IS NULL) AS v200_map_rows
  `,
    [MATCH_SOURCE],
  );
  await client.end();

  const mapIds = insertedMaps.map((r) => `'${String((r as { external_listing_id: string }).external_listing_id).replace(/'/g, "''")}'`);
  const productIds = insertedProducts.map((r) => `'${String(r.id).replace(/'/g, "''")}'::uuid`);
  const remapRollback = remaps
    .map(
      (r) =>
        `-- Orphan ${r.orphan_product_id} -> was remapped to ${r.new_product_id}; restore import FKs manually from preimage if needed.`,
    )
    .join("\n");

  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      "-- Rollback V200 E1B blocker materialize (products + maps + import remaps).",
      "DELETE FROM public.product_identifier_map",
      mapIds.length ? `WHERE external_listing_id IN (${mapIds.join(", ")});` : "WHERE false;",
      "",
      "DELETE FROM public.products",
      productIds.length ? `WHERE id IN (${productIds.join(", ")});` : "WHERE false;",
      "",
      remapRollback,
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(outDir, "inserted-products.json"), JSON.stringify(insertedProducts, null, 2));
  fs.writeFileSync(path.join(outDir, "inserted-map-rows.json"), JSON.stringify(insertedMaps, null, 2));
  fs.writeFileSync(path.join(outDir, "import-remap-summary.json"), JSON.stringify({ remaps, remapCounts }, null, 2));

  const manifest = {
    prompt: "EXPECTED-PACKAGES-E1B-BLOCKER-MATERIALIZE-EXECUTE-V200",
    run_id: runId,
    staging_ref: STAGING_REF,
    status: "PASS",
    products_inserted: productsInserted,
    products_linked_existing: linkedExisting,
    map_rows_inserted: mapsInserted,
    import_remaps: remapCounts,
    spine_proof_passes: true,
    expected_packages_updated: false,
    before_coverage: beforeCoverage,
    after_coverage: afterCoverage,
    before_counts: beforeCounts.rows[0],
    after_counts: afterCounts.rows[0],
    forbidden: {
      production_touched: false,
      amazon_api_called: false,
      ai_or_openai_called: false,
      package_items_created: false,
      blind_bulk: false,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    [
      "# E1B blocker materialize execute V200",
      "",
      `- Products inserted: **${productsInserted}** (linked existing: **${linkedExisting}**)`,
      `- Map rows inserted: **${mapsInserted}**`,
      `- Import remaps: manage **${remapCounts.manage}**, AFI **${remapCounts.afi}**, FBA **${remapCounts.fba}**`,
      `- Read-layer resolved: ${beforeCoverage.read_layer_resolved} -> **${afterCoverage.read_layer_resolved}**`,
      `- Unresolved: ${beforeCoverage.unresolved} -> **${afterCoverage.unresolved}**`,
      "",
      "Expected_packages not updated. Spine proof **PASS** (10/10).",
    ].join("\n"),
  );
  console.log(JSON.stringify(manifest, null, 2));

  const skipE1b = process.argv.includes("--skip-e1b");
  if (!skipE1b) {
    const e1bRunId = `${runId}-e1b`;
    const v199RunId = v199RunIdArg();
    const e1b = spawnSync(
      "npx",
      [
        "tsx",
        "scripts/expected-packages-e1b-map-bridge-execute-v198.ts",
        `--run-id=${e1bRunId}`,
        `--v199-run-id=${v199RunId}`,
      ],
      { cwd: process.cwd(), encoding: "utf8", shell: true },
    );
    fs.writeFileSync(
      path.join(outDir, "e1b-followup.json"),
      JSON.stringify(
        { run_id: e1bRunId, exit_code: e1b.status, stdout: e1b.stdout, stderr: e1b.stderr },
        null,
        2,
      ),
    );
    if (e1b.status !== 0) {
      console.error("E1B follow-up failed:", e1b.stderr || e1b.stdout);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
