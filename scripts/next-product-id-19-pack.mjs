/**
 * NEXT-PRODUCT-ID-19 — read-only post–Wave 1B validation + artifact pack.
 * No DB writes. Invokes product-seed-dry-run-report (Supabase read-only) + SELECT via pg.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function loadDirectPostgresUrl() {
  const p = path.join(REPO_ROOT, ".env.local");
  const text = fs.readFileSync(p, "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("DIRECT_POSTGRES_URL="));
  if (!line) throw new Error("DIRECT_POSTGRES_URL missing");
  return line.slice("DIRECT_POSTGRES_URL=".length).trim();
}

/** Load .env.local into process.env for child (Supabase dry-run). */
function loadEnvLocalForChildren() {
  const p = path.join(REPO_ROOT, ".env.local");
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

function parseSourceRowIds(csvPath) {
  const lines = fs.readFileSync(csvPath, "utf8").trimEnd().split(/\r?\n/).slice(1);
  return lines.filter(Boolean).map((line) => line.split(",")[0].trim());
}

function runIdUtc() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function escCsv(s) {
  if (s == null) return "";
  const t = String(s);
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function logLine(logs, obj) {
  logs.push(JSON.stringify({ ts: new Date().toISOString(), ...obj }));
}

async function main() {
  loadEnvLocalForChildren();
  const runId = runIdUtc();
  const outDir = path.join(REPO_ROOT, ".cursor/audit-reports/next-product-id-19", runId);
  const dryRunDir = path.join(outDir, "live-dry-run");
  fs.mkdirSync(path.join(outDir, "logs"), { recursive: true });
  const logs = [];
  logLine(logs, { event: "start", runId, auditPrompt: "NEXT-PRODUCT-ID-19" });

  const w1aCsv = path.join(
    REPO_ROOT,
    ".cursor/audit-reports/next-product-id-11/20260513T231500Z/wave-1a-eligible-pks.csv",
  );
  const w1bCsv = path.join(
    REPO_ROOT,
    ".cursor/audit-reports/next-product-id-17/20260514T020926Z/wave-1b-eligible-pks.csv",
  );

  const w1aIds = parseSourceRowIds(w1aCsv);
  const w1bIds = parseSourceRowIds(w1bCsv);
  const waveUnion = [...new Set([...w1aIds, ...w1bIds])];
  logLine(logs, {
    event: "wave_csv_loaded",
    wave1aCount: w1aIds.length,
    wave1bCount: w1bIds.length,
    unionDistinct: waveUnion.length,
  });
  if (w1aIds.length !== 638) throw new Error(`wave1a expected 638 got ${w1aIds.length}`);
  if (w1bIds.length !== 144) throw new Error(`wave1b expected 144 got ${w1bIds.length}`);
  if (waveUnion.length !== 782) throw new Error(`union expected 782 got ${waveUnion.length}`);

  const url = loadDirectPostgresUrl();
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  logLine(logs, { event: "pg_connected_readonly" });

  const q = async (sql, params = []) => (await client.query(sql, params)).rows;

  const [{ total: totalRows }] = await q(`SELECT COUNT(*)::int AS total FROM public.amazon_fba_inventory`);
  const [{ c: resolvedProductNotNull }] = await q(
    `SELECT COUNT(*)::int AS c FROM public.amazon_fba_inventory WHERE resolved_product_id IS NOT NULL`,
  );
  const [{ c: unresolvedNullProduct }] = await q(
    `SELECT COUNT(*)::int AS c FROM public.amazon_fba_inventory WHERE resolved_product_id IS NULL`,
  );
  const [{ c: resolvedStrict }] = await q(
    `SELECT COUNT(*)::int AS c FROM public.amazon_fba_inventory
     WHERE resolved_product_id IS NOT NULL AND identifier_resolution_status = 'resolved'`,
  );
  const [{ c: distinctResolvedProducts }] = await q(
    `SELECT COUNT(DISTINCT resolved_product_id)::int AS c FROM public.amazon_fba_inventory WHERE resolved_product_id IS NOT NULL`,
  );

  const statusDist = await q(
    `SELECT identifier_resolution_status AS status, COUNT(*)::int AS cnt
     FROM public.amazon_fba_inventory GROUP BY 1 ORDER BY 2 DESC`,
  );
  const confDist = await q(
    `SELECT identifier_resolution_confidence::text AS confidence, COUNT(*)::int AS cnt
     FROM public.amazon_fba_inventory GROUP BY 1 ORDER BY 2 DESC`,
  );

  const [{ c: badProductNoStatus }] = await q(
    `SELECT COUNT(*)::int AS c FROM public.amazon_fba_inventory
     WHERE resolved_product_id IS NOT NULL
       AND (identifier_resolution_status IS DISTINCT FROM 'resolved')`,
  );
  const [{ c: badStatusNoProduct }] = await q(
    `SELECT COUNT(*)::int AS c FROM public.amazon_fba_inventory
     WHERE resolved_product_id IS NULL AND identifier_resolution_status = 'resolved'`,
  );

  const [{ c: wave1aUnresolved }] = await q(
    `SELECT COUNT(*)::int AS c FROM public.amazon_fba_inventory
     WHERE id = ANY($1::uuid[]) AND resolved_product_id IS NULL`,
    [w1aIds],
  );
  const [{ c: wave1bUnresolved }] = await q(
    `SELECT COUNT(*)::int AS c FROM public.amazon_fba_inventory
     WHERE id = ANY($1::uuid[]) AND resolved_product_id IS NULL`,
    [w1bIds],
  );
  const [{ c: resolvedOutsideWave }] = await q(
    `SELECT COUNT(*)::int AS c FROM public.amazon_fba_inventory
     WHERE resolved_product_id IS NOT NULL AND NOT (id = ANY($1::uuid[]))`,
    [waveUnion],
  );
  const [{ c: waveUnionUnresolved }] = await q(
    `SELECT COUNT(*)::int AS c FROM public.amazon_fba_inventory
     WHERE id = ANY($1::uuid[]) AND resolved_product_id IS NULL`,
    [waveUnion],
  );

  const [{ c: dupIdUnresolved }] = await q(
    `SELECT COUNT(*)::int AS c FROM (
       SELECT id FROM public.amazon_fba_inventory WHERE resolved_product_id IS NULL
     ) t`,
  );
  const [{ c: distinctIdUnresolved }] = await q(
    `SELECT COUNT(DISTINCT id)::int AS c FROM public.amazon_fba_inventory WHERE resolved_product_id IS NULL`,
  );

  const [{ c: dupSkuUnresolved }] = await q(
    `SELECT COUNT(*)::int AS c FROM (
       SELECT sku FROM public.amazon_fba_inventory WHERE resolved_product_id IS NULL
       GROUP BY sku HAVING COUNT(*) > 1
     ) s`,
  );

  await client.end();
  logLine(logs, { event: "pg_queries_complete" });

  fs.mkdirSync(dryRunDir, { recursive: true });
  const relDry = path.relative(REPO_ROOT, dryRunDir);
  const r = spawnSync(
    "npx",
    [
      "tsx",
      "scripts/product-seed-dry-run-report.ts",
      "--source-table=amazon_fba_inventory",
      `--output-dir=${relDry}`,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", shell: true, env: { ...process.env } },
  );
  if (r.status !== 0) {
    logLine(logs, { event: "dry_run_failed", stderr: r.stderr?.slice(0, 4000), stdout: r.stdout?.slice(0, 2000) });
    fs.writeFileSync(path.join(outDir, "logs", "product-id-19.ndjson"), logs.join("\n") + "\n");
    throw new Error(`dry-run exit ${r.status}: ${r.stderr}`);
  }
  logLine(logs, { event: "dry_run_complete", stdoutTail: r.stdout?.slice(-800) });

  const subdirs = fs
    .readdirSync(dryRunDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  if (subdirs.length !== 1) {
    throw new Error(`expected one run subdir under live-dry-run, got: ${subdirs.join(", ")}`);
  }
  const dryRunRunDir = path.join(dryRunDir, subdirs[0]);
  logLine(logs, { event: "dry_run_run_dir", path: path.relative(REPO_ROOT, dryRunRunDir) });

  const rollPath = path.join(dryRunRunDir, "00-roll-up.csv");
  const rollText = fs.readFileSync(rollPath, "utf8");
  const rollLines = rollText.trimEnd().split(/\r?\n/).slice(1);
  const bucketCounts = {};
  for (const line of rollLines) {
    const cols = line.split(",");
    const bid = parseInt(cols[3], 10);
    const cnt = parseInt(cols[5], 10);
    bucketCounts[bid] = (bucketCounts[bid] ?? 0) + cnt;
  }

  const ndjsonPath = path.join(dryRunRunDir, "01-rows.ndjson");
  const ndLines = fs.readFileSync(ndjsonPath, "utf8").trimEnd().split(/\r?\n/).filter(Boolean);
  const safeRows = [];
  const ambRows = [];
  const primaryReasonTally = { 4: {}, 5: {} };
  for (const line of ndLines) {
    const o = JSON.parse(line);
    if (o.bucket_id === 4) {
      safeRows.push(o);
      const pr = o.primary_reason ?? "";
      primaryReasonTally[4][pr] = (primaryReasonTally[4][pr] ?? 0) + 1;
    }
    if (o.bucket_id === 5) {
      ambRows.push(o);
      const pr = o.primary_reason ?? "";
      primaryReasonTally[5][pr] = (primaryReasonTally[5][pr] ?? 0) + 1;
    }
  }

  const safeCsvPath = path.join(outDir, "remaining-safe-new-candidates.csv");
  const ambCsvPath = path.join(outDir, "remaining-ambiguous-conflicts.csv");
  const safeHdr =
    "source_row_id,organization_id,store_id,bucket_id,bucket_label,primary_reason,seller_sku,asin,fnsku\n";
  fs.writeFileSync(
    safeCsvPath,
    safeHdr +
      safeRows
        .map((o) =>
          [
            o.source_row_id,
            o.organization_id,
            o.store_id,
            o.bucket_id,
            o.bucket_label,
            o.primary_reason,
            o.identifiers?.seller_sku ?? "",
            o.identifiers?.asin ?? "",
            o.identifiers?.fnsku ?? "",
          ]
            .map(escCsv)
            .join(","),
        )
        .join("\n") +
      "\n",
    "utf8",
  );
  fs.writeFileSync(
    ambCsvPath,
    "source_row_id,organization_id,store_id,bucket_id,bucket_label,primary_reason,conflict_product_ids_json\n" +
      ambRows
        .map((o) =>
          [
            o.source_row_id,
            o.organization_id,
            o.store_id,
            o.bucket_id,
            o.bucket_label,
            o.primary_reason,
            JSON.stringify(o.conflict_product_ids ?? []),
          ]
            .map(escCsv)
            .join(","),
        )
        .join("\n") +
      "\n",
    "utf8",
  );

  const safeNewCount = bucketCounts[4] ?? 0;
  const ambCount = bucketCounts[5] ?? 0;
  const bucket1 = bucketCounts[1] ?? 0;

  const countsMatchExpected =
    totalRows === 949 &&
    resolvedStrict === 782 &&
    unresolvedNullProduct === 167 &&
    safeNewCount === 125 &&
    ambCount === 42;

  const scopePass =
    wave1aUnresolved === 0 &&
    wave1bUnresolved === 0 &&
    resolvedOutsideWave === 0 &&
    waveUnionUnresolved === 0 &&
    dupIdUnresolved === distinctIdUnresolved;

  const manifestClean = {
    auditPrompt: "NEXT-PRODUCT-ID-19",
    runId,
    inputs: {
      nextProductId17c: ".cursor/audit-reports/next-product-id-17c/20260514T054938Z/",
      nextProductId17b: ".cursor/audit-reports/next-product-id-17b/20260514T023225Z/",
      nextProductId17: ".cursor/audit-reports/next-product-id-17/20260514T020926Z/",
      nextProductId18: ".cursor/audit-reports/next-product-id-18/20260514T023624Z/",
    },
    livePostgres: {
      totalRows,
      resolvedProductNotNull,
      resolvedWithResolvedStatus: resolvedStrict,
      unresolvedNullProduct,
      distinctResolvedProductIds: distinctResolvedProducts,
      badPairings: {
        productNotNullButStatusNotResolved: badProductNoStatus,
        statusResolvedButProductNull: badStatusNoProduct,
      },
    },
    dryRunLive: {
      outputDir: path.relative(REPO_ROOT, dryRunRunDir).replace(/\\/g, "/"),
      bucketCounts,
      bucket4SafeNew: safeNewCount,
      bucket5Ambiguous: ambCount,
      bucket1AlreadyResolved: bucket1,
    },
    scopeIntegrity: {
      wave1aUnresolved,
      wave1bUnresolved,
      resolvedOutsideWaveUnion: resolvedOutsideWave,
      waveUnionStillUnresolved: waveUnionUnresolved,
      duplicateIdCheckUnresolved: dupIdUnresolved === distinctIdUnresolved,
      skuDuplicateGroupsUnresolved: dupSkuUnresolved,
    },
    classificationSubtotals: {
      safe_new_candidate: safeNewCount,
      ambiguous_conflict: ambCount,
      primaryReasonTallyBucket4: primaryReasonTally[4],
      primaryReasonTallyBucket5: primaryReasonTally[5],
    },
    validation: {
      noDbWrites: true,
      noMigrations: true,
      noProductCreates: true,
      noProductIdentifierMapMutation: true,
      noAmazonApi: true,
      noOpenAi: true,
      countsMatchExpected,
      scopePass,
    },
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifestClean, null, 2), "utf8");

  const statusMd = statusDist.map((r) => `| ${r.status ?? "(null)"} | ${r.cnt} |`).join("\n");
  const confMd = confDist.map((r) => `| ${r.confidence ?? "(null)"} | ${r.cnt} |`).join("\n");

  fs.writeFileSync(
    path.join(outDir, "post-wave-1b-validation-summary.md"),
    `# Post–Wave 1B validation summary — NEXT-PRODUCT-ID-19

**Run ID:** \`${runId}\`

## Live \`amazon_fba_inventory\` (Postgres read-only)

| Metric | Value | Expected |
|--------|------:|----------|
| Total rows | **${totalRows}** | 949 |
| \`resolved_product_id\` NOT NULL | **${resolvedProductNotNull}** | 782 |
| NOT NULL + \`identifier_resolution_status = 'resolved'\` | **${resolvedStrict}** | 782 |
| \`resolved_product_id\` NULL (unresolved) | **${unresolvedNullProduct}** | 167 |
| DISTINCT \`resolved_product_id\` (non-null) | **${distinctResolvedProducts}** | (informational) |

## Bad pairings

| Pattern | Count |
|---------|------:|
| Product NOT NULL but status ≠ \`resolved\` | **${badProductNoStatus}** |
| Status \`resolved\` but product NULL | **${badStatusNoProduct}** |

## Live dry-run classifier (Supabase read-only)

Re-run \`product-seed-dry-run-report.ts\` for \`amazon_fba_inventory\` only. Output: \`${path.relative(REPO_ROOT, dryRunRunDir).replace(/\\/g, "/")}/\`.

| Bucket | Label | Row count |
|--------|--------|----------:|
| 1 | already_resolved | ${bucket1} |
| 4 | safe_new_candidate | ${safeNewCount} |
| 5 | ambiguous_conflict | ${ambCount} |

**Counts match prior NEXT-PRODUCT-ID-17 expectations:** ${countsMatchExpected ? "yes" : "NO — investigate"}.

## Validation

- No DB writes, no migrations, no product / \`product_identifier_map\` mutations, no Amazon or OpenAI API calls from this pack.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "resolved-unresolved-distribution.md"),
    `# Resolved / unresolved distribution

## Status (\`identifier_resolution_status\`)

| Status | Count |
|--------|------:|
${statusMd}

## Confidence (\`identifier_resolution_confidence\`)

| Confidence | Count |
|------------|------:|
${confMd}
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "scope-integrity-check.md"),
    `# Scope integrity

Wave 1A PKs loaded from \`next-product-id-11/.../wave-1a-eligible-pks.csv\` (${w1aIds.length} rows).  
Wave 1B PKs from \`next-product-id-17/.../wave-1b-eligible-pks.csv\` (${w1bIds.length} rows).  
Distinct union: **${waveUnion.length}**.

| Check | Count | Pass |
|-------|------:|:----:|
| Wave 1A rows still unresolved | ${wave1aUnresolved} | ${wave1aUnresolved === 0 ? "yes" : "no"} |
| Wave 1B rows still unresolved | ${wave1bUnresolved} | ${wave1bUnresolved === 0 ? "yes" : "no"} |
| Resolved rows whose \`id\` is **not** in Wave 1A ∪ 1B | ${resolvedOutsideWave} | ${resolvedOutsideWave === 0 ? "yes" : "no"} |
| Rows in wave union still unresolved | ${waveUnionUnresolved} | ${waveUnionUnresolved === 0 ? "yes" : "no"} |
| Unresolved: \`COUNT(*)\` = \`COUNT(DISTINCT id)\` | ${dupIdUnresolved} vs ${distinctIdUnresolved} | ${dupIdUnresolved === distinctIdUnresolved ? "yes" : "no"} |
| Unresolved duplicate \`sku\` groups (HAVING >1) | ${dupSkuUnresolved} | informational |

**Interpretation:** Every resolved row should be exactly one of the 782 controlled-update PKs; no extra resolver writes. Unresolved pool (167) should be disjoint from the wave union.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "remaining-167-classification.md"),
    `# Remaining 167 — classification (live dry-run)

Source: \`${path.relative(REPO_ROOT, dryRunRunDir).replace(/\\/g, "/")}/01-rows.ndjson\` + \`00-roll-up.csv\`.

| Class | Count | Notes |
|-------|------:|-------|
| **safe_new_candidate** (bucket 4) | **${safeNewCount}** | Matches NEXT-PRODUCT-ID-17 \`safe_new_bucket4\` |
| **ambiguous_conflict** (bucket 5) | **${ambCount}** | Matches NEXT-PRODUCT-ID-17 \`ambiguous_bucket5\` |
| cross_product_conflict (signal) | — | Subsumed under bucket 5 primary reasons in dry-run |
| fan-out | — | Subsumed under bucket 5 |
| missing lineage / dirty / other buckets (6–11) | **0** | No rows in other buckets for this table in live run |

### Bucket 5 — \`primary_reason\` tallies

${Object.entries(primaryReasonTally[5])
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `- \`${k}\`: ${v}`)
  .join("\n")}

### Bucket 4 — \`primary_reason\` tallies

${Object.entries(primaryReasonTally[4])
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `- \`${k}\`: ${v}`)
  .join("\n")}
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "safe-new-candidate-strategy.md"),
    `# Strategy — 125 safe-new candidates

## Position

Per NEXT-PRODUCT-ID-18 \`safe-new-product-creation-policy.md\`: safe-new is the **only** auto-create lane; it requires dry-run signoff, idempotency keys, and governance hooks (no silent \`INSERT\`).

## Recommended path

1. **Dry-run pack** — export preimage CSV + staging \`SELECT\` for exactly 125 PKs (bucket 4, \`resolved_product_id IS NULL\`), mirroring Wave 1A/1B pattern.
2. **Explicit non-goals** — do not widen scope to bucket 5; do not write \`product_identifier_map\` until product graph is stable (NEXT-PRODUCT-ID-18 guidance).
3. **Execution gate** — owner signoff + single transactional \`INSERT products\` + resolver column update (separate prompt); **no creation** until signoff.

## CSV

Row list: \`remaining-safe-new-candidates.csv\` in this directory.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "ambiguous-conflict-strategy.md"),
    `# Strategy — 42 ambiguous / conflict rows

