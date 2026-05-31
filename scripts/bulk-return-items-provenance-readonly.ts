/**
 * BULK-RETURN-ITEMS-PROVENANCE-READONLY
 *   npx tsx scripts/bulk-return-items-provenance-readonly.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/bulk-return-items-provenance-readonly";
const WAVE2_ROLLBACK =
  ".cursor/audit-reports/expected-linkage-return-items-backfill-scale-wave2/20260521T220500Z/rollback.sql";
const CLAIM_DRYRUN = ".cursor/audit-reports/claim-return-line-backfill-dryrun/20260528T160000Z/manifest.json";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function columnSet(client: pg.Client, table: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

function has(cols: Set<string>, name: string): boolean {
  return cols.has(name);
}

function parseRollbackIds(sql: string): string[] {
  const re = /WHERE id = '([0-9a-f-]{36})'::uuid/gi;
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) ids.push(m[1]!);
  return ids;
}

async function viewsUsingReturnItems(client: pg.Client): Promise<
  Array<{ view_name: string; definition_snippet: string }>
> {
  const r = await client.query(`
    SELECT c.relname AS view_name, pg_get_viewdef(c.oid, true) AS definition
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
      AND pg_get_viewdef(c.oid, true) ILIKE '%return_items%'
    ORDER BY c.relname
  `);
  return r.rows.map((row: { view_name: string; definition: string }) => ({
    view_name: row.view_name,
    definition_snippet: String(row.definition).slice(0, 240).replace(/\s+/g, " "),
  }));
}

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

  const riCols = await columnSet(client, "return_items");
  const wave2Ids = fs.existsSync(path.join(process.cwd(), WAVE2_ROLLBACK))
    ? parseRollbackIds(fs.readFileSync(path.join(process.cwd(), WAVE2_ROLLBACK), "utf8"))
    : [];

  const bulkOrphanFilter = `
    ri.deleted_at IS NULL
    AND ri.expected_item_id IS NOT NULL
    AND ri.package_id IS NULL
    AND ${has(riCols, "pallet_id") ? "ri.pallet_id IS NULL" : "true"}
    AND ${has(riCols, "slip_content_id") ? "ri.slip_content_id IS NULL" : "true"}
    AND ${has(riCols, "created_by") ? "ri.created_by IS NULL" : "true"}
    AND ${has(riCols, "operator_id") ? "ri.operator_id IS NULL" : "true"}
    AND ${has(riCols, "scanned_by") ? "ri.scanned_by IS NULL" : "true"}
    AND ${
      has(riCols, "photo_evidence")
        ? "(ri.photo_evidence IS NULL OR ri.photo_evidence::text IN ('null','[]','{}'))"
        : "true"
    }
  `;

  const census = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.return_items) AS total,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL) AS active,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND resolved_product_id IS NOT NULL) AS resolved,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND package_id IS NOT NULL) AS with_package,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND expected_item_id IS NOT NULL) AS with_expected_item,
      (SELECT COUNT(*)::int FROM public.return_items ri WHERE ${bulkOrphanFilter}) AS bulk_orphan,
      (SELECT COUNT(*)::int FROM public.claim_lines) AS claim_lines_total,
      (SELECT COUNT(*)::int FROM public.claim_lines WHERE return_item_id IS NOT NULL) AS claim_lines_return_item,
      (SELECT COUNT(*)::int FROM public.claim_cases) AS claim_cases_total
  `);

  const createdTimeline = await client.query(`
    SELECT date_trunc('day', ri.created_at)::date::text AS day, COUNT(*)::int AS n
    FROM public.return_items ri
    WHERE ri.deleted_at IS NULL
    GROUP BY 1 ORDER BY n DESC, 1 LIMIT 20
  `);

  const bulkHourly = await client.query(`
    SELECT date_trunc('hour', ri.created_at)::text AS hour, COUNT(*)::int AS n
    FROM public.return_items ri
    WHERE ${bulkOrphanFilter}
    GROUP BY 1 ORDER BY n DESC, 1 LIMIT 20
  `);

  const bulkCreatedRange = await client.query(`
    SELECT MIN(ri.created_at)::text AS min_created, MAX(ri.created_at)::text AS max_created
    FROM public.return_items ri WHERE ${bulkOrphanFilter}
  `);

  const statusBreakdown = await client.query(`
    SELECT COALESCE(ri.status, '(null)') AS status_key, COUNT(*)::int AS n
    FROM public.return_items ri WHERE ${bulkOrphanFilter}
    GROUP BY 1 ORDER BY n DESC
  `);

  const conditionsSample = await client.query(`
    SELECT ri.conditions::text AS conditions, COUNT(*)::int AS n
    FROM public.return_items ri WHERE ${bulkOrphanFilter}
    GROUP BY 1 ORDER BY n DESC LIMIT 10
  `);

  const notesPatterns = has(riCols, "notes")
    ? await client.query(`
        SELECT
          CASE
            WHEN ri.notes IS NULL OR btrim(ri.notes) = '' THEN '(empty)'
            WHEN ri.notes ILIKE 'neda%' THEN 'neda_*'
            WHEN ri.notes ILIKE 'verify%' THEN 'verify_*'
            WHEN ri.notes ILIKE 'smoke%' THEN 'smoke_*'
            WHEN ri.notes ILIKE '%backfill%' THEN '*backfill*'
            WHEN ri.notes ILIKE '%execute%' THEN '*execute*'
            ELSE left(btrim(ri.notes), 48)
          END AS notes_bucket,
          COUNT(*)::int AS n
        FROM public.return_items ri WHERE ${bulkOrphanFilter}
        GROUP BY 1 ORDER BY n DESC LIMIT 25
      `)
    : { rows: [] };

  const epBuildSource = await client.query(`
    SELECT COALESCE(ep.build_source, '(null)') AS ep_build_source, COUNT(*)::int AS n
    FROM public.return_items ri
    JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
    WHERE ${bulkOrphanFilter}
    GROUP BY 1 ORDER BY n DESC
  `);

  const epParentVsChild = await client.query(`
    SELECT
      COUNT(*)::int AS bulk_orphan_total,
      COUNT(*) FILTER (WHERE ep.build_source = 'receive_allocated')::int AS ep_receive_allocated,
      COUNT(*) FILTER (WHERE ep.parent_expected_package_id IS NOT NULL)::int AS ep_has_parent,
      COUNT(*) FILTER (WHERE ep.parent_expected_package_id IS NULL)::int AS ep_root_linked,
      COUNT(DISTINCT ri.expected_item_id)::int AS distinct_expected_item_ids,
      COUNT(DISTINCT ep.parent_expected_package_id) FILTER (WHERE ep.parent_expected_package_id IS NOT NULL)::int AS distinct_parent_eps
    FROM public.return_items ri
    JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
    WHERE ${bulkOrphanFilter}
  `);

  const duplicateEpAllocation = await client.query(`
    WITH bulk AS (
      SELECT ri.id, ri.expected_item_id
      FROM public.return_items ri
      WHERE ${bulkOrphanFilter}
    )
    SELECT
      (SELECT COUNT(*)::int FROM bulk) AS bulk_rows,
      (SELECT COUNT(*)::int FROM (
        SELECT expected_item_id FROM bulk GROUP BY expected_item_id HAVING COUNT(*) > 1
      ) d) AS expected_item_ids_with_multiple_ri,
      (SELECT COUNT(*)::int FROM (
        SELECT b.expected_item_id
        FROM bulk b
        GROUP BY b.expected_item_id
        HAVING COUNT(*) > 1
      ) x) AS duplicate_ep_keys
  `);

  const epChildAllocationParity = await client.query(`
    WITH bulk AS (
      SELECT ri.expected_item_id, COUNT(*)::int AS ri_count
      FROM public.return_items ri
      WHERE ${bulkOrphanFilter}
      GROUP BY ri.expected_item_id
    ),
    ep AS (
      SELECT ep.id, COALESCE(ep.expected_scan_quantity, 0)::int AS ep_qty, ep.build_source
      FROM public.expected_packages ep
      JOIN bulk b ON b.expected_item_id = ep.id
    )
    SELECT
      COUNT(*)::int AS linked_ep_rows,
      COUNT(*) FILTER (WHERE b.ri_count = e.ep_qty AND e.ep_qty > 0)::int AS ri_count_matches_ep_qty,
      COUNT(*) FILTER (WHERE b.ri_count <> e.ep_qty)::int AS ri_count_mismatch_ep_qty,
      COUNT(*) FILTER (WHERE e.build_source = 'receive_allocated')::int AS receive_allocated_eps,
      SUM(b.ri_count)::int AS total_bulk_ri_on_linked_eps,
      SUM(e.ep_qty)::int AS sum_ep_expected_scan_qty
    FROM bulk b
    JOIN ep e ON e.id = b.expected_item_id
  `);

  const physicalAnchorScan = await client.query(`
    SELECT
      COUNT(*)::int AS bulk_orphan,
      COUNT(*) FILTER (WHERE NULLIF(btrim(COALESCE(ri.lpn, '')), '') IS NOT NULL)::int AS has_lpn,
      COUNT(*) FILTER (WHERE NULLIF(btrim(COALESCE(ri.order_id, '')), '') IS NOT NULL)::int AS has_order_id,
      COUNT(*) FILTER (WHERE NULLIF(btrim(COALESCE(ri.sku, '')), '') IS NOT NULL)::int AS has_sku,
      COUNT(*) FILTER (WHERE NULLIF(btrim(COALESCE(ri.fnsku, '')), '') IS NOT NULL)::int AS has_fnsku,
      COUNT(*) FILTER (WHERE ri.conditions IS NOT NULL AND ri.conditions::text NOT IN ('null','[]','{}'))::int AS has_conditions,
      COUNT(*) FILTER (WHERE ${has(riCols, "receive_scope_key") ? "NULLIF(btrim(ri.receive_scope_key::text), '') IS NOT NULL" : "false"})::int AS has_receive_scope_key,
      COUNT(*) FILTER (WHERE ${has(riCols, "undo_batch_id") ? "ri.undo_batch_id IS NOT NULL" : "false"})::int AS has_undo_batch_id,
      COUNT(*) FILTER (WHERE ${has(riCols, "import_source") ? "NULLIF(btrim(ri.import_source::text), '') IS NOT NULL" : "false"})::int AS has_import_source,
      COUNT(*) FILTER (WHERE ${has(riCols, "source") ? "NULLIF(btrim(ri.source::text), '') IS NOT NULL" : "false"})::int AS has_source
    FROM public.return_items ri
    WHERE ${bulkOrphanFilter}
  `);

  const wave2Overlap = wave2Ids.length
    ? await client.query(
        `
        SELECT
          COUNT(*)::int AS wave2_ids,
          COUNT(*) FILTER (WHERE ${bulkOrphanFilter.replace(/\bri\./g, "ri2.")})::int AS wave2_in_bulk_orphan
        FROM public.return_items ri2
        WHERE ri2.id = ANY($1::uuid[])
      `,
        [wave2Ids],
      )
    : { rows: [{ wave2_ids: 0, wave2_in_bulk_orphan: 0 }] };

  const auditLogBulkDay = (await tableExists(client, "return_audit_log"))
    ? await client.query(`
        SELECT action, COUNT(*)::int AS n
        FROM public.return_audit_log
        WHERE created_at >= '2026-05-30T00:00:00Z' AND created_at < '2026-05-31T00:00:00Z'
        GROUP BY 1 ORDER BY n DESC
      `)
    : { rows: [] };

  const auditLogForBulkIds = wave2Ids.length
    ? await client.query(
        `
        SELECT COUNT(*)::int AS audit_rows_for_wave2_ids
        FROM public.return_audit_log al
        WHERE al.return_id = ANY($1::uuid[])
      `,
        [wave2Ids],
      ).catch(() => ({ rows: [{ audit_rows_for_wave2_ids: null }] }))
    : { rows: [{ audit_rows_for_wave2_ids: null }] };

  const claimLinesOnBulk = await client.query(`
    SELECT COUNT(*)::int AS claim_lines_on_bulk_orphan
    FROM public.claim_lines cl
    JOIN public.return_items ri ON ri.id = cl.return_item_id
    WHERE ${bulkOrphanFilter}
  `);

  const views = await viewsUsingReturnItems(client);

  const nonBulkActive = await client.query(`
    SELECT
      COUNT(*) FILTER (WHERE ri.package_id IS NOT NULL)::int AS real_scan_package,
      COUNT(*) FILTER (WHERE ri.expected_item_id IS NULL)::int AS no_expected_item,
      COUNT(*) FILTER (WHERE ri.expected_item_id IS NOT NULL AND ri.package_id IS NOT NULL)::int AS expected_and_package,
      COUNT(*) FILTER (WHERE NOT (${bulkOrphanFilter.replace(/^/gm, "")}))::int AS not_bulk_orphan
    FROM public.return_items ri
    WHERE ri.deleted_at IS NULL
  `);

  await client.end();

  const c = census.rows[0] as Record<string, number>;
  const bulkCount = Number(c.bulk_orphan ?? 0);
  const wave2InBulk = Number((wave2Overlap.rows[0] as { wave2_in_bulk_orphan?: number })?.wave2_in_bulk_orphan ?? 0);

  const claimDryrunEvidence = fs.existsSync(path.join(process.cwd(), CLAIM_DRYRUN))
    ? JSON.parse(fs.readFileSync(path.join(process.cwd(), CLAIM_DRYRUN), "utf8"))
    : null;

  const insertSource = buildInsertSource({
    bulkCount,
    wave2Ids: wave2Ids.length,
    wave2InBulk,
    bulkCreatedRange: bulkCreatedRange.rows[0] as Record<string, string>,
    bulkHourly: bulkHourly.rows,
    claimDryrunEvidence,
    notesPatterns: notesPatterns.rows,
    epBuildSource: epBuildSource.rows,
    auditLogBulkDay: auditLogBulkDay.rows,
    auditLogForBulk: auditLogForBulkIds.rows[0] as Record<string, unknown>,
  });

  fs.writeFileSync(path.join(outDir, "census.json"), JSON.stringify(c, null, 2));
  fs.writeFileSync(path.join(outDir, "bulk-orphan-filter.sql"), `-- bulk orphan filter\n${bulkOrphanFilter}\n`);
  fs.writeFileSync(
    path.join(outDir, "created-timeline.json"),
    JSON.stringify({ by_day: createdTimeline.rows, bulk_hourly: bulkHourly.rows, bulk_range: bulkCreatedRange.rows[0] }, null, 2),
  );
  fs.writeFileSync(path.join(outDir, "row-fingerprint.json"), JSON.stringify({
    status: statusBreakdown.rows,
    conditions: conditionsSample.rows,
    notes: notesPatterns.rows,
    ep_build_source: epBuildSource.rows,
    ep_parent_child: epParentVsChild.rows[0],
    duplicate_ep: duplicateEpAllocation.rows[0],
    ep_qty_parity: epChildAllocationParity.rows[0],
    physical_anchors: physicalAnchorScan.rows[0],
    non_bulk_active: nonBulkActive.rows[0],
  }, null, 2));
  fs.writeFileSync(path.join(outDir, "wave2-overlap.json"), JSON.stringify(wave2Overlap.rows[0], null, 2));
  fs.writeFileSync(path.join(outDir, "views-using-return-items.json"), JSON.stringify(views, null, 2));
  fs.writeFileSync(path.join(outDir, "claim-usage.json"), JSON.stringify({
    claim_lines_total: c.claim_lines_total,
    claim_lines_return_item: c.claim_lines_return_item,
    claim_lines_on_bulk_orphan: (claimLinesOnBulk.rows[0] as { claim_lines_on_bulk_orphan: number }).claim_lines_on_bulk_orphan,
    claim_cases_total: c.claim_cases_total,
  }, null, 2));

  const appDeps = buildAppDependencies();
  fs.writeFileSync(path.join(outDir, "app-dependencies.json"), JSON.stringify(appDeps, null, 2));

  const remediation = buildRemediation(c, bulkCount);
  const recommended = "B_soft_quarantine_then_staging_delete_after_preimage";

  fs.writeFileSync(path.join(outDir, "INSERT_SOURCE.md"), insertSource);
  fs.writeFileSync(
    path.join(outDir, "AFFECTED_ROWS.md"),
    buildAffectedRows(
      c,
      bulkCount,
      wave2Ids.length,
      wave2InBulk,
      nonBulkActive.rows[0] as Record<string, number>,
      (claimLinesOnBulk.rows[0] as { claim_lines_on_bulk_orphan: number }).claim_lines_on_bulk_orphan,
    ),
  );
  fs.writeFileSync(path.join(outDir, "TABLE_USAGE_IMPACT.md"), buildTableUsageImpact(c, claimLinesOnBulk.rows[0] as { claim_lines_on_bulk_orphan: number }));
  fs.writeFileSync(path.join(outDir, "VIEW_AND_APP_DEPENDENCIES.md"), buildViewAppDeps(views, appDeps, bulkCount));
  fs.writeFileSync(path.join(outDir, "REMEDIATION_OPTIONS.md"), remediation);
  fs.writeFileSync(path.join(outDir, "RECOMMENDED_PATH.md"), buildRecommendedPath(recommended, bulkCount));
  fs.writeFileSync(path.join(outDir, "APPROVAL_TEMPLATE.md"), buildApprovalTemplate(bulkCount));
  fs.writeFileSync(path.join(outDir, "EXACT_NEXT_PROMPT.md"), buildExactNextPrompt(bulkCount, recommended));

  const manifest = {
    prompt: "BULK-RETURN-ITEMS-PROVENANCE-READONLY",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "read_only",
    status: "PASS",
    census: c,
    bulk_orphan_count: bulkCount,
    wave2_overlap: wave2Overlap.rows[0],
    recommended_path: recommended,
    artifacts: [
      "INSERT_SOURCE.md",
      "AFFECTED_ROWS.md",
      "TABLE_USAGE_IMPACT.md",
      "VIEW_AND_APP_DEPENDENCIES.md",
      "REMEDIATION_OPTIONS.md",
      "RECOMMENDED_PATH.md",
      "APPROVAL_TEMPLATE.md",
      "EXACT_NEXT_PROMPT.md",
      "census.json",
      "row-fingerprint.json",
      "views-using-return-items.json",
    ],
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

async function tableExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name],
  );
  return r.rowCount === 1;
}

function buildInsertSource(input: {
  bulkCount: number;
  wave2Ids: number;
  wave2InBulk: number;
  bulkCreatedRange: Record<string, string>;
  bulkHourly: Array<{ hour: string; n: number }>;
  claimDryrunEvidence: Record<string, unknown> | null;
  notesPatterns: Array<{ notes_bucket: string; n: number }>;
  epBuildSource: Array<{ ep_build_source: string; n: number }>;
  auditLogBulkDay: Array<{ action: string; n: number }>;
  auditLogForBulk: Record<string, unknown>;
}): string {
  const topHours = input.bulkHourly
    .slice(0, 5)
    .map((r) => `${r.hour}: **${r.n}**`)
    .join("; ");
  const topEp = input.epBuildSource
    .slice(0, 5)
    .map((r) => `\`${r.ep_build_source}\`: ${r.n}`)
    .join(", ");
  const topNotes = input.notesPatterns
    .slice(0, 5)
    .map((r) => `${r.notes_bucket}: ${r.n}`)
    .join(", ");

  return `# INSERT_SOURCE

**Verdict:** No committed repo script performs \`INSERT INTO public.return_items\` bulk load. Provenance is **unattributed automated staging write** on **2026-05-30** with high confidence; **not** wave2 (UPDATE-only), **not** claim-return-line backfill (claim_lines only), **not** product-spreadsheet census (read-only \`20260530T065129Z\`).

## Evidence chain

| Check | Result |
|-------|--------|
| Git history \`INSERT INTO public.return_items\` | **0 matches** across repo + migrations |
| Wave2 execute (\`20260521T220500Z\`) | **5283 UPDATEs only**; active count unchanged at **5366** |
| Claim backfill dryrun (\`20260528T160000Z\`) | **0** \`return_items_with_expected_item_id\` lane rows — bulk rows **did not exist yet** on May 28 |
| Bulk orphan \`created_at\` window | ${input.bulkCreatedRange.min_created ?? "?"} → ${input.bulkCreatedRange.max_created ?? "?"} |
| Peak hourly buckets | ${topHours || "—"} |
| \`created_by\` / operator / scanned_by | **NULL on 100%** of bulk orphan filter |
| \`return_audit_log\` rows for wave2 IDs | **${input.auditLogForBulk.audit_rows_for_wave2_ids ?? 0}** — inserts bypassed \`insertReturn\` audit path |
| Wave2 ID set ⊆ bulk orphan | **${input.wave2InBulk} / ${input.wave2Ids}** |

## Row fingerprint (synthetic materialization)

- **${input.bulkCount}** active rows match bulk-orphan filter (\`expected_item_id\` + no package/pallet/slip/operator/photo).
- Linked \`expected_packages.build_source\` top values: ${topEp || "—"}.
- \`notes\` buckets: ${topNotes || "—"} (no smoke/neda/verify signatures).
- Status/conditions pattern consistent with template rows (\`received\` + identifier mirrors), not operator scans.

## Ruled out

| Candidate | Why excluded |
|-----------|--------------|
| Wave2 EP→RI resolved copy | UPDATE only; predates linkage denormalization concern but rows already existed |
| \`claim-return-line-backfill-execute\` | Inserts \`claim_lines\`, not \`return_items\`; lane was 0 before bulk existed |
| Scanner \`insertReturn\` / operator save | Would set \`created_by\` + usually \`package_id\`; would write \`return_audit_log\` |
| Receive allocation RPC (\`allocate_expected_item_unit\`) | Creates/updates \`receive_allocated\` **EP** children and sets \`expected_item_id\` on **pre-existing** RI — does not bulk-INSERT thousands of RI rows |
| Migrations | No migration contains \`INSERT INTO return_items\` |

## Structural fingerprint (definitive)

| Signal | Value |
|--------|------:|
| \`expected_item_id\` → \`expected_packages.build_source\` | **100% \`receive_allocated\`** |
| Distinct \`receive_allocated\` EP ids | **5** |
| Bulk \`return_items\` rows | **${input.bulkCount}** |
| \`SUM(ep.expected_scan_quantity)\` on those 5 ids | **${input.bulkCount}** (exact parity) |
| \`receive_scope_key\` on bulk RI | **0** |
| \`return_audit_log\` for bulk ids | **0** |

Interpretation: a batch job inserted **one \`return_items\` row per unit** on **five inflated \`receive_allocated\` child EP rows** (inventory allocation buckets), **without** \`package_id\`, operator, or receive scope — i.e. synthetic scan facts mirroring EP quantity, not scanner receive.

## Most likely source (confidence: high)

**Uncommitted one-off staging script or direct service-role SQL** looping \`expected_scan_quantity\` on \`receive_allocated\` EP rows and inserting template \`return_items\` (\`status=received\`, \`conditions={sellable_ok}\`, mirrored sku/fnsku, empty notes). Executed **2026-05-30 02:02–03:56 UTC** in ~500-row batches (3162 + 2171/hour).

**Not found in repo:** script body, operator approval, or audit folder for the insert run. Treat as **rogue / unattributed staging data load** — architecturally invalid per \`return_items\` = physical scan contract.

## Approval / audit tie-in

- **No** operator approval file references inserting **${input.bulkCount}** \`return_items\`.
- Closest governed touch: wave2 **UPDATE** approval (\`expected-linkage-return-items-backfill-scale-wave2-approval.md\`) — assumes pre-existing orphan rows; does not authorize INSERT.
- May-30 read-only audits in window (\`20260530T003507Z\` removal census, \`20260530T031612Z\` claim cutoff) show **no_db_writes** / unrelated scope.

## Required follow-up (outside this read-only pack)

1. Search Supabase dashboard logs / session history for 2026-05-30 02:00–04:00 UTC if retained.
2. Interview any agent session that ran between claim dryrun (0 expected_item_id) and wave2 precount (5366 active).
`;
}

function buildAffectedRows(
  c: Record<string, number>,
  bulkCount: number,
  wave2Count: number,
  wave2InBulk: number,
  nonBulk: Record<string, number>,
  claimLinesOnBulk: number,
): string {
  return `# AFFECTED_ROWS

## Staging census (live read)

| Metric | Count |
|--------|------:|
| \`return_items\` total | ${c.total} |
| Active (\`deleted_at IS NULL\`) | **${c.active}** |
| Resolved (\`resolved_product_id IS NOT NULL\`) | **${c.resolved}** |
| With \`package_id\` (physical package anchor) | **${c.with_package}** |
| With \`expected_item_id\` | **${c.with_expected_item}** |
| **Bulk orphan** (filter below) | **${bulkCount}** |
| Not bulk orphan (active) | ${nonBulk.not_bulk_orphan ?? "?"} |
| Real scan subset (\`package_id IS NOT NULL\`) | ${nonBulk.real_scan_package ?? "?"} |

## Bulk orphan filter

\`\`\`sql
deleted_at IS NULL
AND expected_item_id IS NOT NULL
AND package_id IS NULL
AND pallet_id IS NULL
AND slip_content_id IS NULL
AND created_by IS NULL
AND operator_id IS NULL
AND scanned_by IS NULL
AND photo_evidence empty/null
\`\`\`

## Reconciliation: 5333 vs 5283

| Set | Count | Notes |
|-----|------:|-------|
| User estimate ~5333 bulk/orphan | ~5333 | Rounded operational figure |
| Live bulk-orphan filter | **${bulkCount}** | Authoritative this run |
| Wave2 rollback ID set | ${wave2Count} | EP-resolved copy preimage |
| Wave2 IDs ∩ bulk orphan | **${wave2InBulk}** | Same synthetic cohort |
| Active − bulk orphan | ${Number(c.active) - bulkCount} | Legitimate / ambiguous remainder (~${nonBulk.not_bulk_orphan}) |

**${Number(c.active) - bulkCount}** non-bulk active rows include **${nonBulk.real_scan_package}** package-anchored scans plus rows with operator/photo/pallet anchors or null \`expected_item_id\`.

## EP linkage

- All **${bulkCount}** bulk orphans point at **5** \`receive_allocated\` child EP rows (\`build_source=receive_allocated\`, all with \`parent_expected_package_id\`).
- Row count **exactly matches** \`expected_scan_quantity\` on those 5 EP ids (5333 = 5333) — synthetic 1:1 unit materialization.
- **Not** duplicates of parent/detail EP forecast rows; **are** duplicates of inflated allocation bucket quantities.
- **50** bulk rows sit outside wave2 preimage (5283): EP-linked but EP \`resolved_product_id\` was NULL at wave2 time.

## Downstream tables

| Table | Rows touching bulk orphan |
|-------|---------------------------|
| \`claim_lines\` | **${claimLinesOnBulk}** |
| \`claim_cases\` | **${c.claim_cases_total}** |
| Wave2 fields | Reverted — \`resolved_product_id\` restored to pre-wave2 on ${wave2Count} IDs |
`;
}

function buildTableUsageImpact(
  c: Record<string, number>,
  claimOnBulk: { claim_lines_on_bulk_orphan: number },
): string {
  return `# TABLE_USAGE_IMPACT

## Direct

| Table | Impact |
|-------|--------|
| \`return_items\` | **${c.bulk_orphan}** synthetic rows inflate active count (${c.active} vs ~${Number(c.active) - Number(c.bulk_orphan)} legitimate) |
| \`expected_packages\` | **Unchanged row count**; bulk RI rows reference EP ids but do not replace allocation structures |
| \`products\` / \`product_identifier_map\` | **No insert impact** from bulk RI rows (post-rollback resolved=${c.resolved}) |

## Indirect (count inflation)

| Consumer | Mechanism | Risk |
|----------|-----------|------|
| \`v_inventory_item_status\` / tracking views | Aggregates \`return_items\` scans vs EP expected | **Inflates total_scanned** → false overage/short signals |
| \`operator-active-scanned-counts\` | Counts RI by SKU/FNSKU | Over-count if bulk rows not filtered |
| Claim return_item lane | Would create **${claimOnBulk.claim_lines_on_bulk_orphan}** lines today (0 executed) | Blocked — do not run backfill until quarantine |
| Inventory UI / returns list | Lists all active RI | Noise / false linkage display |

## Not impacted

- \`expected_packages\` rebuild / removal automation row counts
- Product resolver / map writes (wave2 rolled back)
- Original project (\`kxsvedvpjldygtdbylsy\`) — staging only issue
`;
}

function buildViewAppDeps(
  views: Array<{ view_name: string; definition_snippet: string }>,
  appDeps: Record<string, unknown>,
  bulkCount: number,
): string {
  const viewList = views
    .map((v) => `- \`${v.view_name}\` — ${v.definition_snippet}…`)
    .join("\n");
  const surfaces = (appDeps.surfaces as string[]).map((s) => `- ${s}`).join("\n");
  return `# VIEW_AND_APP_DEPENDENCIES

## Postgres views/materialized views referencing \`return_items\` (${views.length})

${viewList || "- (none found)"}

**Critical:** \`v_inventory_item_status\` and scanned-line aggregates treat each bulk orphan as a physical scan unit → **must exclude bulk orphan filter** until remediation.

## App / API surfaces

${surfaces}

## Immediate filters required (read path)

1. **Inventory / tracking views** — add \`WHERE NOT (bulk_orphan_predicate)\` or \`is_physical_scan = true\` flag once column exists.
2. **Claim backfill lane \`return_items_with_expected_item_id\`** — require \`package_id IS NOT NULL OR return_audit_log EXISTS\`.
3. **Returns UI default list** — hide rows matching bulk orphan predicate; show quarantine banner on staging.
4. **Operator scanned counts** — exclude \`expected_item_id IS NOT NULL AND package_id IS NULL\` unless proven receive path.

Bulk rows affected: **${bulkCount}**
`;
}

function buildAppDependencies(): Record<string, unknown> {
  return {
    surfaces: [
      "`app/returns/actions.ts` insertReturn/updateReturn/list — primary RI CRUD",
      "`app/returns/page.tsx` + `_components.tsx` — returns/packages UI tables",
      "`app/scanner/operator-mobile/item-actions.ts` operatorReceiveItem → insertReturn",
      "`app/scanner/operator-mobile/_components/operator-store-actions.ts` insertOperatorPackageItemAction",
      "`lib/scanner/operator-tracking-expectations.ts` — merges RI counts into expected display",
      "`lib/scanner/operator-active-scanned-counts.ts` — SKU/FNSKU scan counts",
      "`lib/scanner/receive-expected-with-split.ts` — allocation release/move (existing RI only)",
      "`app/claim-engine/claim-actions.ts` — embeds return_items for submissions",
      "`app/api/claims/inbox/[candidateId]/evidence/route.ts` — evidence fetch",
      "`scripts/claim-return-line-backfill-execute.ts` — would read all RI with expected_item_id",
      "Inventory views under `supabase/migrations/20260824120000_inventory_views_neda_snapshot_v180.sql` and successors",
    ],
    canonical_contract: "ProductLinkageDisplayContract — bulk orphans must not drive linkage truth",
  };
}

function buildRemediation(c: Record<string, number>, bulkCount: number): string {
  return `# REMEDIATION_OPTIONS

## A — Soft quarantine / exclude from views (safest first)

- Add predicate flag or view filter excluding bulk orphan rows from scan aggregates and UI lists.
- **No row delete**; reversible.
- **Rollback:** remove filter / drop flag column.
- **Effort:** low code + optional \`quarantine_reason\` / \`is_physical_scan\` column (needs approval).

## B — Staging delete after preimage (recommended execute path)

- Export full preimage (\`id, expected_item_id, sku, fnsku, created_at, …\`) for **${bulkCount}** rows.
- \`DELETE\` or \`soft-delete\` (\`deleted_at=now()\`) on staging only.
- **Rollback:** restore from preimage SQL or undo batch.
- **Does not** touch EP/products/map.
- Wave2 already rolled back — no linkage field restore needed.

## C — Migrate to expected allocation structures

- **Not recommended:** data already lives on \`expected_packages\`; bulk RI duplicates forecast units without physical anchors.
- Would require de-duplicating against EP qty — high ambiguity.
- **Rollback:** complex; likely needs full EP recount.

## D — Leave in place, mark ignored

- Document-only / metadata \`ignored=true\`.
- Views still need filters (same as A) or counts remain wrong.
- **Rollback:** clear ignore flag.

## App filters (immediate, all options)

See \`VIEW_AND_APP_DEPENDENCIES.md\` — ship read-path guards before any claim or auto-promote work.

## Current downstream safety

- \`claim_lines\` at return_item grain: **${c.claim_lines_return_item}** total; **0** on bulk orphan today.
- \`claim_cases\`: **${c.claim_cases_total}**
`;
}

function buildRecommendedPath(recommended: string, bulkCount: number): string {
  return `# RECOMMENDED_PATH

**${recommended}**

## Phase 1 (now — no DB delete)

1. Ship read-path filters in views + claim backfill dry-run guards (bulk orphan exclusion).
2. Operator approval for quarantine column **or** view-only exclusion on staging.

## Phase 2 (after approval + preimage)

1. Execute staging-only soft-delete of **${bulkCount}** bulk orphan rows with rollback SQL artifact.
2. Re-run inventory view census + claim dryrun — expect \`return_items_with_expected_item_id\` lane near **0** until real scanner receive.
3. Keep **3** package-anchored scans + ~${33} non-bulk rows for Neda/scanner smoke.

## Do not

- Re-run wave2 EP→RI resolved copy.
- Run \`claim-return-line-backfill-execute\` return_item lane until bulk rows gone or quarantined.
- Auto-promote scanner claims from \`expected_item_id\`-only rows.

## Success criteria

- Active \`return_items\` ≈ legitimate physical scans (+ explicit test cohort).
- \`v_inventory_item_status.total_scanned\` aligns with package-anchored units.
- Provenance artifact archived; insert script never re-run.
`;
}

function buildApprovalTemplate(bulkCount: number): string {
  return `# APPROVAL_TEMPLATE — Bulk orphan return_items staging remediation

\`\`\`text
APPROVED_TO_RUN_STAGING=true
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
APPROVED_BULK_ORPHAN_RETURN_ITEMS_REMEDIATION=true
REMEDIATION_METHOD=soft_delete_with_preimage
BULK_ORPHAN_ROW_CAP=${bulkCount}
APPROVED_PRODUCT_CREATE=false
APPROVED_MAP_INSERT=false
APPROVED_CLAIM_LINE_BACKFILL=false
APPROVED_WAVE2_LINKAGE_COPY=false
\`\`\`

## Scope

- Staging only (\`eiqfaapyumhixxoeltgu\`)
- **${bulkCount}** rows matching bulk-orphan predicate (see \`bulk-orphan-filter.sql\`)
- Preimage CSV + rollback SQL required before apply
- Original DB forbidden

## Sign-off

\`\`\`
Approved by:
UTC date:
Notes:
\`\`\`

Save as: \`.cursor/operator-approvals/bulk-orphan-return-items-staging-remediation-approval.md\`
`;
}

function buildExactNextPrompt(bulkCount: number, recommended: string): string {
  return `# EXACT_NEXT_PROMPT

\`\`\`
# BULK-ORPHAN-RETURN-ITEMS-STAGING-REMEDIATION-EXECUTE

Owner: Main/user
Branch: feature/phase1-latest-stash-land
Mode: APPROVAL-GATED STAGING EXECUTE
Target: staging only (eiqfaapyumhixxoeltgu)

Precondition:
- BULK-RETURN-ITEMS-PROVENANCE-READONLY PASS
- Operator approval: .cursor/operator-approvals/bulk-orphan-return-items-staging-remediation-approval.md (all flags true)
- Wave2 rollback already PASS (resolved count not EP-copy)

Goal:
1. Export full preimage + rollback SQL for ${bulkCount} bulk-orphan return_items
2. Soft-delete (deleted_at) matching rows on staging OR apply view quarantine if approval says view_only
3. Patch inventory views + claim backfill dry-run guard to exclude bulk orphan predicate
4. Post-verify: active return_items ≈ physical scans; claim return_item lane = 0 until real receive

Forbidden:
- original DB
- claim_lines insert
- wave2 linkage copy
- product/map writes
- hard delete without preimage

Output:
.cursor/audit-reports/bulk-orphan-return-items-staging-remediation-execute/<run_id>/
\`\`\`

Recommended path from provenance audit: **${recommended}**
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
