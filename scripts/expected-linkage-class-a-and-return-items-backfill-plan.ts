/**
 * EXPECTED-LINKAGE-CLASS-A-AND-RETURN-ITEMS-BACKFILL-PLAN (read-only)
 *   npx tsx scripts/expected-linkage-class-a-and-return-items-backfill-plan.ts --run-id=<UTC>
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
const CENSUS_RUN_ID = "20260607T150000Z";
const CENSUS_DIR = `.cursor/audit-reports/expected-product-linkage-gap-census/${CENSUS_RUN_ID}`;
const OUT_BASE = ".cursor/audit-reports/expected-linkage-class-a-and-return-items-backfill-plan";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

const CLASS_A_EP_IDS = [
  "f07b7f86-6b72-4e76-958c-2fe7654343cb",
  "b7715312-1c3e-4190-b881-1feac3450740",
];

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function sqlLit(v: string | null | undefined): string {
  if (v == null) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function writeCsv(filePath: string, headers: string[], rows: Record<string, unknown>[]): void {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  fs.writeFileSync(
    filePath,
    [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n") + "\n",
  );
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const censusPath = path.join(process.cwd(), CENSUS_DIR, "staging-census.json");
  if (!fs.existsSync(censusPath)) {
    throw new Error(`Missing census evidence: ${censusPath}`);
  }
  const census = JSON.parse(fs.readFileSync(censusPath, "utf8")) as {
    expected_packages_classification?: { A?: number };
    return_items_expected_item_link?: { ep_resolved_return_not?: number };
  };

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

  const classARows = await client.query(
    `
    WITH ep AS (
      SELECT
        ep.id,
        ep.organization_id,
        ep.store_id,
        ep.tracking_number,
        ep.sku,
        ep.fnsku,
        ep.resolved_product_id,
        ep.identifier_resolution_status
      FROM public.expected_packages ep
      WHERE ep.id = ANY($1::uuid[])
    ),
    map_hit AS (
      SELECT
        ep.id AS ep_id,
        m.id AS map_id,
        m.product_id,
        m.seller_sku,
        m.fnsku AS map_fnsku,
        m.match_source
      FROM ep
      JOIN public.product_identifier_map m
        ON m.organization_id = ep.organization_id
       AND m.store_id = ep.store_id
       AND m.deleted_at IS NULL
       AND m.product_id IS NOT NULL
       AND (
         (NULLIF(btrim(ep.fnsku), '') IS NOT NULL AND upper(btrim(m.fnsku)) = upper(btrim(ep.fnsku)))
         OR (NULLIF(btrim(ep.sku), '') IS NOT NULL AND upper(btrim(m.seller_sku)) = upper(btrim(ep.sku)))
       )
    ),
    map_agg AS (
      SELECT ep_id, COUNT(DISTINCT product_id)::int AS map_product_count, MIN(product_id::text) AS sole_product_id
      FROM map_hit
      GROUP BY ep_id
    )
    SELECT
      ep.*,
      ma.map_product_count,
      ma.sole_product_id,
      mh.map_id::text AS sample_map_id,
      mh.match_source,
      p.product_name,
      p.sku AS product_sku
    FROM ep
    LEFT JOIN map_agg ma ON ma.ep_id = ep.id
    LEFT JOIN map_hit mh ON mh.ep_id = ep.id
    LEFT JOIN public.products p ON p.id = ma.sole_product_id::uuid
    ORDER BY ep.tracking_number
    `,
    [CLASS_A_EP_IDS],
  );

  const orphanSummary = await client.query(`
    SELECT
      COUNT(*)::int AS total_orphans,
      COUNT(*) FILTER (WHERE ep.resolved_product_id IS NOT NULL)::int AS ep_resolved_copyable,
      COUNT(*) FILTER (WHERE ep.resolved_product_id IS NULL)::int AS ep_also_unresolved,
      COUNT(*) FILTER (WHERE ri.product_id IS NOT NULL AND ri.product_id IS DISTINCT FROM ep.resolved_product_id)::int AS legacy_product_id_mismatch,
      COUNT(*) FILTER (WHERE ep.resolved_product_id IS NOT NULL AND ri.product_id IS NULL)::int AS no_legacy_product_id,
      COUNT(DISTINCT ep.resolved_product_id) FILTER (WHERE ep.resolved_product_id IS NOT NULL)::int AS distinct_ep_products,
      COUNT(DISTINCT ep.id) FILTER (WHERE ep.resolved_product_id IS NOT NULL)::int AS distinct_ep_rows,
      MIN(ri.created_at)::text AS oldest_orphan_created_at,
      MAX(ri.created_at)::text AS newest_orphan_created_at
    FROM public.return_items ri
    JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
    WHERE ri.deleted_at IS NULL
      AND ri.resolved_product_id IS NULL
      AND ep.resolved_product_id IS NOT NULL
  `);

  const orphanByStatus = await client.query(`
    SELECT
      COALESCE(ri.identifier_resolution_status, '(null)') AS return_status,
      COUNT(*)::int AS row_count
    FROM public.return_items ri
    JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
    WHERE ri.deleted_at IS NULL
      AND ri.resolved_product_id IS NULL
      AND ep.resolved_product_id IS NOT NULL
    GROUP BY 1
    ORDER BY row_count DESC
  `);

  const sample50 = await client.query(
    `
    SELECT
      ri.id::text AS return_item_id,
      ri.expected_item_id::text,
      ri.organization_id::text,
      ri.store_id::text,
      ri.sku AS return_sku,
      ri.fnsku AS return_fnsku,
      ri.asin AS return_asin,
      ri.product_id::text AS legacy_product_id,
      ri.resolved_product_id::text AS current_resolved_product_id,
      ri.identifier_resolution_status AS return_resolution_status,
      ri.identifier_resolution_confidence::text AS return_resolution_confidence,
      ri.created_at::text,
      ep.tracking_number,
      ep.sku AS ep_sku,
      ep.fnsku AS ep_fnsku,
      ep.resolved_product_id::text AS ep_resolved_product_id,
      ep.identifier_resolution_status AS ep_resolution_status,
      p.product_name AS target_product_name
    FROM public.return_items ri
    JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
    LEFT JOIN public.products p ON p.id = ep.resolved_product_id
    WHERE ri.deleted_at IS NULL
      AND ri.resolved_product_id IS NULL
      AND ep.resolved_product_id IS NOT NULL
    ORDER BY ri.id
    LIMIT 50
    `,
  );

  await client.end();

  const classA = classARows.rows as Record<string, unknown>[];
  if (classA.length !== 2) {
    throw new Error(`Expected 2 Class A EP rows on staging, found ${classA.length}`);
  }
  for (const row of classA) {
    if (Number(row.map_product_count) !== 1) {
      throw new Error(`Class A row ${row.id} no longer has exactly one map product (${row.map_product_count})`);
    }
    if (row.resolved_product_id != null) {
      throw new Error(`Class A row ${row.id} already has resolved_product_id`);
    }
  }

  const orphan = orphanSummary.rows[0] as Record<string, unknown>;
  const censusOrphans = census.return_items_expected_item_link?.ep_resolved_return_not ?? 0;
  if (Number(orphan.total_orphans) !== Number(censusOrphans)) {
    throw new Error(
      `Orphan count drift: census=${censusOrphans}, live=${orphan.total_orphans}. Re-run census before apply.`,
    );
  }

  const classAPlan = classA.map((row) => ({
    expected_package_id: row.id,
    tracking_number: row.tracking_number,
    sku: row.sku,
    fnsku: row.fnsku,
    proposed_resolved_product_id: row.sole_product_id,
    sample_map_id: row.sample_map_id,
    product_name: row.product_name,
    apply_action: "UPDATE expected_packages.resolved_product_id from existing map (Class A)",
  }));

  const sampleRows = sample50.rows as Record<string, unknown>[];
  const classARollback = classA.map(
    (row) =>
      `UPDATE public.expected_packages SET resolved_product_id = NULL, identifier_resolution_status = ${sqlLit(row.identifier_resolution_status as string | null)}, updated_at = now() WHERE id = ${sqlLit(String(row.id))}::uuid;`,
  );
  const returnRollback = sampleRows.map(
    (row) =>
      `UPDATE public.return_items SET resolved_product_id = NULL, identifier_resolution_status = ${sqlLit(row.return_resolution_status as string | null)}, identifier_resolution_confidence = ${row.return_resolution_confidence ?? "NULL"}, updated_at = now() WHERE id = ${sqlLit(String(row.return_item_id))}::uuid;`,
  );
  const classAApply = classA.map(
    (row) =>
      `UPDATE public.expected_packages SET resolved_product_id = ${sqlLit(String(row.sole_product_id))}::uuid, identifier_resolution_status = 'resolved', updated_at = now() WHERE id = ${sqlLit(String(row.id))}::uuid AND resolved_product_id IS NULL;`,
  );
  const returnApply = sampleRows.map(
    (row) =>
      `UPDATE public.return_items ri SET resolved_product_id = ep.resolved_product_id, identifier_resolution_status = 'resolved', identifier_resolution_confidence = 1.0, updated_at = now() FROM public.expected_packages ep WHERE ri.id = ${sqlLit(String(row.return_item_id))}::uuid AND ri.expected_item_id = ep.id AND ri.deleted_at IS NULL AND ri.resolved_product_id IS NULL AND ep.resolved_product_id IS NOT NULL;`,
  );

  fs.writeFileSync(path.join(outDir, "class-a-rows.json"), JSON.stringify(classAPlan, null, 2));
  fs.writeFileSync(
    path.join(outDir, "return-item-orphan-summary.json"),
    JSON.stringify({ summary: orphan, by_return_status: orphanByStatus.rows }, null, 2),
  );
  fs.writeFileSync(path.join(outDir, "sample-50-return-items.json"), JSON.stringify(sampleRows, null, 2));
  writeCsv(
    path.join(outDir, "sample-50-return-items.csv"),
    [
      "return_item_id",
      "expected_item_id",
      "tracking_number",
      "return_sku",
      "return_fnsku",
      "ep_resolved_product_id",
      "target_product_name",
      "return_resolution_status",
    ],
    sampleRows.map((r) => ({
      return_item_id: r.return_item_id,
      expected_item_id: r.expected_item_id,
      tracking_number: r.tracking_number,
      return_sku: r.return_sku,
      return_fnsku: r.return_fnsku,
      ep_resolved_product_id: r.ep_resolved_product_id,
      target_product_name: r.target_product_name,
      return_resolution_status: r.return_resolution_status,
    })),
  );

  fs.writeFileSync(
    path.join(outDir, "rollback-sample.sql"),
    [
      "-- Rollback sample only (2 Class A EP + 50 return_items)",
      `-- plan run_id: ${runId}`,
      "",
      "-- Plan A rollback (Class A EP)",
      ...classARollback,
      "",
      "-- Plan B rollback (return_items sample 50)",
      ...returnRollback,
      "",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "apply-sql-preview-sample.sql"),
    [
      "-- PREVIEW ONLY — do not run without approval",
      `-- plan run_id: ${runId}`,
      "",
      "-- Plan A: Class A EP resolved_product_id backfill (max 2)",
      ...classAApply,
      "",
      "-- Plan B: return_items copy EP resolved_product_id (sample 50)",
      ...returnApply,
      "",
    ].join("\n"),
  );

  const approvalTemplate = `# APPROVAL_TEMPLATE — Expected linkage Class A + return_items sample backfill

**Default:** not approved.

| Field | Value |
|-------|--------|
| Target ref | \`${STAGING_REF}\` |
| Census evidence | \`${CENSUS_DIR}/\` |
| Plan run | \`${OUT_BASE}/${runId}/\` |

## Plan A — Class A EP backfill (max 2 rows)

| EP id | Tracking | FNSKU | Proposed product |
|-------|----------|-------|------------------|
| \`f07b7f86-6b72-4e76-958c-2fe7654343cb\` | 2251839738 | X003ZXVFXV | \`15c2b80e-c3d6-4799-aeba-718a10fccbbd\` |
| \`b7715312-1c3e-4190-b881-1feac3450740\` | 387019251 | X003ZXVFXV | \`15c2b80e-c3d6-4799-aeba-718a10fccbbd\` |

## Plan B — return_items EP-resolved copy (sample max 50)

- Orphan pool: **${orphan.total_orphans}** rows (\`return_items.resolved_product_id IS NULL\` AND linked \`expected_packages.resolved_product_id IS NOT NULL\`)
- Sample file: \`sample-50-return-items.csv\`

## Forbidden

- Product create / seed (Class C)
- \`product_identifier_map\` insert
- Original / production writes
- Broad apply beyond approved row lists

## Required operator flags

\`\`\`text
APPROVED_TO_RUN_STAGING=true
APPROVED_CLASS_A_EP_BACKFILL=true
APPROVED_CLASS_A_EP_MAX_2=true
APPROVED_RETURN_ITEMS_EP_COPY_SAMPLE=true
APPROVED_RETURN_ITEMS_SAMPLE_MAX_50=true
APPROVED_PRODUCT_CREATE=false
APPROVED_MAP_INSERT=false
TARGET_SUPABASE_REF=${STAGING_REF}
\`\`\`

## Sign-off

\`\`\`
Approved by:
UTC date:
Notes:
\`\`\`
`;

  fs.writeFileSync(path.join(outDir, "approval-template.md"), approvalTemplate);

  const exactSamplePrompt = `# EXPECTED-LINKAGE-CLASS-A-AND-RETURN-ITEMS-BACKFILL-SAMPLE-EXECUTE

Owner: Main/user
Branch: feature/phase1-latest-stash-land
Mode: APPROVAL-GATED STAGING SAMPLE APPLY
Target: staging only (\`${STAGING_REF}\`)

Goal:
Apply the read-only plan at \`${OUT_BASE}/${runId}/\` in two isolated batches.

Precondition:
- Signed approval at \`.cursor/operator-approvals/expected-linkage-class-a-and-return-items-backfill-sample-approval.md\`
- Re-verify Class A rows still unresolved and map still resolves to exactly one product
- Re-verify sample 50 return_items still orphan-linked to EP-resolved rows

Plan A (max 2):
- UPDATE \`expected_packages.resolved_product_id\` from existing \`product_identifier_map\` for rows in \`class-a-rows.json\` only
- Set \`identifier_resolution_status = 'resolved'\`
- No map/product writes

Plan B (max 50):
- UPDATE \`return_items.resolved_product_id\` = linked \`expected_packages.resolved_product_id\`
- Only rows in \`sample-50-return-items.csv\`
- Set \`identifier_resolution_status = 'resolved'\`, \`identifier_resolution_confidence = 1.0\`
- Skip rows where EP unresolved or legacy \`product_id\` conflicts with EP target (blockers)

Verify:
1. Before/after counts for EP resolved + return_items resolved
2. Class A EP rows resolve in \`v_inventory_item_status\`
3. Sample 50 return_items now match EP product
4. No product count increase
5. Rollback from \`rollback-sample.sql\`

Output:
\`.cursor/audit-reports/expected-linkage-class-a-and-return-items-backfill-sample-execute/<execute_run_id>/\`
`;

  fs.writeFileSync(path.join(outDir, "exact-sample-apply-prompt.md"), exactSamplePrompt);

  const planReport = `# EXPECTED-LINKAGE-CLASS-A-AND-RETURN-ITEMS-BACKFILL-PLAN

Run: \`${runId}\`  
Mode: read-only plan + approval packet  
Evidence: \`${CENSUS_DIR}/\`  
Target: staging first (\`${STAGING_REF}\`)

# CLASS_A_ROWS

Both rows share FNSKU \`X003ZXVFXV\` / seller SKU \`LIT-TOR-VEN-051001\`. Existing \`product_identifier_map\` resolves unambiguously to product \`15c2b80e-c3d6-4799-aeba-718a10fccbbd\` but \`expected_packages.resolved_product_id\` was never persisted.

| EP id | Tracking | SKU | FNSKU | Map hits | Proposed \`resolved_product_id\` | Product |
|-------|----------|-----|-------|----------|----------------------------------|---------|
| \`f07b7f86-6b72-4e76-958c-2fe7654343cb\` | 2251839738 | LIT-TOR-VEN-051001 | X003ZXVFXV | 1 | \`15c2b80e-c3d6-4799-aeba-718a10fccbbd\` | ${classA[0]?.product_name ?? "—"} |
| \`b7715312-1c3e-4190-b881-1feac3450740\` | 387019251 | LIT-TOR-VEN-051001 | X003ZXVFXV | 1 | \`15c2b80e-c3d6-4799-aeba-718a10fccbbd\` | ${classA[1]?.product_name ?? "—"} |

**Apply (Plan A):** governed UPDATE \`expected_packages\` only — max **2** rows.  
**Not in scope:** Class C (320 staging EP rows need product seed).

Full JSON: \`class-a-rows.json\`

# RETURN_ITEM_ORPHAN_SUMMARY

Drift is **operational denormalization**, not a view/read-path issue: \`return_items.expected_item_id\` FK is valid and parent EP already has \`resolved_product_id\`, but child \`return_items.resolved_product_id\` was never copied.

| Metric | Count |
|--------|------:|
| Total orphans (EP resolved, return null) | ${orphan.total_orphans} |
| Copyable from EP (\`ep.resolved_product_id IS NOT NULL\`) | ${orphan.ep_resolved_copyable} |
| EP also unresolved (should be 0 in pool) | ${orphan.ep_also_unresolved} |
| Legacy \`return_items.product_id\` mismatches EP target | ${orphan.legacy_product_id_mismatch} |
| No legacy \`product_id\` | ${orphan.no_legacy_product_id} |
| Distinct EP parent rows | ${orphan.distinct_ep_rows} |
| Distinct target products | ${orphan.distinct_ep_products} |
| Created range | ${orphan.oldest_orphan_created_at} → ${orphan.newest_orphan_created_at} |

**By return resolution status:**

${orphanByStatus.rows.map((r: { return_status: string; row_count: number }) => `- \`${r.return_status}\`: ${r.row_count}`).join("\n")}

Census cross-check (\`${CENSUS_RUN_ID}\`): \`ep_resolved_return_not = ${censusOrphans}\` ✓

Full JSON: \`return-item-orphan-summary.json\`

# SAMPLE_50_RETURN_ITEMS

Deterministic sample: \`ORDER BY return_items.id LIMIT 50\` from orphan pool (${orphan.total_orphans} total).

- CSV: \`sample-50-return-items.csv\`
- JSON: \`sample-50-return-items.json\`

**Apply (Plan B):** copy \`expected_packages.resolved_product_id\` onto \`return_items.resolved_product_id\` for approved sample rows only — max **50** first.

# RISKS

| Risk | Mitigation |
|------|------------|
| Class A map ambiguity increases | Pre-apply gate: exactly one map product per EP; abort if >1 |
| EP target product deleted | FK + \`products\` existence check before UPDATE |
| Legacy \`return_items.product_id\` conflicts EP | Block sample rows where \`product_id IS DISTINCT FROM ep.resolved_product_id\`; report in execute blockers |
| Copying stale EP resolution | Plan B runs **after** Plan A; re-verify EP still resolved at execute time |
| Class C misclassified as copyable | Plan B requires \`ep.resolved_product_id IS NOT NULL\`; does not infer from identifiers |
| Over-broad apply | Separate approvals + row allowlists; sample max 50 before scale prompt |
| Product/map creation scope creep | Explicit forbidden flags; no Class C seed in either plan |

# APPROVAL_TEMPLATE

See \`approval-template.md\`.

# EXACT_SAMPLE_APPLY_PROMPT

See \`exact-sample-apply-prompt.md\`.

## Rollback (sample only)

\`rollback-sample.sql\` — restores preimage for 2 Class A EP rows + 50 return_items sample.

## Safe fix order (unchanged from census)

1. **Plan A** — Class A EP backfill (2 rows)  
2. **Plan B sample** — return_items EP-resolved copy (50 rows)  
3. Later scale prompt for remaining ~${Number(orphan.total_orphans) - 50} return orphans  
4. **Class C** — product seed wave (separate approval; not in this packet)
`;

  fs.writeFileSync(path.join(outDir, "plan-report.md"), planReport);

  const manifest = {
    prompt: "EXPECTED-LINKAGE-CLASS-A-AND-RETURN-ITEMS-BACKFILL-PLAN",
    run_id: runId,
    mode: "read-only",
    staging_ref: STAGING_REF,
    census_run_id: CENSUS_RUN_ID,
    class_a_rows: classAPlan.length,
    return_item_orphans: Number(orphan.total_orphans),
    sample_return_items: sampleRows.length,
    db_writes: false,
    artifacts: [
      "plan-report.md",
      "class-a-rows.json",
      "return-item-orphan-summary.json",
      "sample-50-return-items.csv",
      "sample-50-return-items.json",
      "approval-template.md",
      "exact-sample-apply-prompt.md",
      "rollback-sample.sql",
      "apply-sql-preview-sample.sql",
    ],
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
