/**
 * NEXT-PRODUCT-ID-22 — Safe_new execution (grain B: one product per org+store+ASIN).
 * Txn: INSERT 121 products + UPDATE 125 amazon_fba_inventory resolver fields.
 * Default: product_identifier_map deferred (no inserts).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const ELIGIBLE_CSV = path.join(
  REPO_ROOT,
  ".cursor/audit-reports/next-product-id-20/20260514T081033Z/safe-new-eligible-pks.csv",
);

function loadUrl() {
  const line = fs
    .readFileSync(path.join(REPO_ROOT, ".env.local"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("DIRECT_POSTGRES_URL="));
  return line.slice("DIRECT_POSTGRES_URL=".length).trim();
}

function runIdUtc() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function parseEligibleIds() {
  const lines = fs.readFileSync(ELIGIBLE_CSV, "utf8").trimEnd().split(/\r?\n/).slice(1);
  return lines.filter(Boolean).map((line) => {
    const m = line.match(/^([0-9a-f-]{36})/i);
    if (!m) throw new Error(`bad line ${line}`);
    return m[1];
  });
}

function escCsv(s) {
  if (s == null) return "";
  const t = String(s);
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function logLine(logs, o) {
  logs.push(JSON.stringify({ ts: new Date().toISOString(), ...o }));
}

async function main() {
  const runId = runIdUtc();
  const outDir = path.join(REPO_ROOT, ".cursor/audit-reports/next-product-id-22", runId);
  fs.mkdirSync(path.join(outDir, "logs"), { recursive: true });
  const logs = [];
  const batchId = crypto.randomUUID();
  logLine(logs, { event: "start", runId, batchId, auditPrompt: "NEXT-PRODUCT-ID-22" });

  const ids = parseEligibleIds();
  if (ids.length !== 125) throw new Error(`expected 125 eligible ids, got ${ids.length}`);

  const client = new pg.Client({ connectionString: loadUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();

  const { rows: preRows } = await client.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL AND identifier_resolution_status = 'resolved')::int AS resolved,
      COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved
    FROM public.amazon_fba_inventory
  `);
  const preTotal = preRows[0].total;
  const preResolved = preRows[0].resolved;
  const preUnresolved = preRows[0].unresolved;
  logLine(logs, { event: "pre_global_counts", preTotal, preResolved, preUnresolved });

  const { rows: afiRows } = await client.query(
    `SELECT id, organization_id, store_id, sku, fnsku, asin, product_name,
            resolved_product_id, resolved_catalog_product_id,
            identifier_resolution_status, identifier_resolution_confidence,
            source_upload_id, updated_at
     FROM public.amazon_fba_inventory
     WHERE id = ANY($1::uuid[])
     ORDER BY id`,
    [ids],
  );
  if (afiRows.length !== 125) throw new Error(`afi fetch ${afiRows.length} expected 125`);

  const preimageCsv =
    [
      "id,organization_id,store_id,sku,fnsku,asin,product_name,resolved_product_id,resolved_catalog_product_id,identifier_resolution_status,identifier_resolution_confidence,source_upload_id,updated_at",
    ]
      .concat(
        afiRows.map((r) =>
          [
            r.id,
            r.organization_id,
            r.store_id,
            r.sku,
            r.fnsku,
            r.asin,
            r.product_name,
            r.resolved_product_id,
            r.resolved_catalog_product_id,
            r.identifier_resolution_status,
            r.identifier_resolution_confidence,
            r.source_upload_id,
            r.updated_at,
          ]
            .map(escCsv)
            .join(","),
        ),
      )
      .join("\n") + "\n";
  fs.writeFileSync(path.join(outDir, "preimage-amazon-fba-125.csv"), preimageCsv, "utf8");

  for (const r of afiRows) {
    if (r.resolved_product_id != null) throw new Error(`row ${r.id} already resolved`);
    if (r.identifier_resolution_status === "resolved") throw new Error(`row ${r.id} bad status`);
  }

  const asinKey = (r) => {
    const a = String(r.asin ?? "").trim();
    if (!a) throw new Error(`missing asin for afi ${r.id}`);
    return `${r.organization_id}|${r.store_id}|${a.toUpperCase()}`;
  };
  const byAsin = new Map();
  for (const r of afiRows) {
    const k = asinKey(r);
    if (!byAsin.has(k)) byAsin.set(k, []);
    byAsin.get(k).push(r);
  }
  if (byAsin.size !== 121) throw new Error(`expected 121 ASIN groups, got ${byAsin.size}`);

  /** Canonical row: MIN(sku) within group */
  const productGroups = [];
  for (const [k, members] of byAsin) {
    members.sort((a, b) => String(a.sku).localeCompare(String(b.sku)));
    const rep = members[0];
    const newId = crypto.randomUUID();
    productGroups.push({
      asinKey: k,
      new_id: newId,
      organization_id: rep.organization_id,
      store_id: rep.store_id,
      sku: rep.sku,
      asin: rep.asin,
      fnsku: rep.fnsku,
      product_name:
        (rep.product_name && String(rep.product_name).trim()) ||
        String(rep.sku || "").trim() ||
        String(rep.asin || "").trim() ||
        "Unknown",
      source_upload_id: rep.source_upload_id,
      member_ids: members.map((m) => m.id),
    });
  }

  const resolveRows = [];
  for (const g of productGroups) {
    for (const mid of g.member_ids) {
      resolveRows.push({ afi_id: mid, new_product_id: g.new_id });
    }
  }
  if (resolveRows.length !== 125) throw new Error(`resolve rows ${resolveRows.length}`);

  const canonSkus = productGroups.map((g) => g.sku);
  const { rows: skuHit } = await client.query(
    `SELECT p.sku FROM public.products p
     WHERE p.organization_id = $1 AND p.store_id = $2
       AND p.sku = ANY($3::text[])
       AND p.deleted_at IS NULL`,
    [productGroups[0].organization_id, productGroups[0].store_id, canonSkus],
  );
  if (skuHit.length > 0) {
    logLine(logs, { event: "precheck_sku_collision", skus: skuHit.map((r) => r.sku) });
    throw new Error(`canonical SKU already exists in products: ${skuHit.map((r) => r.sku).join(",")}`);
  }

  const { rows: mapHit } = await client.query(
    `WITH cand AS (
       SELECT id, organization_id, store_id, sku, asin, fnsku
       FROM public.amazon_fba_inventory WHERE id = ANY($1::uuid[])
     )
     SELECT c.id
     FROM cand c
     WHERE EXISTS (
       SELECT 1 FROM public.product_identifier_map m
       WHERE m.organization_id = c.organization_id AND m.deleted_at IS NULL
         AND (m.store_id IS NULL OR m.store_id = c.store_id)
         AND (
           (c.sku IS NOT NULL AND btrim(c.sku) <> '' AND m.seller_sku IS NOT NULL AND m.seller_sku = c.sku)
           OR (c.asin IS NOT NULL AND btrim(c.asin) <> '' AND m.asin IS NOT NULL
               AND upper(btrim(m.asin)) = upper(btrim(c.asin)))
           OR (c.fnsku IS NOT NULL AND btrim(c.fnsku) <> '' AND m.fnsku IS NOT NULL
               AND upper(btrim(m.fnsku)) = upper(btrim(c.fnsku)))
         )
     ) LIMIT 5`,
    [ids],
  );
  if (mapHit.length > 0) throw new Error(`product_identifier_map hit on candidate ${mapHit[0].id}`);

  const groupExport =
    "asin_group_key,new_product_id,organization_id,store_id,canonical_sku,asin,fnsku,member_afi_ids\n" +
    productGroups
      .map((g) =>
        [
          g.asinKey,
          g.new_id,
          g.organization_id,
          g.store_id,
          g.sku,
          g.asin,
          g.fnsku,
          g.member_ids.join(";"),
        ]
          .map(escCsv)
          .join(","),
      )
      .join("\n") +
    "\n";
  fs.writeFileSync(path.join(outDir, "target-product-groups-121.csv"), groupExport, "utf8");

  let insertCount = 0;
  let updateCount = 0;

  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");

    await client.query(`
      CREATE TEMP TABLE safe_new_products_staging (
        new_id uuid NOT NULL PRIMARY KEY,
        organization_id uuid NOT NULL,
        store_id uuid NOT NULL,
        sku text NOT NULL,
        asin text,
        fnsku text,
        product_name text NOT NULL,
        source_upload_id uuid
      ) ON COMMIT DROP;
    `);
    for (const g of productGroups) {
      await client.query(
        `INSERT INTO safe_new_products_staging (new_id, organization_id, store_id, sku, asin, fnsku, product_name, source_upload_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text, $7::text, $8::uuid)`,
        [
          g.new_id,
          g.organization_id,
          g.store_id,
          g.sku,
          g.asin,
          g.fnsku,
          g.product_name,
          g.source_upload_id,
        ],
      );
    }

    const ins = await client.query(`
      INSERT INTO public.products (
        id, organization_id, store_id, sku, asin, fnsku, product_name,
        status, merge_status, metadata, amazon_raw,
        last_seen_at, last_catalog_sync_at, first_seen_at
      )
      SELECT
        s.new_id,
        s.organization_id,
        s.store_id,
        s.sku,
        s.asin,
        s.fnsku,
        s.product_name,
        'active',
        'active',
        jsonb_build_object(
          'safe_new_batch_id', $1::text,
          'audit_prompt', 'NEXT-PRODUCT-ID-22',
          'source_table', 'amazon_fba_inventory',
          'grain', 'one_product_per_org_store_asin'
        ),
        jsonb_build_object(
          'seller_sku', s.sku,
          'asin', s.asin,
          'fnsku', s.fnsku,
          'source_upload_id', s.source_upload_id
        ),
        now(), now(), now()
      FROM safe_new_products_staging s
    `, [batchId]);
    insertCount = ins.rowCount;
    logLine(logs, { event: "insert_products", rowCount: insertCount });
    if (insertCount !== 121) {
      await client.query("ROLLBACK");
      throw new Error(`ROLLBACK: insert count ${insertCount} expected 121`);
    }

    await client.query(`
      CREATE TEMP TABLE safe_new_resolve_staging (
        afi_id uuid NOT NULL PRIMARY KEY,
        new_product_id uuid NOT NULL
      ) ON COMMIT DROP;
    `);
    for (const r of resolveRows) {
      await client.query(
        `INSERT INTO safe_new_resolve_staging (afi_id, new_product_id) VALUES ($1::uuid, $2::uuid)`,
        [r.afi_id, r.new_product_id],
      );
    }

    const upd = await client.query(`
      UPDATE public.amazon_fba_inventory AS afi
      SET
        resolved_product_id = s.new_product_id,
        resolved_catalog_product_id = NULL,
        identifier_resolution_status = 'resolved',
        identifier_resolution_confidence = 0.95::numeric(10,4),
        updated_at = now()
      FROM safe_new_resolve_staging AS s
      WHERE afi.id = s.afi_id
        AND afi.id = ANY($1::uuid[])
        AND afi.resolved_product_id IS NULL
    `, [ids]);
    updateCount = upd.rowCount;
    logLine(logs, { event: "update_resolver", rowCount: updateCount });
    if (updateCount !== 125) {
      await client.query("ROLLBACK");
      throw new Error(`ROLLBACK: update count ${updateCount} expected 125`);
    }

    const { rows: postRows } = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL AND identifier_resolution_status = 'resolved')::int AS resolved,
        COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved
      FROM public.amazon_fba_inventory
    `);
    const postResolved = postRows[0].resolved;
    const postUnresolved = postRows[0].unresolved;
    if (postResolved !== 907 || postUnresolved !== 42) {
      await client.query("ROLLBACK");
      throw new Error(`ROLLBACK: post counts resolved=${postResolved} unresolved=${postUnresolved}`);
    }

    const { rows: scopeRows } = await client.query(
      `SELECT COUNT(*)::int AS c FROM public.amazon_fba_inventory
       WHERE id = ANY($1::uuid[]) AND resolved_product_id IS NULL`,
      [ids],
    );
    if (scopeRows[0].c !== 0) {
      await client.query("ROLLBACK");
      throw new Error("ROLLBACK: safe_new ids still unresolved");
    }

    const { rows: newProdCount } = await client.query(
      `SELECT COUNT(*)::int AS c FROM public.products
       WHERE metadata->>'safe_new_batch_id' = $1`,
      [batchId],
    );
    if (newProdCount[0].c !== 121) {
      await client.query("ROLLBACK");
      throw new Error(`ROLLBACK: new products by batch ${newProdCount[0].c}`);
    }

    await client.query("COMMIT");
    logLine(logs, { event: "commit", postResolved, postUnresolved });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* */
    }
    logLine(logs, { event: "error", message: String(e.message || e) });
    fs.writeFileSync(path.join(outDir, "logs", "product-id-22.ndjson"), logs.join("\n") + "\n");
    await client.end();
    throw e;
  }

  await client.end();

  const manifest = {
    auditPrompt: "NEXT-PRODUCT-ID-22",
    runId,
    batchId,
    grain: "one_product_per_org_store_asin",
    productInsertCount: insertCount,
    resolverUpdateCount: updateCount,
    postGlobal: { resolvedStrict: 907, unresolved: 42 },
    preGlobal: { resolvedStrict: preResolved, unresolved: preUnresolved },
    productIdentifierMap: { strategy: "deferred", rowsInserted: 0 },
    validation: {
      noMigrations: true,
      noAmazonApi: true,
      noOpenAi: true,
      countsVerified: true,
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  fs.writeFileSync(
    path.join(outDir, "execution-summary.md"),
    `# Execution summary — NEXT-PRODUCT-ID-22