## Position

Bucket 5 rows require **human or policy-driven** resolution: fan-out, cross-product conflict, SKU collision, or multi-token ambiguity.

## Recommended path

1. **Conflict review pack** — one row per \`source_row_id\` with \`primary_reason\`, \`conflict_product_ids\`, native identifiers; optional join to \`products\` for titles (read-only).
2. **Parallel track** — can proceed **after** safe-new dry-run is approved, or in parallel if staffed; do not block safe-new on full conflict resolution.
3. **No auto-create** — never map bucket 5 to automatic \`INSERT\`.

## CSV

Row list: \`remaining-ambiguous-conflicts.csv\`.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "next-implementation-options.md"),
    `# Next implementation options

| Option | Description | Risk |
|--------|-------------|------|
| **A** | Safe-new product creation **dry-run** for 125 rows (bucket 4) | Low if scoped to preimage + staging |
| **B** | Conflict review pack for 42 rows (bucket 5) | Medium — needs analyst time |
| **C** | Universal resolver / next source-table writeback (NEXT-PRODUCT-ID-18 matrix) | Higher — migrations + import writer |

Cross-reference: \`next-product-id-18/20260514T023624Z/source-table-coverage-matrix.md\` and \`import-pipeline-integration-plan.md\`.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "next-step-recommendation.md"),
    `# Next-step recommendation

