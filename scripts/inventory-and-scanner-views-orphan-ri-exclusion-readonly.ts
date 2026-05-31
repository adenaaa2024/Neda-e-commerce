/**
 * INVENTORY-AND-SCANNER-VIEWS-ORPHAN-RI-EXCLUSION-READONLY
 *   npx tsx scripts/inventory-and-scanner-views-orphan-ri-exclusion-readonly.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/inventory-and-scanner-views-orphan-ri-exclusion-readonly";
const BULK_ORPHAN_PREDICATE = `
  ri.deleted_at IS NULL
  AND ri.expected_item_id IS NOT NULL
  AND ri.package_id IS NULL
  AND ri.pallet_id IS NULL
  AND (NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema='public' AND c.table_name='return_items' AND c.column_name='slip_content_id'
  ) OR ri.slip_content_id IS NULL)
`;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

type Consumer = {
  id: string;
  kind: "view" | "rpc" | "migration_fn" | "server_action" | "client_page" | "lib_helper" | "script";
  path: string;
  category:
    | "physical_scanner_ui"
    | "package_pallet_counts"
    | "inventory_status"
    | "claims"
    | "reports_dashboard"
    | "expected_allocation"
    | "write_path"
    | "audit_script";
  reads_return_items: boolean;
  filters: {
    deleted_at: "yes" | "no" | "n/a";
    package_id: "required" | "optional" | "not_filtered" | "n/a";
    bulk_orphan_excluded: "yes" | "no" | "partial" | "n/a";
  };
  safety: "safe" | "unsafe" | "partial" | "n/a";
  orphan_pollution_risk: "high" | "medium" | "low" | "none";
  notes: string;
  should_use_expected_packages_instead: boolean;
};

const CONSUMERS: Consumer[] = [
  {
    id: "view_v_scanned_items_counted",
    kind: "view",
    path: "supabase/migrations/20260828120000_removal_carrier_normalization_views.sql (+ v189 deleted_at predecessor)",
    category: "inventory_status",
    reads_return_items: true,
    filters: { deleted_at: "no", package_id: "not_filtered", bulk_orphan_excluded: "no" },
    safety: "unsafe",
    orphan_pollution_risk: "high",
    notes: "COUNT(*) all return_items; orphan rows contribute sku/fnsku buckets with NULL tracking/slip. v281 recreate may have dropped v189 deleted_at filter — verify live def.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "view_v_inventory_item_status",
    kind: "view",
    path: "supabase/migrations/20260828120000_removal_carrier_normalization_views.sql",
    category: "inventory_status",
    reads_return_items: true,
    filters: { deleted_at: "no", package_id: "not_filtered", bulk_orphan_excluded: "no" },
    safety: "unsafe",
    orphan_pollution_risk: "high",
    notes: "UNION expected_packages totals + v_scanned_items_counted scanned totals → total_scanned/status chips.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "view_v_inventory_status",
    kind: "view",
    path: "supabase/migrations/20260828120000_removal_carrier_normalization_views.sql",
    category: "inventory_status",
    reads_return_items: true,
    filters: { deleted_at: "no", package_id: "not_filtered", bulk_orphan_excluded: "no" },
    safety: "unsafe",
    orphan_pollution_risk: "high",
    notes: "Rollup of v_inventory_item_status — inherits scanned inflation.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "view_mv_daily_store_analytics",
    kind: "view",
    path: "staging-only materialized view (referenced in prior audits)",
    category: "reports_dashboard",
    reads_return_items: true,
    filters: { deleted_at: "unknown", package_id: "not_filtered", bulk_orphan_excluded: "no" },
    safety: "unsafe",
    orphan_pollution_risk: "medium",
    notes: "Embeds return_items lifecycle counts; likely counts all active rows.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "rpc_allocate_expected_item_unit",
    kind: "rpc",
    path: "supabase/migrations/20260830120000_expected_receive_split_item_level.sql",
    category: "expected_allocation",
    reads_return_items: true,
    filters: { deleted_at: "n/a", package_id: "n/a", bulk_orphan_excluded: "n/a" },
    safety: "safe",
    orphan_pollution_risk: "none",
    notes: "UPDATE existing RI expected_item_id; does not aggregate counts.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "rpc_delete_cascade_undo",
    kind: "rpc",
    path: "supabase/migrations/20260903120000_delete_cascade_undo_audit_foundation_v2.sql",
    category: "write_path",
    reads_return_items: true,
    filters: { deleted_at: "n/a", package_id: "n/a", bulk_orphan_excluded: "n/a" },
    safety: "n/a",
    orphan_pollution_risk: "none",
    notes: "Soft-delete/undo by id — not a count consumer.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "lib_fetchReturnItemsScannedCountsForTracking",
    kind: "lib_helper",
    path: "lib/scanner/operator-tracking-expectations.ts",
    category: "physical_scanner_ui",
    reads_return_items: true,
    filters: { deleted_at: "yes", package_id: "required", bulk_orphan_excluded: "yes" },
    safety: "safe",
    orphan_pollution_risk: "none",
    notes: "Resolves packages by tracking first; `.in('package_id', pkgIds)`.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "lib_countActiveReturnItemsForIdentifierScan",
    kind: "lib_helper",
    path: "lib/scanner/operator-active-scanned-counts.ts",
    category: "physical_scanner_ui",
    reads_return_items: true,
    filters: { deleted_at: "yes", package_id: "optional", bulk_orphan_excluded: "partial" },
    safety: "partial",
    orphan_pollution_risk: "high",
    notes: "Lines 131–141: rows without package_id and without baseline notes still increment count — includes bulk orphans matched by sku/fnsku.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "lib_scrubInventoryRowsExcludingVoidedPackages",
    kind: "lib_helper",
    path: "lib/scanner/operator-active-scanned-counts.ts",
    category: "inventory_status",
    reads_return_items: true,
    filters: { deleted_at: "yes", package_id: "partial", bulk_orphan_excluded: "partial" },
    safety: "partial",
    orphan_pollution_risk: "medium",
    notes: "Replaces view total_scanned for tracking/sku/fnsku/slip paths; sku/fnsku path uses countActiveReturnItemsForIdentifierScan (partial).",
    should_use_expected_packages_instead: false,
  },
  {
    id: "lib_v_inventory_status_query",
    kind: "lib_helper",
    path: "lib/scanner/v-inventory-status.ts",
    category: "inventory_status",
    reads_return_items: false,
    filters: { deleted_at: "n/a", package_id: "n/a", bulk_orphan_excluded: "no" },
    safety: "unsafe",
    orphan_pollution_risk: "high",
    notes: "Reads v_inventory_item_status / v_inventory_status views directly before optional scrub.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "action_fetchExpectedPackagesNedaRead",
    kind: "server_action",
    path: "app/returns/expected-packages-linkage-actions.ts",
    category: "expected_allocation",
    reads_return_items: true,
    filters: { deleted_at: "yes", package_id: "required", bulk_orphan_excluded: "yes" },
    safety: "safe",
    orphan_pollution_risk: "none",
    notes: "countScannedForExpectedRow requires matching packages then `.in('package_id', pkgIds)`.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "action_listOperatorPackageItemsForPackage",
    kind: "server_action",
    path: "app/scanner/operator-mobile/_components/operator-store-actions.ts",
    category: "physical_scanner_ui",
    reads_return_items: true,
    filters: { deleted_at: "yes", package_id: "required", bulk_orphan_excluded: "yes" },
    safety: "safe",
    orphan_pollution_risk: "none",
    notes: "`.eq('package_id', pkgId)`.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "action_listReturnsByPackage",
    kind: "server_action",
    path: "app/returns/actions.ts",
    category: "package_pallet_counts",
    reads_return_items: true,
    filters: { deleted_at: "yes", package_id: "required", bulk_orphan_excluded: "yes" },
    safety: "safe",
    orphan_pollution_risk: "none",
    notes: "Package drawer item list.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "action_listReturns",
    kind: "server_action",
    path: "app/returns/actions.ts",
    category: "reports_dashboard",
    reads_return_items: true,
    filters: { deleted_at: "yes", package_id: "not_filtered", bulk_orphan_excluded: "no" },
    safety: "unsafe",
    orphan_pollution_risk: "medium",
    notes: "Returns Items tab — limit 200 but pollutes UI sample; countReturns() includes all 5366.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "action_countReturns",
    kind: "server_action",
    path: "app/returns/actions.ts",
    category: "reports_dashboard",
    reads_return_items: true,
    filters: { deleted_at: "yes", package_id: "not_filtered", bulk_orphan_excluded: "no" },
    safety: "unsafe",
    orphan_pollution_risk: "high",
    notes: "Head count of all active return_items — includes 5333 orphans.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "action_listReturnsByPallet",
    kind: "server_action",
    path: "app/returns/actions.ts",
    category: "package_pallet_counts",
    reads_return_items: true,
    filters: { deleted_at: "yes", package_id: "not_filtered", bulk_orphan_excluded: "no" },
    safety: "partial",
    orphan_pollution_risk: "low",
    notes: "Filters pallet_id; bulk orphans have null pallet_id — excluded unless mis-linked.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "page_scan_operator_mobile",
    kind: "client_page",
    path: "app/scanner/operator-mobile/scan/page.tsx",
    category: "physical_scanner_ui",
    reads_return_items: false,
    filters: { deleted_at: "n/a", package_id: "n/a", bulk_orphan_excluded: "partial" },
    safety: "partial",
    orphan_pollution_risk: "high",
    notes: "Shipment Entry reads v_inventory_item_status; scrub may not run on all code paths.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "action_inventoryViewsLinkageRead",
    kind: "server_action",
    path: "app/returns/inventory-views-linkage-actions.ts",
    category: "inventory_status",
    reads_return_items: false,
    filters: { deleted_at: "n/a", package_id: "n/a", bulk_orphan_excluded: "no" },
    safety: "unsafe",
    orphan_pollution_risk: "high",
    notes: "Reads v_inventory_item_status for linkage enrichment.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "action_returnsClaimsWorkQueue",
    kind: "server_action",
    path: "app/returns/returns-claims-work-queue-actions.ts",
    category: "claims",
    reads_return_items: true,
    filters: { deleted_at: "yes", package_id: "required", bulk_orphan_excluded: "yes" },
    safety: "safe",
    orphan_pollution_risk: "none",
    notes: "Uses isPhysicalReturnItemForClaims / isBulkOrphanReturnItemPattern gate.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "lib_scannerOperatorClaimPromote",
    kind: "lib_helper",
    path: "lib/scanner-operator-claim-promote.ts",
    category: "claims",
    reads_return_items: true,
    filters: { deleted_at: "yes", package_id: "required", bulk_orphan_excluded: "yes" },
    safety: "safe",
    orphan_pollution_risk: "none",
    notes: "Promote blocked for bulk_orphan_excluded.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "script_claimReturnLineBackfill",
    kind: "script",
    path: "scripts/claim-return-line-backfill-execute.ts",
    category: "claims",
    reads_return_items: true,
    filters: { deleted_at: "yes", package_id: "not_filtered", bulk_orphan_excluded: "no" },
    safety: "unsafe",
    orphan_pollution_risk: "high",
    notes: "Lane `return_items_with_expected_item_id`: all RI with expected_item_id → claim_lines.",
    should_use_expected_packages_instead: true,
  },
  {
    id: "script_claimReturnLineBackfillDryrun",
    kind: "script",
    path: "scripts/claim-return-line-backfill-dryrun.ts",
    category: "claims",
    reads_return_items: true,
    filters: { deleted_at: "yes", package_id: "not_filtered", bulk_orphan_excluded: "no" },
    safety: "unsafe",
    orphan_pollution_risk: "high",
    notes: "expected_group short/overage lanes use v_inventory_item_status totals — double pollution.",
    should_use_expected_packages_instead: true,
  },
  {
    id: "action_insertReturn",
    kind: "server_action",
    path: "app/returns/actions.ts",
    category: "write_path",
    reads_return_items: false,
    filters: { deleted_at: "n/a", package_id: "n/a", bulk_orphan_excluded: "n/a" },
    safety: "n/a",
    orphan_pollution_risk: "none",
    notes: "Write path — sets created_by when actor present.",
    should_use_expected_packages_instead: false,
  },
  {
    id: "rpc_list_workspace_orgs",
    kind: "rpc",
    path: "supabase/migrations/20260815152000_list_workspace_return_items_rpc_patch.sql",
    category: "reports_dashboard",
    reads_return_items: true,
    filters: { deleted_at: "yes", package_id: "not_filtered", bulk_orphan_excluded: "no" },
    safety: "partial",
    orphan_pollution_risk: "low",
    notes: "Org registry existence only — not scan counts.",
    should_use_expected_packages_instead: false,
  },
];

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl.includes(STAGING_REF)) throw new Error(`Staging ref guard failed (${STAGING_REF})`);

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const colR = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='return_items'`,
  );
  const riCols = new Set(colR.rows.map((x: { column_name: string }) => x.column_name));
  const bulkOrphanPredicate = buildBulkOrphanPredicate(riCols);

  const bulkCount = await client.query(`
    SELECT COUNT(*)::int AS n FROM public.return_items ri WHERE ${bulkOrphanPredicate}
  `);

  const activeCount = await client.query(
    `SELECT COUNT(*)::int AS n FROM public.return_items WHERE deleted_at IS NULL`,
  );

  const viewDefs: Record<string, string> = {};
  for (const v of ["v_scanned_items_counted", "v_inventory_item_status", "v_inventory_status"]) {
    const r = await client.query(
      `SELECT pg_get_viewdef($1::regclass, true) AS def`,
      [`public.${v}`],
    ).catch(() => ({ rows: [{ def: "" }] }));
    viewDefs[v] = String(r.rows[0]?.def ?? "");
  }

  const viewFlags = {
    v_scanned_items_counted: {
      has_deleted_at_filter: /deleted_at\s+IS\s+NULL/i.test(viewDefs.v_scanned_items_counted ?? ""),
      has_package_id_filter: /package_id\s+IS\s+NOT\s+NULL/i.test(viewDefs.v_scanned_items_counted ?? ""),
      has_bulk_orphan_exclusion: /expected_item_id[\s\S]{0,80}package_id/i.test(viewDefs.v_scanned_items_counted ?? ""),
    },
    v_inventory_item_status: {
      inherits_v_scanned: /v_scanned_items_counted/i.test(viewDefs.v_inventory_item_status ?? ""),
    },
  };

  const pollution = await client.query(`
    SELECT
      (SELECT COALESCE(SUM(total_scanned), 0)::bigint FROM public.v_scanned_items_counted) AS v_scanned_sum,
      (SELECT COALESCE(SUM(total_scanned), 0)::bigint FROM public.v_inventory_item_status) AS v_item_status_sum,
      (SELECT COUNT(*)::int FROM public.v_inventory_item_status
        WHERE total_scanned > 0 AND (tracking_number IS NULL OR btrim(tracking_number) = '')) AS item_rows_null_tracking_with_scans,
      (SELECT COUNT(*)::int FROM public.v_inventory_item_status WHERE total_scanned > total_expected) AS overage_rows
  `);

  const orphanInViewContribution = await client.query(`
    WITH bulk AS (
      SELECT ri.id, ri.sku, ri.fnsku, ri.organization_id, ri.store_id
      FROM public.return_items ri WHERE ${bulkOrphanPredicate}
    )
    SELECT COUNT(*)::int AS bulk_orphan_rows FROM bulk
  `);

  const claimLineOnBulk = await client.query(`
    SELECT COUNT(*)::int AS n
    FROM public.claim_lines cl
    JOIN public.return_items ri ON ri.id = cl.return_item_id
    WHERE ${bulkOrphanPredicate}
  `);

  await client.end();

  const bulkN = (bulkCount.rows[0] as { n: number }).n;
  const activeN = (activeCount.rows[0] as { n: number }).n;
  const pol = pollution.rows[0] as Record<string, string | number>;

  fs.writeFileSync(
    path.join(outDir, "staging-pollution-metrics.json"),
    JSON.stringify(
      {
        staging_ref: STAGING_REF,
        active_return_items: activeN,
        bulk_orphan_rows: bulkN,
        bulk_orphan_predicate: bulkOrphanPredicate.trim(),
        view_flags: viewFlags,
        pollution: pol,
        claim_lines_on_bulk_orphan: claimLineOnBulk.rows[0],
        orphan_in_view_note:
          "Each bulk orphan row is counted in v_scanned_items_counted via COUNT(*) without package_id gate — contributes to total_scanned buckets (often NULL tracking).",
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(path.join(outDir, "consumers.json"), JSON.stringify(CONSUMERS, null, 2));

  const unsafe = CONSUMERS.filter((c) => c.safety === "unsafe");
  const partial = CONSUMERS.filter((c) => c.safety === "partial");
  const safe = CONSUMERS.filter((c) => c.safety === "safe");

  fs.writeFileSync(path.join(outDir, "RETURN_ITEMS_CONSUMERS.md"), buildConsumersMd(CONSUMERS, bulkN, activeN, bulkOrphanPredicate));
  fs.writeFileSync(path.join(outDir, "UNSAFE_COUNTS_OR_VIEWS.md"), buildUnsafeMd(unsafe, partial, pol, bulkN, viewFlags));
  fs.writeFileSync(path.join(outDir, "SAFE_CONSUMERS.md"), buildSafeMd(safe));
  fs.writeFileSync(path.join(outDir, "REQUIRED_PATCHES.md"), buildPatchesMd(bulkN, viewFlags, unsafe, partial));
  fs.writeFileSync(path.join(outDir, "EXACT_NEXT_PROMPTS.md"), buildNextPromptsMd(bulkN));

  const manifest = {
    prompt: "INVENTORY-AND-SCANNER-VIEWS-ORPHAN-RI-EXCLUSION-READONLY",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "read_only",
    status: "PASS",
    bulk_orphan_rows: bulkN,
    active_return_items: activeN,
    unsafe_consumers: unsafe.length,
    partial_consumers: partial.length,
    safe_consumers: safe.length,
    v_scanned_sum_total_scanned: pol.v_scanned_sum,
    artifacts: [
      "RETURN_ITEMS_CONSUMERS.md",
      "UNSAFE_COUNTS_OR_VIEWS.md",
      "SAFE_CONSUMERS.md",
      "REQUIRED_PATCHES.md",
      "EXACT_NEXT_PROMPTS.md",
      "consumers.json",
      "staging-pollution-metrics.json",
    ],
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

function buildBulkOrphanPredicate(cols: Set<string>): string {
  const parts = [
    "ri.deleted_at IS NULL",
    "ri.expected_item_id IS NOT NULL",
    "ri.package_id IS NULL",
    cols.has("pallet_id") ? "ri.pallet_id IS NULL" : "true",
    cols.has("slip_content_id") ? "ri.slip_content_id IS NULL" : "true",
  ];
  return parts.join("\n  AND ");
}

function buildConsumersMd(consumers: Consumer[], bulkN: number, activeN: number, predicate: string): string {
  const rows = consumers
    .map(
      (c) =>
        `| ${c.id} | ${c.kind} | ${c.category} | ${c.path} | ${c.filters.deleted_at} | ${c.filters.package_id} | ${c.filters.bulk_orphan_excluded} | ${c.safety} | ${c.orphan_pollution_risk} | ${c.should_use_expected_packages_instead ? "EP preferred" : "RI ok"} | ${c.notes.replace(/\|/g, "\\|")} |`,
    )
    .join("\n");
  return `# RETURN_ITEMS_CONSUMERS

**Staging:** \`eiqfaapyumhixxoeltgu\` · **Bulk orphan rows:** ${bulkN} / ${activeN} active

## Canonical bulk-orphan predicate (physical-scan exclusion)

\`\`\`sql
${predicate.trim()}
\`\`\`

Architectural rule: **forecast / allocation units live on \`expected_packages\`**; \`return_items\` rows matching the predicate are not physical scans.

## Consumer matrix

| id | kind | category | path | deleted_at | package_id | orphan excluded | safety | risk | EP instead? | notes |
|----|------|----------|------|------------|------------|-----------------|--------|------|-------------|-------|
${rows}

## Category legend

| category | Meaning |
|----------|---------|
| physical_scanner_ui | Operator scan / package item modals |
| package_pallet_counts | Per-package or per-pallet unit lists |
| inventory_status | v_inventory_* compare expected vs scanned |
| claims | Claim lines, promote, work queue |
| reports_dashboard | Returns list, counts, analytics |
| expected_allocation | EP read + receive RPCs |
| write_path | insert/update/delete |
| audit_script | Read-only census scripts |
`;
}

function buildUnsafeMd(
  unsafe: Consumer[],
  partial: Consumer[],
  pol: Record<string, string | number>,
  bulkN: number,
  viewFlags: Record<string, unknown>,
): string {
  return `# UNSAFE_COUNTS_OR_VIEWS

## Live staging pollution (read-only probe)

| Metric | Value |
|--------|------:|
| Bulk orphan \`return_items\` | **${bulkN}** |
| \`SUM(v_scanned_items_counted.total_scanned)\` | **${pol.v_scanned_sum}** |
| \`SUM(v_inventory_item_status.total_scanned)\` | **${pol.v_item_status_sum}** |
| Item-status rows with scans but NULL tracking | **${pol.item_rows_null_tracking_with_scans}** |
| Item-status overage rows (\`scanned > expected\`) | **${pol.overage_rows}** |

## View definition flags (staging live)

\`\`\`json
${JSON.stringify(viewFlags, null, 2)}
\`\`\`

**Critical:** If \`has_deleted_at_filter\` or \`has_package_id_filter\` is false on \`v_scanned_items_counted\`, all ${bulkN} orphan rows inflate scanned aggregates.

## Unsafe consumers (must patch before trusting counts)

${unsafe.map((c) => `- **\`${c.id}\`** (${c.category}) — ${c.path}\n  - ${c.notes}`).join("\n\n")}

## Partial consumers (patch or verify all call paths)

${partial.map((c) => `- **\`${c.id}\`** — ${c.notes}`).join("\n")}

## Where \`expected_packages\` should drive the metric instead

| Use case | Wrong source today | Correct source |
|----------|-------------------|----------------|
| Forecast / short / overage vs expected | \`COUNT(return_items)\` or inflated \`v_inventory_item_status.total_scanned\` | \`expected_packages.expected_scan_quantity\` + receive_allocated children |
| Claim import_source / financial removal | N/A | \`claim_candidates\` / Amazon import tables |
| Physical scan count | Unfiltered \`return_items\` | \`return_items\` **with** \`package_id IS NOT NULL\` (or governed loose-item baseline notes path) |
| return_item grain claim lines | \`return_items_with_expected_item_id\` backfill lane | Only RI passing \`isPhysicalReturnItemForClaims\` |
`;
}

function buildSafeMd(safe: Consumer[]): string {
  return `# SAFE_CONSUMERS

These paths already require a physical anchor (\`package_id\`) and/or explicit bulk-orphan exclusion.

${safe.map((c) => `## \`${c.id}\`

- **Path:** \`${c.path}\`
- **Category:** ${c.category}
- **Notes:** ${c.notes}
`).join("\n")}

## Shared gate (reuse in patches)

\`lib/returns-claims-work-queue.ts\`:

- \`isBulkOrphanReturnItemPattern(row)\` — \`expected_item_id\` set, all of package/pallet/slip null
- \`isPhysicalReturnItemForClaims(row)\` — requires \`package_id\`, rejects bulk orphan

Already wired in:

- \`app/returns/returns-claims-work-queue-actions.ts\`
- \`lib/scanner-operator-claim-promote.ts\`
`;
}

function buildPatchesMd(
  bulkN: number,
  viewFlags: Record<string, unknown>,
  unsafe: Consumer[],
  partial: Consumer[],
): string {
  const deletedAtMissing = !(viewFlags.v_scanned_items_counted as { has_deleted_at_filter?: boolean })?.has_deleted_at_filter;
  return `# REQUIRED_PATCHES

**Mode:** plan only — no code/DB changes in this audit.

## P0 — SQL views (inventory spine)

### P0a. \`v_scanned_items_counted\`

Add to \`scanned_grouped\` inner query:

\`\`\`sql
WHERE r.deleted_at IS NULL
  AND NOT (
    r.expected_item_id IS NOT NULL
    AND r.package_id IS NULL
    AND r.pallet_id IS NULL
  )
\`\`\`

Stricter alternative (aligns with claims gate):

\`\`\`sql
WHERE r.deleted_at IS NULL
  AND r.package_id IS NOT NULL
\`\`\`

${deletedAtMissing ? "**Also restore:** `WHERE r.deleted_at IS NULL` if missing after v281 carrier normalization migration.\n" : ""}

**Migration file:** new idempotent migration after \`20260828120000_removal_carrier_normalization_views.sql\`  
**Verify:** \`SUM(total_scanned)\` drops by ~${bulkN}; package-anchored scans unchanged.

### P0b. \`v_inventory_item_status\` / \`v_inventory_status\`

No separate filter needed if P0a fixed — they inherit cleaned \`v_scanned_items_counted\`. Re-\`CREATE OR REPLACE\` if CASCADE dropped dependents.

### P0c. Staging-only \`mv_daily_store_analytics\` (if present)

Refresh definition or exclude bulk orphan predicate from item lifecycle counts.

## P1 — TypeScript read paths

### P1a. \`lib/scanner/operator-active-scanned-counts.ts\`

In \`countActiveReturnItemsForIdentifierScan\`, **remove** fallback \`count++\` for rows without \`package_id\` and without Shipment Entry baseline notes — or require \`!isBulkOrphanReturnItemPattern(row)\`.

### P1b. \`app/returns/actions.ts\` — \`listReturns\` / \`countReturns\`

Add optional filter param or default exclusion:

\`\`\`ts
.or("package_id.not.is.null,expected_item_id.is.null")
\`\`\`

Or server-side \`NOT isBulkOrphanReturnItemPattern\` for Returns UI totals.

### P1c. \`scripts/claim-return-line-backfill-execute.ts\`

Lane 1 SQL — add:

\`\`\`sql
AND ri.package_id IS NOT NULL
AND NOT (ri.expected_item_id IS NOT NULL AND ri.package_id IS NULL AND ri.pallet_id IS NULL)
\`\`\`

Lanes 2–3 (\`expected_group_*\`) — depend on P0 view fix or compute short/overage from EP only.

## P2 — Shared helper extraction

Create \`lib/return-items-physical-scan-filter.ts\` exporting:

- \`bulkOrphanReturnItemsSqlPredicate(alias)\` for SQL fragments
- Re-export \`isBulkOrphanReturnItemPattern\` / \`isPhysicalReturnItemForClaims\` from one module

## P3 — Tests / verification (post-patch)

- Extend \`scripts/test-returns-claims-work-queue-physical-anchor-gate.ts\`
- Add readonly census script comparing \`SUM(v_scanned)\` before/after
- Re-run \`claim-return-line-backfill-dryrun\` — return_item lane must stay 0 until real scans

## Patch priority map

| Priority | Consumer ids |
|----------|--------------|
| P0 | ${unsafe.filter((c) => c.kind === "view").map((c) => c.id).join(", ")} |
| P1 | ${[...unsafe, ...partial].filter((c) => c.kind !== "view").map((c) => c.id).join(", ")} |

## Out of scope (data remediation — separate prompt)

Soft-delete ${bulkN} bulk orphan rows on staging after preimage — see \`BULK-ORPHAN-RETURN-ITEMS-STAGING-REMEDIATION-EXECUTE\`.
`;
}

function buildNextPromptsMd(bulkN: number): string {
  return `# EXACT_NEXT_PROMPTS

## 1. View patch (required first)

\`\`\`
# INVENTORY-VIEWS-BULK-ORPHAN-RI-EXCLUSION-MIGRATION

Owner: Main/user
Branch: feature/phase1-latest-stash-land
Mode: APPROVAL-GATED STAGING APPLY
Target: staging only (eiqfaapyumhixxoeltgu)

Precondition:
- INVENTORY-AND-SCANNER-VIEWS-ORPHAN-RI-EXCLUSION-READONLY PASS
- Operator approval for view DDL on staging

Goal:
1. New migration: patch v_scanned_items_counted with deleted_at + bulk-orphan exclusion (see REQUIRED_PATCHES P0a)
2. Recreate v_inventory_item_status + v_inventory_status
3. Staging verify: SUM(total_scanned) drops ~${bulkN}; 3 package-anchored scans preserved
4. Original parity plan only — do not apply to original without separate approval

Output:
.cursor/audit-reports/inventory-views-bulk-orphan-ri-exclusion-migration/<run_id>/
\`\`\`

## 2. App guard patch (parallel or after P0)

\`\`\`
# SCANNER-ACTIVE-SCAN-COUNTS-BULK-ORPHAN-GUARD

Goal:
- Patch countActiveReturnItemsForIdentifierScan + scrubInventoryRowsExcludingVoidedPackages
- Reuse isBulkOrphanReturnItemPattern from lib/returns-claims-work-queue.ts
- Unit tests in scripts/test-returns-claims-work-queue-physical-anchor-gate.ts

No DB writes.
\`\`\`

## 3. Data remediation (after view patch)

\`\`\`
# BULK-ORPHAN-RETURN-ITEMS-STAGING-REMEDIATION-EXECUTE

(from BULK-RETURN-ITEMS-PROVENANCE-READONLY EXACT_NEXT_PROMPT)
\`\`\`

## 4. Claim backfill gate

\`\`\`
# CLAIM-RETURN-LINE-BACKFILL-PHYSICAL-ANCHOR-GATE

Goal:
- Patch claim-return-line-backfill-execute + dryrun lanes
- Require isPhysicalReturnItemForClaims equivalent in SQL
- Block execute until bulk orphans remediated or views patched

Read-only dryrun first.
\`\`\`
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
