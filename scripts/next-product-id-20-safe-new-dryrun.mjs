/**
 * NEXT-PRODUCT-ID-20 — Safe-new dry-run pack (read-only).
 * No INSERT/UPDATE, no product creation, no APIs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const INPUT_19 = path.join(
  REPO_ROOT,
  ".cursor/audit-reports/next-product-id-19/20260514T075134Z/remaining-safe-new-candidates.csv",
);
const NDJSON_19 = path.join(
  REPO_ROOT,
  ".cursor/audit-reports/next-product-id-19/20260514T075134Z/live-dry-run/20260514T075136Z/01-rows.ndjson",
);

function loadDirectPostgresUrl() {
  const p = path.join(REPO_ROOT, ".env.local");
  const line = fs.readFileSync(p, "utf8").split(/\r?\n/).find((l) => l.startsWith("DIRECT_POSTGRES_URL="));
  if (!line) throw new Error("DIRECT_POSTGRES_URL missing");
  return line.slice("DIRECT_POSTGRES_URL=".length).trim();
}

function runIdUtc() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function escCsv(s) {
  if (s == null || s === undefined) return "";
  const t = String(s);
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function parseIdsFromSafeNewCsv() {
  const lines = fs.readFileSync(INPUT_19, "utf8").trimEnd().split(/\r?\n/);
  const ids = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = line.match(/^([0-9a-f-]{36})/i);
    if (!m) throw new Error(`Bad line ${i + 1}: ${line.slice(0, 80)}`);
    ids.push(m[1]);
  }
  return ids;
}

function loadNdjsonBucketById() {
  const text = fs.readFileSync(NDJSON_19, "utf8");
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.source_table === "amazon_fba_inventory") map.set(o.source_row_id, o);
  }
  return map;
}

function norm(s) {
  return (s ?? "").trim().toUpperCase();
}

function idSetKey(org, store, sku, asin, fnsku) {
  return `${org}|${store}|${norm(sku)}|${norm(asin)}|${norm(fnsku)}`;
}

async function main() {
  const runId = runIdUtc();
  const outDir = path.join(REPO_ROOT, ".cursor/audit-reports/next-product-id-20", runId);
  fs.mkdirSync(path.join(outDir, "logs"), { recursive: true });
  const logs = [];
  const log = (event, data = {}) => {
    logs.push(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
  };

  log("start", { runId });

  const ids = parseIdsFromSafeNewCsv();
  if (ids.length !== 125) throw new Error(`expected 125 CSV ids, got ${ids.length}`);
  log("csv_ids", { count: 125 });

  const ndjsonById = loadNdjsonBucketById();
  let ndjsonMismatch = 0;
  const ndjsonMismatchIds = [];
  for (const id of ids) {
    const o = ndjsonById.get(id);
    if (!o || o.bucket_id !== 4 || o.primary_reason !== "passes_section_e_gates") {
      ndjsonMismatch++;
      ndjsonMismatchIds.push(id);
    }
  }
  log("ndjson_crosscheck", { ndjsonMismatch, sample: ndjsonMismatchIds.slice(0, 5) });

  const client = new pg.Client({ connectionString: loadDirectPostgresUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  log("pg_connected");

  const { rows: afiRows } = await client.query(
    `SELECT id, organization_id, store_id, sku, fnsku, asin, product_name,
            resolved_product_id, resolved_catalog_product_id,
            identifier_resolution_status, identifier_resolution_confidence,
            source_upload_id, updated_at
     FROM public.amazon_fba_inventory
     WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  if (afiRows.length !== 125) throw new Error(`DB returned ${afiRows.length} rows for 125 ids`);

  let notNullResolved = 0;
  let badStatusResolvedWithoutProduct = 0;
  let orgStoreFail = 0;
  let idMissingIdentifiers = 0;
  const shapeAnomalies = [];

  for (const r of afiRows) {
    if (r.resolved_product_id != null) notNullResolved++;
    if (r.resolved_product_id == null && r.identifier_resolution_status === "resolved") {
      badStatusResolvedWithoutProduct++;
    }
    if (!r.organization_id || !r.store_id) orgStoreFail++;
    if (!r.sku?.trim() && !r.asin?.trim() && !r.fnsku?.trim()) idMissingIdentifiers++;
    const skuL = (r.sku ?? "").toLowerCase();
    if (skuL.includes(".missing") || skuL.includes("#error") || skuL.includes("error#")) {
      shapeAnomalies.push({ id: r.id, sku: r.sku, note: "sku_token_anomaly" });
    }
  }

  const { rows: hitRows } = await client.query(
    `WITH cand AS (
       SELECT id, organization_id, store_id, sku, asin, fnsku
       FROM public.amazon_fba_inventory
       WHERE id = ANY($1::uuid[])
     )
     SELECT c.id,
       EXISTS (
         SELECT 1 FROM public.product_identifier_map m
         WHERE m.organization_id = c.organization_id
           AND m.deleted_at IS NULL
           AND (m.store_id IS NULL OR m.store_id = c.store_id)
           AND (
             (c.sku IS NOT NULL AND btrim(c.sku) <> '' AND m.seller_sku IS NOT NULL AND m.seller_sku = c.sku)
             OR (c.asin IS NOT NULL AND btrim(c.asin) <> '' AND m.asin IS NOT NULL
                 AND upper(btrim(m.asin)) = upper(btrim(c.asin)))
             OR (c.fnsku IS NOT NULL AND btrim(c.fnsku) <> '' AND m.fnsku IS NOT NULL
                 AND upper(btrim(m.fnsku)) = upper(btrim(c.fnsku)))
           )
       ) AS map_hit,
       EXISTS (
         SELECT 1 FROM public.products p
         WHERE p.organization_id = c.organization_id
           AND p.store_id IS NOT DISTINCT FROM c.store_id
           AND p.sku IS NOT NULL AND p.sku = c.sku
           AND p.deleted_at IS NULL
           AND (p.merge_status IS DISTINCT FROM 'merged')
       ) AS product_sku_collision
     FROM cand c`,
    [ids],
  );

  const mapHits = hitRows.filter((h) => h.map_hit).length;
  const skuCollisions = hitRows.filter((h) => h.product_sku_collision).length;
  const mapHitIds = hitRows.filter((h) => h.map_hit).map((h) => h.id);
  const collisionIds = hitRows.filter((h) => h.product_sku_collision).map((h) => h.id);

  const { rows: uploadRows } = await client.query(
    `SELECT c.id,
       (c.source_upload_id IS NOT NULL AND r.id IS NULL) AS upload_missing
     FROM public.amazon_fba_inventory c
     LEFT JOIN public.raw_report_uploads r ON r.id = c.source_upload_id
     WHERE c.id = ANY($1::uuid[])`,
    [ids],
  );
  const uploadMissing = uploadRows.filter((u) => u.upload_missing).length;

  await client.end();
  log("pg_complete", { mapHits, skuCollisions, uploadMissing, notNullResolved, badStatusResolvedWithoutProduct, orgStoreFail });

  const bySku = new Map();
  const byAsin = new Map();
  const byFnsku = new Map();
  const byTriple = new Map();
  for (const r of afiRows) {
    const skuK = norm(r.sku) || "(empty)";
    const asinK = norm(r.asin) || "(empty)";
    const fnK = norm(r.fnsku) || "(empty)";
    const tk = idSetKey(r.organization_id, r.store_id, r.sku, r.asin, r.fnsku);
    for (const [m, k] of [
      [bySku, skuK],
      [byAsin, asinK],
      [byFnsku, fnK],
      [byTriple, tk],
    ]) {
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r.id);
    }
  }

  const countMulti = (m) => [...m.values()].filter((arr) => arr.length > 1).length;
  const multiSku = countMulti(bySku);
  const multiAsin = countMulti(byAsin);
  const multiFnsku = countMulti(byFnsku);
  const multiTriple = countMulti(byTriple);

  const uniqueSkus = bySku.size;
  const uniqueAsins = byAsin.size;
  const uniqueFnskus = byFnsku.size;
  const uniqueTriples = byTriple.size;

  /** ASIN-level product groups: one new product per distinct ASIN within org+store (proposal A). */
  const byAsinOrgStore = new Map();
  for (const r of afiRows) {
    const k = `${r.organization_id}|${r.store_id}|${norm(r.asin)}`;
    if (!byAsinOrgStore.has(k)) byAsinOrgStore.set(k, []);
    byAsinOrgStore.get(k).push(r.id);
  }
  const estimatedProductsByAsin = byAsinOrgStore.size;

  const badIdSet = new Set([
    ...ndjsonMismatchIds,
    ...afiRows.filter((r) => r.resolved_product_id != null).map((r) => r.id),
    ...afiRows.filter((r) => r.resolved_product_id == null && r.identifier_resolution_status === "resolved").map((r) => r.id),
    ...mapHitIds,
    ...collisionIds,
    ...uploadRows.filter((u) => u.upload_missing).map((u) => u.id),
    ...afiRows.filter((r) => !r.organization_id || !r.store_id).map((r) => r.id),
    ...afiRows.filter((r) => !r.sku?.trim() && !r.asin?.trim() && !r.fnsku?.trim()).map((r) => r.id),
  ]);
  const safeNewValidatedCount = ids.filter((id) => !badIdSet.has(id)).length;

  const downgradeCount = badIdSet.size;

  const integrityPass =
    ndjsonMismatch === 0 &&
    notNullResolved === 0 &&
    badStatusResolvedWithoutProduct === 0 &&
    mapHits === 0 &&
    skuCollisions === 0 &&
    orgStoreFail === 0 &&
    idMissingIdentifiers === 0;

  const preimageHdr = [
    "id",
    "organization_id",
    "store_id",
    "sku",
    "fnsku",
    "asin",
    "product_name",
    "resolved_product_id",
    "resolved_catalog_product_id",
    "identifier_resolution_status",
    "identifier_resolution_confidence",
    "source_upload_id",
    "updated_at",
  ];
  const preimageLines = afiRows
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((r) =>
      preimageHdr
        .map((h) => escCsv(r[h]))
        .join(","),
    );
  fs.writeFileSync(
    path.join(outDir, "safe-new-preimage-export.csv"),
    preimageHdr.join(",") + "\n" + preimageLines.join("\n") + "\n",
    "utf8",
  );

  const eligHdr = "source_row_id,organization_id,store_id,bucket_id,match_rank,wave";
  const eligLines = afiRows.map((r) =>
    [r.id, r.organization_id, r.store_id, 4, 4, "safe_new_dryrun"].map(escCsv).join(","),
  );
  fs.writeFileSync(path.join(outDir, "safe-new-eligible-pks.csv"), eligHdr + "\n" + eligLines.join("\n") + "\n", "utf8");

  const manifest = {
    auditPrompt: "NEXT-PRODUCT-ID-20",
    runId,
    inputs: {
      nextProductId19: ".cursor/audit-reports/next-product-id-19/20260514T075134Z/",
      nextProductId17c: ".cursor/audit-reports/next-product-id-17c/20260514T054938Z/",
      nextProductId15: ".cursor/audit-reports/next-product-id-15/20260514T014702Z/",
    },
    safeNewValidatedCount,
    counts: {
      csvCandidateRows: 125,
      dbRowsMatched: afiRows.length,
      ndjsonBucket4Match: 125 - ndjsonMismatch,
      resolvedProductNullRows: 125 - notNullResolved,
      notNullResolvedViolations: notNullResolved,
      statusResolvedWithoutProduct: badStatusResolvedWithoutProduct,
      productIdentifierMapHits: mapHits,
      productsSkuCollisions: skuCollisions,
      uploadProvenanceMissingRows: uploadMissing,
      orgStorePresent: 125 - orgStoreFail,
      rowsWithNoSkuAsinFnsku: idMissingIdentifiers,
    },
    grouping: {
      uniqueSellerSkus: uniqueSkus,
      uniqueAsins: uniqueAsins,
      uniqueFnskus: uniqueFnskus,
      uniqueNormalizedTriplets: uniqueTriples,
      duplicateSkuGroups: multiSku,
      duplicateAsinGroups: multiAsin,
      duplicateFnskuGroups: multiFnsku,
      duplicateTripletGroups: multiTriple,
      estimatedNewProductsIfOnePerAsinOrgStore: estimatedProductsByAsin,
      estimatedNewProductsIfOnePerSourceRow: 125,
    },
    downgrade: {
      distinctRowsFlagged: downgradeCount,
      ndjsonMismatchIds: ndjsonMismatchIds.slice(0, 20),
      mapHitIds: mapHitIds.slice(0, 20),
      productSkuCollisionIds: collisionIds.slice(0, 20),
      shapeAnomalyCount: shapeAnomalies.length,
    },
    validation: {
      noDbWrites: true,
      noProductCreates: true,
      noProductIdentifierMapMutation: true,
      noMigrations: true,
      noAmazonApi: true,
      noOpenAi: true,
      integrityPass,
      creationReadyPendingSignoff: integrityPass && uploadMissing === 0,
    },
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  fs.writeFileSync(
    path.join(outDir, "safe-new-validation-summary.md"),
    `# Safe-new validation summary — NEXT-PRODUCT-ID-20

**Run ID:** \`${runId}\`

## Inputs

- \`${path.relative(REPO_ROOT, INPUT_19).replace(/\\/g, "/")}\` (125 PKs)
- Cross-check: NEXT-PRODUCT-ID-19 dry-run NDJSON bucket 4 / \`passes_section_e_gates\`

## Results

| Check | Result |
|-------|--------|
| CSV PK count | 125 |
| Rows found in \`amazon_fba_inventory\` | **${afiRows.length}** |
| NDJSON still bucket 4 + section E | **${125 - ndjsonMismatch}** / 125 |
| \`resolved_product_id\` NULL (all) | **${125 - notNullResolved}** / 125 |
| Status \`resolved\` with NULL product (bad pairing) | **${badStatusResolvedWithoutProduct}** |
| \`product_identifier_map\` hit (org/store scoped) | **${mapHits}** (want 0) |
| \`products\` SKU collision (same org+store+sku, not merged) | **${skuCollisions}** (want 0) |
| \`organization_id\` / \`store_id\` present | **${125 - orgStoreFail}** / 125 |
| Upload FK missing (\`source_upload_id\` set but no \`raw_report_uploads\` row) | **${uploadMissing}** rows |
| Identifier triple absent (no sku/asin/fnsku) | **${idMissingIdentifiers}** |

## Integrity

**integrityPass:** \`${integrityPass}\`  
**creationReadyPendingSignoff:** \`${integrityPass && uploadMissing === 0}\` (also requires owner signoff)

## Shape notes

Rows with unusual SKU tokens (e.g. \`.missing\`): **${shapeAnomalies.length}** (informational; classifier already accepted into bucket 4).
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "safe-new-grouping-analysis.md"),
    `# Safe-new grouping analysis

## Cardinality (125 candidate \`amazon_fba_inventory\` rows)

| Key | Distinct values | Groups with >1 row |
|-----|----------------:|-------------------:|
| Seller SKU (\`sku\`) | **${uniqueSkus}** | **${multiSku}** |
| ASIN | **${uniqueAsins}** | **${multiAsin}** |
| FNSKU | **${uniqueFnskus}** | **${multiFnsku}** |
| Normalized triplet (org + store + sku + asin + fnsku) | **${uniqueTriples}** | **${multiTriple}** |

## Product-creation cardinality (planning only)

| Strategy | Estimated \`INSERT products\` count |
|-----------|-------------------------------------:|
| One product per **source row** (conservative) | **125** |
| One product per **(organization_id, store_id, ASIN)** | **${estimatedProductsByAsin}** |

**Recommendation:** Governance should pick exactly one rule before execution (likely **one ASIN per store** if business confirms ASIN identifies sellable SKU; else **one per row** for maximum safety).

## Duplicate / anomaly signals

- **Duplicate ASIN groups:** ${multiAsin} — multiple FBA rows share an ASIN; if creating one product per ASIN, merge resolver updates accordingly.
- **SKU token anomalies:** ${shapeAnomalies.length} — see manifest \`downgrade.shapeAnomalyCount\` (not auto-downgraded here).
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "safe-new-product-creation-policy.md"),
    `# Safe-new product creation policy (NEXT-PRODUCT-ID-20)

## When auto-create is allowed (post signoff)

- Row is in **safe-new-eligible-pks.csv** for this run and preimage matches live DB at execution time.
- **No** \`product_identifier_map\` hit on seller_sku / asin / fnsku (org + store scope per PIM rules).
- **No** \`products\` row at (organization_id, store_id, sku) with \`merge_status != merged\`.
- **Single** chosen cardinality rule (per-row vs per-ASIN) documented in execution prompt.
- Upload lineage: \`source_upload_id\` resolves to \`raw_report_uploads\` when present (or explicit waiver in signoff).

## When human review is required

- Any classifier downgrade, map hit, SKU collision, or upload orphan.
- Any change to grouping rule after this dry-run (re-run dry-run).
- Rows with SKU shape tokens (\`.missing\`, Excel errors) — confirm title + ASIN/FNSKU before create.

## Idempotency

- Deterministic natural key: prefer **(organization_id, store_id, ASIN)** or **(organization_id, store_id, sku)** per chosen rule; reject second insert with unique violation → no-op + log.
- Execution uses **named staging temp table** + \`UPDATE ... FROM staging WHERE ... IS NULL\` mirroring Wave 1A/1B.

## Rollback

- Preimage CSV in this directory is the **SELECT** truth for resolver columns before create; product row soft-delete / merge policy is out of scope here but must be defined in execution prompt.

## \`product_identifier_map\` (deferred)

- **No map writes in the same transaction as first product insert** unless explicitly approved (NEXT-PRODUCT-ID-18): prefer **products first**, then map in a governed second step with audit.

## Source lineage

- Carry \`source_upload_id\` / import batch into product metadata or staging table per existing ingestion patterns (\`next-product-id-15\`, \`next-product-id-17c\` wave hygiene).
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "safe-new-signoff-requirements.md"),
    `# Signoff requirements — safe-new execution

1. **Owner** confirms \`integrityPass=true\` in \`manifest.json\` for this run (or waives specific rows with rationale).
2. **Cardinality rule** chosen and recorded (125 per-row vs **${estimatedProductsByAsin}** per ASIN/store).
3. **Upload orphan waiver** if \`uploadProvenanceMissingRows\` > 0 (this run: **${uploadMissing}**).
4. Separate **implementation prompt** for transactional \`INSERT products\` + resolver backfill — not this dry-run.
5. Rollback owner: preimage CSV + DB backup snapshot (operator responsibility).
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "rollback-and-idempotency-notes.md"),
    `# Rollback and idempotency notes

## Idempotency

- Staging table keyed by \`amazon_fba_inventory.id\`; **INSERT** products only for rows still \`resolved_product_id IS NULL\`.
- Use \`ON CONFLICT DO NOTHING\` (or equivalent) on chosen unique product key to make replays safe.

## Rollback (post execution — not performed here)

1. Delete or soft-delete created \`products\` rows by execution batch id (to be assigned in implementation prompt).
2. Re-null \`amazon_fba_inventory\` resolver columns for affected PKs using preimage from this pack.

## Read-only baseline

This run (\`${runId}\`) produced **no writes**; preimage CSV reflects **pre-creation** resolver nulls.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "next-step-recommendation.md"),
    `# Next-step recommendation

## Controlled product creation prompt

**May be generated only if:** \`manifest.validation.integrityPass\` is **true** and owner accepts upload-provenance state (${uploadMissing === 0 ? "**OK — zero upload orphans**" : "**BLOCKED** until upload orphans waived or fixed"}).

## Estimated inserts

- **Upper bound:** **125** products (one per FBA row).
- **Lower bound (ASIN grouping):** **${estimatedProductsByAsin}** products if policy merges by (org, store, ASIN).

## Downgrade / conflict

- **Distinct rows flagged** (NDJSON / resolver / map / collision / upload / org / identifiers): **${downgradeCount}**
- **Rows passing all automated checks:** **${safeNewValidatedCount}**
- **integrityPass:** \`${integrityPass}\`

## Exact next prompt

> **NEXT-PRODUCT-ID-21** — Safe-new **execution** (post-signoff): choose cardinality rule, transactional \`INSERT INTO products\` (+ optional second-step \`product_identifier_map\` per policy), then scoped \`UPDATE amazon_fba_inventory\` for the same PK set; preimage vs live diff + row-count guards; **no Amazon/OpenAI**; rollback script included.

If \`integrityPass\` is false, run **remediation / re-classification** prompt first instead of NEXT-PRODUCT-ID-21.
`,
    "utf8",
  );

  log("complete", { integrityPass, estimatedProductsByAsin, downgradeCount, safeNewValidatedCount });
  fs.writeFileSync(path.join(outDir, "logs", "product-id-20.ndjson"), logs.join("\n") + "\n", "utf8");

  console.log(outDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