**Run ID:** \`${runId}\`  
**Batch ID (metadata):** \`${batchId}\`

## Grain

One \`products\` row per \`(organization_id, store_id, ASIN)\` — **121** inserts.

## Results

| Step | Count |
|------|------:|
| \`INSERT INTO products\` | **${insertCount}** |
| \`UPDATE amazon_fba_inventory\` (scoped to 125 PKs) | **${updateCount}** |
| \`product_identifier_map\` | **0** (deferred) |

## Global totals (post)

- Resolved (product NOT NULL + status \`resolved\`): **907**
- Unresolved (product NULL): **42**

## Artifacts

- \`preimage-amazon-fba-125.csv\` — state before mutation
- \`target-product-groups-121.csv\` — ASIN groups → new \`products.id\`
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "product-create-count-check.md"),
    `# Product create count check

| Expected | Actual |
|----------|-------:|
| 121 | **${insertCount}** |

Verified via \`INSERT\` rowCount and post-hoc \`COUNT(*)\` where \`metadata->>'safe_new_batch_id'\` = batch id.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "resolver-writeback-check.md"),
    `# Resolver writeback check

| Expected | Actual |
|----------|-------:|
| 125 | **${updateCount}** |

Predicate: \`id = ANY(safe_new 125 UUIDs)\` AND \`resolved_product_id IS NULL\`.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "post-update-verification.md"),
    `# Post-update verification

