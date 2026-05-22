/**
 * EXPECTED-PACKAGES-E1B-SPINE-REMAP-EXECUTE-V201
 *
 * Wave-A spine repair from V199 plan: remap orphan import FKs → active products.id,
 * then re-run E1B map-only bridge. No product creation when plan shows remap only.
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
const APPROVAL_PATH =
  ".cursor/operator-approvals/expected-packages-e1b-blocker-materialize-v200-approval.md";
const OUT_BASE = ".cursor/audit-reports/expected-packages-e1b-spine-remap-execute-v201";
const EXPECTED_ORPHANS = 10;

type PlanCandidate = {
  orphan_product_id: string;
  target_product_id: string | null;
  disposition: string;
  wave: string;
  expected_package_ids: string[];
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
  return a ? a.split("=")[1]!.trim() : "20260522T150000Z";
}

function v199RunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--v199-run-id="));
  return a ? a.split("=")[1]!.trim() : "20260519T230000Z";
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

async function main(): Promise<void> {
  const runId = runIdArg();
  const planRunId = planRunIdArg();
  const v199RunId = v199RunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  if (!readApproval()) {
    throw new Error(`Approval flags are not true in ${APPROVAL_PATH}`);
  }

  const planPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/amazon-manage-fba-orphan-product-id-spine-repair-plan-v199",
    planRunId,
    "candidate-preimage.json",
  );
  const planRaw = JSON.parse(fs.readFileSync(planPath, "utf8")) as { candidates: PlanCandidate[] };
  const candidates = planRaw.candidates.filter(
    (c) => c.target_product_id && c.wave === "wave_a_remap_import",
  );
  if (candidates.length !== EXPECTED_ORPHANS) {
    throw new Error(`Expected ${EXPECTED_ORPHANS} wave-A candidates, found ${candidates.length}`);
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
  await client.query(`SET statement_timeout = '180s'`);

  const beforeCoverage = await coverage(client);
  const remaps: { orphan_product_id: string; target_product_id: string }[] = [];
  const remapCounts = { manage: 0, afi: 0, fba: 0 };

  await client.query("BEGIN");
  try {
    for (const c of candidates) {
      const orphan = c.orphan_product_id;
      const target = c.target_product_id!;
      remaps.push({ orphan_product_id: orphan, target_product_id: target });

      const spine = await client.query(
        `SELECT id::text FROM public.products WHERE id = $1::uuid AND deleted_at IS NULL
         AND (merge_status IS NULL OR merge_status <> 'merged')`,
        [target],
      );
      if (spine.rows.length !== 1) {
        throw new Error(`Target product ${target} not on active spine`);
      }

      const mUp = await client.query(
        `UPDATE public.amazon_manage_fba_inventory
         SET product_id = $2::uuid, resolved_product_id = $2::uuid
         WHERE COALESCE(resolved_product_id, product_id) = $1::uuid
         RETURNING id::text`,
        [orphan, target],
      );
      remapCounts.manage += mUp.rowCount ?? 0;

      const aUp = await client.query(
        `UPDATE public.amazon_amazon_fulfilled_inventory
         SET product_id = $2::uuid, resolved_product_id = $2::uuid
         WHERE COALESCE(resolved_product_id, product_id) = $1::uuid
         RETURNING id::text`,
        [orphan, target],
      );
      remapCounts.afi += aUp.rowCount ?? 0;

      const fUp = await client.query(
        `UPDATE public.amazon_fba_inventory
         SET product_id = $2::uuid, resolved_product_id = $2::uuid
         WHERE COALESCE(resolved_product_id, product_id) = $1::uuid
         RETURNING id::text`,
        [orphan, target],
      );
      remapCounts.fba += fUp.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  const afterCoveragePreE1b = await coverage(client);
  await client.end();

  fs.writeFileSync(path.join(outDir, "import-remap-summary.json"), JSON.stringify({ remaps, remapCounts }, null, 2));

  const e1bRunId = `${runId}-e1b`;
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
    JSON.stringify({ run_id: e1bRunId, exit_code: e1b.status, stdout: e1b.stdout, stderr: e1b.stderr }, null, 2),
  );

  let afterCoverage = beforeCoverage;
  let e1bManifest: Record<string, unknown> | null = null;
  const e1bManifestPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/expected-packages-e1b-map-bridge-execute-v198",
    e1bRunId,
    "manifest.json",
  );
  if (fs.existsSync(e1bManifestPath)) {
    e1bManifest = JSON.parse(fs.readFileSync(e1bManifestPath, "utf8")) as Record<string, unknown>;
    afterCoverage = (e1bManifest.after_coverage as Record<string, number>) ?? afterCoverage;
  }

  const status = e1b.status === 0 ? "PASS" : "E1B_FAILED";
  const manifest = {
    prompt: "EXPECTED-PACKAGES-E1B-SPINE-REMAP-EXECUTE-V201",
    run_id: runId,
    plan_run_id: planRunId,
    v199_run_id: v199RunId,
    staging_ref: STAGING_REF,
    status,
    wave: "wave_a_remap_import",
    orphan_count: EXPECTED_ORPHANS,
    import_remaps: remapCounts,
    products_created: 0,
    expected_packages_updated: false,
    before_coverage: beforeCoverage,
    after_coverage_pre_e1b: afterCoveragePreE1b,
    after_coverage: afterCoverage,
    e1b: e1bManifest,
    forbidden: {
      production: false,
      amazon_api: false,
      ai: false,
      package_items: false,
      product_creation: false,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    [
      "# E1B spine remap execute V201",
      "",
      `- Orphans remapped: **${EXPECTED_ORPHANS}**`,
      `- Import row updates: manage **${remapCounts.manage}**, AFI **${remapCounts.afi}**, FBA **${remapCounts.fba}**`,
      `- Products created: **0**`,
      `- Read-layer resolved: ${beforeCoverage.read_layer_resolved} -> **${afterCoverage.read_layer_resolved ?? "?"}**`,
      `- Unresolved: ${beforeCoverage.unresolved} -> **${afterCoverage.unresolved ?? "?"}**`,
      `- E1B follow-up exit: **${e1b.status}**`,
    ].join("\n") + "\n",
  );

  console.log(JSON.stringify(manifest, null, 2));
  if (e1b.status !== 0) {
    console.error(e1b.stderr || e1b.stdout);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
