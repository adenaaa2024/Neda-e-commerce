/**
 * NEXT-PRODUCT-ID-23 — Governed product_identifier_map backfill for safe_new batch.
 * No product INSERT, no FBA UPDATE, no deletes. Scoped to batch_id in products.metadata.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const BATCH_ID = "5cc06e24-b742-4945-a330-c0e991b325a0";

function loadUrl() {
  return fs
    .readFileSync(path.join(REPO_ROOT, ".env.local"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("DIRECT_POSTGRES_URL="))
    .slice("DIRECT_POSTGRES_URL=".length)
    .trim();
}

function runIdUtc() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function escCsv(v) {
  if (v == null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function logLine(logs, o) {
  logs.push(JSON.stringify({ ts: new Date().toISOString(), ...o }));
}

async function main() {
  const runId = runIdUtc();
  const outDir = path.join(REPO_ROOT, ".cursor/audit-reports/next-product-id-23", runId);
  fs.mkdirSync(path.join(outDir, "logs"), { recursive: true });
  const logs = [];
  logLine(logs, { event: "start", runId, batchId: BATCH_ID });

  const client = new pg.Client({ connectionString: loadUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();

  const { rows: pc } = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.products
     WHERE metadata->>'safe_new_batch_id' = $1 AND deleted_at IS NULL`,
    [BATCH_ID],
  );
  const productCount = pc[0].c;

  const { rows: fc } = await client.query(
    `SELECT COUNT(*)::int AS c
     FROM public.amazon_fba_inventory afi
     INNER JOIN public.products p ON p.id = afi.resolved_product_id
     WHERE p.metadata->>'safe_new_batch_id' = $1
       AND afi.identifier_resolution_status = 'resolved'
       AND afi.resolved_product_id IS NOT NULL`,
    [BATCH_ID],
  );
  const fbaLinkedCount = fc[0].c;

  const unresolvedNonBatch = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.amazon_fba_inventory WHERE resolved_product_id IS NULL`,
  );

  const { rows: planRows } = await client.query(
    `SELECT
       afi.id AS afi_id,
       afi.organization_id,
       afi.store_id,
       afi.sku AS seller_sku,
       afi.asin,
       afi.fnsku,
       afi.source_upload_id,
       afi.resolved_product_id AS product_id
     FROM public.amazon_fba_inventory afi
     INNER JOIN public.products p ON p.id = afi.resolved_product_id
     WHERE p.metadata->>'safe_new_batch_id' = $1
       AND afi.resolved_product_id IS NOT NULL
       AND btrim(COALESCE(afi.sku, '')) <> ''
     ORDER BY afi.id`,
    [BATCH_ID],
  );

  const conflicts = [];
  const skips = [];

  const skipIds = new Set();
  for (const row of planRows) {
    const { rows: ex } = await client.query(
      `SELECT id, product_id
       FROM public.product_identifier_map
       WHERE organization_id = $1
         AND store_id IS NOT DISTINCT FROM $2
         AND seller_sku = $3
         AND deleted_at IS NULL
       LIMIT 2`,
      [row.organization_id, row.store_id, row.seller_sku],
    );
    if (ex.length === 0) continue;
    for (const e of ex) {
      if (e.product_id === row.product_id) {
        if (!skipIds.has(row.afi_id)) {
          skipIds.add(row.afi_id);
          skips.push({ ...row, existing_map_id: e.id, reason: "identical_sku_map" });
        }
      } else {
        conflicts.push({ ...row, existing_map_id: e.id, existing_product_id: e.product_id });
      }
    }
  }

  /** Composite unique: same org+store+sku+asin+fnsku+external_listing_id */
  const { rows: dupComposite } = await client.query(
    `SELECT m.id, m.product_id, p.seller_sku, p.asin, p.fnsku
     FROM public.product_identifier_map m
     INNER JOIN (
       SELECT organization_id, store_id, seller_sku, asin, fnsku, product_id
       FROM (
         SELECT afi.organization_id, afi.store_id, afi.sku AS seller_sku, afi.asin, afi.fnsku, afi.resolved_product_id AS product_id
         FROM public.amazon_fba_inventory afi
         INNER JOIN public.products pr ON pr.id = afi.resolved_product_id
         WHERE pr.metadata->>'safe_new_batch_id' = $1
       ) x
     ) p ON m.organization_id = p.organization_id
       AND m.store_id IS NOT DISTINCT FROM p.store_id
       AND COALESCE(m.seller_sku, '') = COALESCE(p.seller_sku, '')
       AND COALESCE(m.asin, '') = COALESCE(p.asin, '')
       AND COALESCE(m.fnsku, '') = COALESCE(p.fnsku, '')
       AND COALESCE(m.external_listing_id, '') = ''
       AND m.deleted_at IS NULL
       AND (m.product_id IS DISTINCT FROM p.product_id)`,
    [BATCH_ID],
  );

  const planCsvLines = [
    "afi_id,organization_id,store_id,seller_sku,asin,fnsku,product_id,source_upload_id,action",
  ];
  for (const row of planRows) {
    const hasConflict = conflicts.some((c) => c.afi_id === row.afi_id);
    const hasSkip = skips.some((s) => s.afi_id === row.afi_id);
    const action = hasConflict ? "CONFLICT" : hasSkip ? "SKIP_IDENTICAL" : "INSERT";
    planCsvLines.push(
      [
        row.afi_id,
        row.organization_id,
        row.store_id,
        row.seller_sku,
        row.asin,
        row.fnsku,
        row.product_id,
        row.source_upload_id,
        action,
      ]
        .map(escCsv)
        .join(","),
    );
  }
  fs.writeFileSync(path.join(outDir, "identifier-map-insert-plan.csv"), planCsvLines.join("\n") + "\n", "utf8");

  const preGlobal = await client.query(`
    SELECT
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL AND identifier_resolution_status = 'resolved')::int AS resolved,
      COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved
    FROM public.amazon_fba_inventory
  `);

  fs.writeFileSync(
    path.join(outDir, "precheck-results.md"),
    `# Precheck results

| Check | Expected | Actual |
|-------|----------|--------|
| Products with \`safe_new_batch_id\` | 121 | **${productCount}** |
| FBA rows resolved to those products | 125 | **${fbaLinkedCount}** |
| Global unresolved (ambiguous pool) | 42 | **${unresolvedNonBatch.rows[0].c}** |
| Plan rows (non-empty seller_sku) | 125 | **${planRows.length}** |
| Conflicts (existing map, different product) | 0 | **${conflicts.length}** |
| Skip identical (same product_id) | — | **${skips.length}** |
| Composite key collision (different product) | 0 | **${dupComposite.length}** |

${dupComposite.length ? `**Composite collisions:** ${JSON.stringify(dupComposite)}` : ""}
`,
    "utf8",
  );

  const precheckPass =
    productCount === 121 &&
    fbaLinkedCount === 125 &&
    planRows.length === 125 &&
    unresolvedNonBatch.rows[0].c === 42 &&
    conflicts.length === 0 &&
    dupComposite.length === 0;

  let inserted = 0;
  let skipped = skips.length;

  if (!precheckPass) {
    logLine(logs, { event: "precheck_fail", productCount, fbaLinkedCount, conflicts: conflicts.length });
    fs.writeFileSync(path.join(outDir, "logs", "product-id-23.ndjson"), logs.join("\n") + "\n");
    const manifest = {
      auditPrompt: "NEXT-PRODUCT-ID-23",
      runId,
      batchId: BATCH_ID,
      precheckPass: false,
      productCount,
      fbaLinkedCount,
      mapRowsInserted: 0,
      skippedIdentical: skipped,
      conflictsFound: conflicts.length,
      validation: { noProductCreates: true, noFbaUpdates: true, noMigrations: true, noApi: true },
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    await client.end();
    throw new Error("Precheck failed — no map inserts executed");
  }

  try {
    await client.query("BEGIN");

    for (const row of planRows) {
      const skip = skips.find((s) => s.afi_id === row.afi_id);
      if (skip) continue;

      const ins = await client.query(
        `INSERT INTO public.product_identifier_map (
           organization_id, product_id, store_id, seller_sku, asin, fnsku,
           source_upload_id, match_source, confidence_score,
           source_report_type, linked_from_target_table, resolution_notes,
           is_primary, first_seen_at, last_seen_at, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, 'safe_new_batch_backfill', 0.95,
           'amazon_fba_inventory_health', 'amazon_fba_inventory', $8,
           true, now(), now(), now(), now()
         )
         ON CONFLICT (organization_id, store_id, seller_sku)
         WHERE seller_sku IS NOT NULL AND deleted_at IS NULL
         DO UPDATE SET
           updated_at = now(),
           product_id = EXCLUDED.product_id,
           asin = EXCLUDED.asin,
           fnsku = EXCLUDED.fnsku,
           match_source = EXCLUDED.match_source
         WHERE product_identifier_map.product_id IS NOT DISTINCT FROM EXCLUDED.product_id
         RETURNING id`,
        [
          row.organization_id,
          row.product_id,
          row.store_id,
          row.seller_sku,
          row.asin,
          row.fnsku,
          row.source_upload_id,
          `NEXT-PRODUCT-ID-23 batch=${BATCH_ID} afi=${row.afi_id}`,
        ],
      );
      if (ins.rowCount === 1) inserted++;
      else skipped++;
    }

    const postGlobal = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL AND identifier_resolution_status = 'resolved')::int AS resolved,
        COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved
      FROM public.amazon_fba_inventory
    `);

    if (
      postGlobal.rows[0].resolved !== preGlobal.rows[0].resolved ||
      postGlobal.rows[0].unresolved !== preGlobal.rows[0].unresolved
    ) {
      await client.query("ROLLBACK");
      throw new Error(
        `FBA counts changed resolved ${postGlobal.rows[0].resolved} vs ${preGlobal.rows[0].resolved}`,
      );
    }

    const { rows: mapForBatch } = await client.query(
      `SELECT COUNT(*)::int AS c FROM public.product_identifier_map m
       INNER JOIN public.products p ON p.id = m.product_id
       WHERE p.metadata->>'safe_new_batch_id' = $1 AND m.deleted_at IS NULL AND m.match_source = 'safe_new_batch_backfill'`,
      [BATCH_ID],
    );

    if (mapForBatch[0].c !== inserted) {
      await client.query("ROLLBACK");
      throw new Error(`map count mismatch ${mapForBatch[0].c} vs inserted ${inserted}`);
    }

    await client.query("COMMIT");
    logLine(logs, { event: "commit", inserted, skipped });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* */
    }
    logLine(logs, { event: "rollback", message: String(e.message || e) });
    fs.writeFileSync(path.join(outDir, "logs", "product-id-23.ndjson"), logs.join("\n") + "\n");
    await client.end();
    throw e;
  }

  await client.end();

  const manifest = {
    auditPrompt: "NEXT-PRODUCT-ID-23",
    runId,
    batchId: BATCH_ID,
    productsInBatch: productCount,
    fbaRowsInBatch: fbaLinkedCount,
    mapRowsInserted: inserted,
    skippedIdentical: skipped,
    conflictsFound: conflicts.length,
    precheckPass: true,
    validation: {
      noProductCreates: true,
      noFbaUpdates: true,
      noMigrations: true,
      noAmazonApi: true,
      noOpenAi: true,
      mapWritesScopedToBatch: true,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  fs.writeFileSync(
    path.join(outDir, "map-backfill-summary.md"),
    `# Map backfill summary — NEXT-PRODUCT-ID-23

**Run ID:** \`${runId}\`  
**Batch:** \`${BATCH_ID}\`

| Metric | Value |
|--------|------:|
| Products in batch | ${productCount} |
| FBA rows linked | ${fbaLinkedCount} |
| \`product_identifier_map\` rows inserted (this run) | **${inserted}** |
| Skipped (identical pre-existing / no-op conflict clause) | **${skipped}** |
| Conflicts (blocked before insert) | **${conflicts.length}** |
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "map-insert-count-check.md"),
    `# Map insert count check

- Planned inserts (new): **${planRows.length - skips.length}** max  
- Actual inserts / upsert returning: **${inserted}**  
- Expected final backfill rows with \`match_source = safe_new_batch_backfill\`: **${inserted}** (post-verify query in DB)
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "conflict-and-skip-report.md"),
    `# Conflict and skip report

## Skips (pre-existing map, same product_id)

Count: **${skips.length}**

${skips.length ? skips.slice(0, 20).map((s) => `- afi ${s.afi_id} → map ${s.existing_map_id}`).join("\n") : "_None_"}

## Conflicts (would map seller_sku to different product)

Count: **${conflicts.length}**

${conflicts.length ? JSON.stringify(conflicts, null, 2) : "_None_"}
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "post-map-verification.md"),
    `# Post-map verification

| Check | Result |
|-------|--------|
| \`amazon_fba_inventory\` resolved count unchanged | **${preGlobal.rows[0].resolved}** |
| Unresolved unchanged | **${preGlobal.rows[0].unresolved}** |
| No new \`products\` rows in this prompt | yes |
| No \`amazon_fba_inventory\` \`UPDATE\` in this prompt | yes |
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "rollback-readiness.md"),
    `# Rollback readiness

- Rows inserted carry \`match_source = 'safe_new_batch_backfill'\` and \`resolution_notes\` containing batch + \`afi_id\`.
- Rollback: \`DELETE FROM product_identifier_map WHERE match_source = 'safe_new_batch_backfill' AND resolution_notes LIKE '%batch=${BATCH_ID}%'\` (operator review before run).
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "next-step-recommendation.md"),
    `# Next-step recommendation

1. Re-run **product-seed dry-run** on \`amazon_fba_inventory\` — former safe_new lines should classify as **bucket 1 / existing** where map hits align.
2. **NEXT-PRODUCT-ID-24** — Ambiguous / conflict **42** row review pack (read-only classification + owner triage CSV).
3. Optional: extend map backfill to **FNSKU-only** secondary rows if resolver needs them (separate prompt — watch \`uq_product_identifier_map_org_store_ids\`).
`,
    "utf8",
  );

  logLine(logs, { event: "complete", inserted, skipped });
  fs.writeFileSync(path.join(outDir, "logs", "product-id-23.ndjson"), logs.join("\n") + "\n", "utf8");

  console.log(outDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