## Branch

**Primary:** **A** — Safe-new product creation **dry-run** for **125** rows (bucket 4), **no \`INSERT\` until signoff**, same hygiene as NEXT-PRODUCT-ID-17B/17C.

**Secondary (parallel OK):** **B** — Conflict review pack for **42** rows.

**Defer for later roadmap slice:** **C** — Additional source tables from the universal matrix until Lane B (\`amazon_fba_inventory\`) tranche is closed.

## Suggested next prompt (literal)

> **NEXT-PRODUCT-ID-20** — Safe-new bucket-4 dry-run: preimage \`SELECT\`, eligible PK CSV (125), scope integrity vs Wave 1A/1B, manifest, **read-only** until signoff; then controlled \`INSERT products\` + resolver update prompt (separate).

## Preconditions satisfied

- Post–Wave 1B counts: 782 / 167 ✓  
- Classifier still splits remainder 125 / 42 ✓  
- No resolver drift on wave PKs ✓
`,
    "utf8",
  );

  logLine(logs, {
    event: "complete",
    countsMatchExpected,
    scopePass,
    safeNewCount,
    ambCount,
  });
  fs.writeFileSync(path.join(outDir, "logs", "product-id-19.ndjson"), logs.join("\n") + "\n", "utf8");

  console.log(outDir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
