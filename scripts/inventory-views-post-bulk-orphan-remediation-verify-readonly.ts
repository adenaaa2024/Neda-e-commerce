/**
 * INVENTORY-VIEWS-POST-BULK-ORPHAN-REMEDIATION-VERIFY (read-only)
 *
 *   npx tsx scripts/inventory-views-post-bulk-orphan-remediation-verify-readonly.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";
import { sqlExcludeBulkOrphanReturnItems } from "../lib/return-item-physical-scan";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/inventory-views-post-bulk-orphan-remediation-verify";
const REMEDIATION_MANIFEST_DEFAULT =
  ".cursor/audit-reports/return-items-bulk-orphan-regression-cleanup-staging/20260521T162000Z/manifest.json";

const BULK_ORPHAN_WHERE = `
  deleted_at IS NULL
  AND expected_item_id IS NOT NULL
  AND package_id IS NULL
  AND pallet_id IS NULL
`;

const INVENTORY_VIEWS = ["v_scanned_items_counted", "v_inventory_item_status", "v_inventory_status"] as const;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function remediationManifestPath(): string {
  const a = process.argv.find((x) => x.startsWith("--remediation-run-id="));
  if (a) {
    return `.cursor/audit-reports/return-items-bulk-orphan-regression-cleanup-staging/${a.split("=")[1]!.trim()}/manifest.json`;
  }
  return REMEDIATION_MANIFEST_DEFAULT;
}

type ReturnItemsCounts = {
  active_return_items: number;
  return_process_display_count: number;
  package_attached_scans: number;
  pallet_attached_scans: number;
  pallet_only_scans: number;
  bulk_orphan_active: number;
  physical_scan_units: number;
};

type ViewCounts = {
  v_scanned_items_counted_rows: number;
  v_scanned_items_counted_sum_total_scanned: number;
  v_inventory_item_status_rows: number;
  v_inventory_item_status_sum_total_scanned: number;
  v_inventory_item_status_sum_total_expected: number;
  v_inventory_status_rows: number;
  v_inventory_status_sum_total_scanned: number;
  view_has_package_id_gate: boolean;
  view_has_deleted_at_filter: boolean;
};

async function returnItemsCounts(client: pg.Client): Promise<ReturnItemsCounts> {
  const r = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL) AS active_return_items,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND ${sqlExcludeBulkOrphanReturnItems("return_items")}) AS return_process_display_count,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND package_id IS NOT NULL) AS package_attached_scans,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND pallet_id IS NOT NULL) AS pallet_attached_scans,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND pallet_id IS NOT NULL AND package_id IS NULL) AS pallet_only_scans,
      (SELECT COUNT(*)::int FROM public.return_items WHERE ${BULK_ORPHAN_WHERE}) AS bulk_orphan_active,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND package_id IS NOT NULL) AS physical_scan_units
  `);
  const row = r.rows[0] as Record<string, number>;
  return {
    active_return_items: row.active_return_items,
    return_process_display_count: row.return_process_display_count,
    package_attached_scans: row.package_attached_scans,
    pallet_attached_scans: row.pallet_attached_scans,
    pallet_only_scans: row.pallet_only_scans,
    bulk_orphan_active: row.bulk_orphan_active,
    physical_scan_units: row.physical_scan_units,
  };
}

async function viewCounts(client: pg.Client): Promise<ViewCounts> {
  const defR = await client.query(`SELECT pg_get_viewdef('public.v_scanned_items_counted'::regclass, true) AS def`);
  const def = String(defR.rows[0]?.def ?? "");

  const r = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.v_scanned_items_counted) AS v_scanned_items_counted_rows,
      (SELECT COALESCE(SUM(total_scanned), 0)::bigint FROM public.v_scanned_items_counted) AS v_scanned_items_counted_sum_total_scanned,
      (SELECT COUNT(*)::int FROM public.v_inventory_item_status) AS v_inventory_item_status_rows,
      (SELECT COALESCE(SUM(total_scanned), 0)::bigint FROM public.v_inventory_item_status) AS v_inventory_item_status_sum_total_scanned,
      (SELECT COALESCE(SUM(total_expected), 0)::bigint FROM public.v_inventory_item_status) AS v_inventory_item_status_sum_total_expected,
      (SELECT COUNT(*)::int FROM public.v_inventory_status) AS v_inventory_status_rows,
      (SELECT COALESCE(SUM(total_scanned), 0)::bigint FROM public.v_inventory_status) AS v_inventory_status_sum_total_scanned
  `);
  const row = r.rows[0] as Record<string, string | number>;
  return {
    v_scanned_items_counted_rows: Number(row.v_scanned_items_counted_rows),
    v_scanned_items_counted_sum_total_scanned: Number(row.v_scanned_items_counted_sum_total_scanned),
    v_inventory_item_status_rows: Number(row.v_inventory_item_status_rows),
    v_inventory_item_status_sum_total_scanned: Number(row.v_inventory_item_status_sum_total_scanned),
    v_inventory_item_status_sum_total_expected: Number(row.v_inventory_item_status_sum_total_expected),
    v_inventory_status_rows: Number(row.v_inventory_status_rows),
    v_inventory_status_sum_total_scanned: Number(row.v_inventory_status_sum_total_scanned),
    view_has_package_id_gate: /package_id\s+IS\s+NOT\s+NULL/i.test(def) || /INNER\s+JOIN\s+public\.packages/i.test(def),
    view_has_deleted_at_filter: /deleted_at\s+IS\s+NULL/i.test(def),
  };
}

function loadBaseline(): {
  after: Record<string, number> | null;
  remediation_run_id: string | null;
} {
  const p = path.join(process.cwd(), remediationManifestPath());
  if (!fs.existsSync(p)) return { after: null, remediation_run_id: null };
  const m = JSON.parse(fs.readFileSync(p, "utf8")) as {
    run_id?: string;
    AFTER_COUNTS?: Record<string, number>;
  };
  return { after: m.AFTER_COUNTS ?? null, remediation_run_id: m.run_id ?? null };
}

function delta(
  current: Record<string, number>,
  baseline: Record<string, number> | null,
): Record<string, number | null> {
  if (!baseline) return {};
  const out: Record<string, number | null> = {};
  for (const k of Object.keys(current)) {
    if (baseline[k] !== undefined) out[k] = current[k]! - baseline[k]!;
  }
  return out;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl.includes(STAGING_REF)) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const ri = await returnItemsCounts(client);
  const views = await viewCounts(client);
  const { after: baselineAfter, remediation_run_id } = loadBaseline();

  await client.end();

  const baselineMap: Record<string, number> = baselineAfter
    ? {
        active_return_items: baselineAfter.active_return_items,
        return_process_display_count: baselineAfter.return_process_active_count,
        package_attached_scans: baselineAfter.package_scan_rows,
        pallet_only_scans: baselineAfter.pallet_only_scan_rows ?? 0,
        bulk_orphan_active: baselineAfter.bulk_orphan_target,
        physical_scan_units: baselineAfter.package_scan_rows,
      }
    : {};

  const currentMap: Record<string, number> = {
    active_return_items: ri.active_return_items,
    return_process_display_count: ri.return_process_display_count,
    package_attached_scans: ri.package_attached_scans,
    pallet_only_scans: ri.pallet_only_scans,
    bulk_orphan_active: ri.bulk_orphan_active,
    physical_scan_units: ri.physical_scan_units,
  };

  const countsDelta = delta(currentMap, baselineAfter ? baselineMap : null);

  const viewMatchesPhysical =
    views.view_has_package_id_gate &&
    views.view_has_deleted_at_filter &&
    views.v_scanned_items_counted_sum_total_scanned === ri.physical_scan_units;

  const safeToContinue =
    ri.bulk_orphan_active === 0 &&
    views.view_has_package_id_gate &&
    views.view_has_deleted_at_filter &&
    viewMatchesPhysical &&
    (baselineAfter === null ||
      (countsDelta.active_return_items === 0 &&
        countsDelta.bulk_orphan_active === 0 &&
        countsDelta.package_attached_scans === 0 &&
        countsDelta.return_process_display_count === 0));

  const manifest = {
    prompt: "INVENTORY-VIEWS-POST-BULK-ORPHAN-REMEDIATION-VERIFY",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "read_only",
    remediation_baseline_run_id: remediation_run_id,
    RETURN_ITEMS_COUNTS: ri,
    VIEW_COUNTS: views,
    DELTA: {
      vs_remediation_after: countsDelta,
      view_scanned_vs_physical_scan_units:
        views.v_scanned_items_counted_sum_total_scanned - ri.physical_scan_units,
    },
    inventory_views_present: INVENTORY_VIEWS,
    SAFE_TO_CONTINUE: safeToContinue ? "yes" : "no",
    checks: {
      bulk_orphan_zero: ri.bulk_orphan_active === 0,
      view_package_id_gate: views.view_has_package_id_gate,
      view_deleted_at_filter: views.view_has_deleted_at_filter,
      view_scanned_matches_package_scans: viewMatchesPhysical,
      no_drift_from_remediation_baseline: baselineAfter
        ? Object.values(countsDelta).every((v) => v === 0)
        : null,
    },
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# INVENTORY-VIEWS-POST-BULK-ORPHAN-REMEDIATION-VERIFY",
      "",
      "| Check | Result |",
      "|-------|--------|",
      `| Bulk orphan active | **${ri.bulk_orphan_active}** |`,
      `| Package-attached scans | **${ri.package_attached_scans}** |`,
      `| Pallet-attached scans | **${ri.pallet_attached_scans}** (pallet-only: ${ri.pallet_only_scans}) |`,
      `| Return Process display count | **${ri.return_process_display_count}** |`,
      `| v_scanned SUM(total_scanned) | **${views.v_scanned_items_counted_sum_total_scanned}** |`,
      `| View package_id gate | **${views.view_has_package_id_gate ? "yes" : "no"}** |`,
      `| SAFE_TO_CONTINUE | **${manifest.SAFE_TO_CONTINUE}** |`,
    ].join("\n"),
    "utf8",
  );

  console.log(
    JSON.stringify(
      {
        RETURN_ITEMS_COUNTS: ri,
        VIEW_COUNTS: views,
        DELTA: manifest.DELTA,
        SAFE_TO_CONTINUE: manifest.SAFE_TO_CONTINUE,
        outDir,
      },
      null,
      2,
    ),
  );

  if (!safeToContinue) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