| Metric | Expected | Actual |
|--------|----------|--------|
| Global resolved (strict) | 907 | **907** |
| Global unresolved | 42 | **42** |
| Safe-new PKs still null product | 0 | **0** (enforced in txn) |
| New products tagged with batch | 121 | **121** |
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "rollback-readiness.md"),
    `# Rollback readiness

- Single transaction: failed asserts triggered **ROLLBACK** (no partial apply).
- **Forward rollback:** delete \`products\` where \`metadata->>'safe_new_batch_id' = '${batchId}'\` and re-null resolver fields on the 125 PKs using \`preimage-amazon-fba-125.csv\` (operator-run, separate prompt if needed).
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "deferred-map-status.md"),
    `# Deferred \`product_identifier_map\` status

- **Strategy:** deferred (signoff form had no explicit “immediate” selection).
- **Rows inserted this run:** **0**
- **Next:** follow-up job / NEXT-PRODUCT-ID-23 style prompt for governed map backfill keyed by \`safe_new_batch_id\`.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "next-step-recommendation.md"),
    `# Next-step recommendation

1. **Optional:** \`product_identifier_map\` backfill for batch \`${batchId}\` (scoped, idempotent).
2. **Continue Lane B:** conflict pack for remaining **42** unresolved \`amazon_fba_inventory\` rows (ambiguous bucket).
3. **Monitor:** imports / \`resolveAmazon\` paths pick up new products via existing identifiers on FBA rows.

> **NEXT-PRODUCT-ID-23** — Governed \`product_identifier_map\` inserts for \`safe_new_batch_id=${batchId}\` (read-check, no broad scan, transactional).
`,
    "utf8",
  );

  logLine(logs, { event: "complete", outDir: path.relative(REPO_ROOT, outDir) });
  fs.writeFileSync(path.join(outDir, "logs", "product-id-22.ndjson"), logs.join("\n") + "\n", "utf8");

  console.log(outDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
