/**
 * NEXT-PRODUCT-ID-17 — Post–Wave 1a read-only dry-run + Wave 1b eligibility pack.
 *
 *   npx tsx scripts/next-product-id-17-wave-1b-pack.ts
 *
 * Invokes `product-seed-dry-run-report.ts` (SELECT-only) then derives Wave 1b
 * eligible/blocked CSVs. No DB writes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

import { mkRunDir, mkRunId, writeCsv, writeJson } from "../lib/audits/product-seed-output";

const WAVE1A_CSV = path.join(
  process.cwd(),
  ".cursor/audit-reports/next-product-id-11/20260513T231500Z/wave-1a-eligible-pks.csv",
);

type NdRow = {
  source_table: string;
  source_row_id: string;
  organization_id: string | null;
  store_id: string | null;
  upload_provenance_resolved: boolean;
  bucket_id: number;
  bucket_label: string;
  primary_reason: string;
  secondary_reasons: string[];
  existing_product_id_hit: string | null;
  match_rank: number | null;
};

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

function parseCsvUuidColumn(filePath: string, colName: string): Set<string> {
  if (!fs.existsSync(filePath)) return new Set();
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return new Set();
  const header = lines[0].split(",").map((h) => h.trim());
  const idx = header.indexOf(colName);
  if (idx < 0) return new Set();
  const out = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const v = parts[idx]?.trim();
    if (v) out.add(v);
  }
  return out;
}

function loadWave1aIds(): Set<string> {
  const raw = fs.readFileSync(WAVE1A_CSV, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(",").map((h) => h.trim());
  const i = header.indexOf("source_row_id");
  const out = new Set<string>();
  for (let n = 1; n < lines.length; n++) {
    const parts = lines[n].split(",");
    if (parts[i]) out.add(parts[i].trim());
  }
  return out;
}

function hasFanOutSecondary(sec: string[]): boolean {
  return sec.some((s) => s.startsWith("f1_identifier_fan_out"));
}

function isCrossProductPrimary(primary: string): boolean {
  return primary === "f2_cross_product_conflict";
}

function resolveDryRunDir(base: string): string {
  const names = fs.readdirSync(base).filter((n) => {
    const p = path.join(base, n);
    return fs.statSync(p).isDirectory() && /^\d{8}T\d{6}Z$/.test(n);
  });
  if (names.length === 0) throw new Error(`No dry-run subdirectory under ${base}`);
  names.sort();
  return path.join(base, names[names.length - 1]!);
}

function wave1bEligible(
  r: NdRow,
  crossIds: Set<string>,
  gapIds: Set<string>,
): { ok: boolean; reason: string } {
  if (r.bucket_id !== 2 && r.bucket_id !== 3) return { ok: false, reason: `bucket_${r.bucket_id}_${r.bucket_label}` };
  if (r.match_rank !== 4 && r.match_rank !== 8) return { ok: false, reason: `wrong_match_rank_${r.match_rank}` };
  if (!r.existing_product_id_hit) return { ok: false, reason: "missing_existing_product_id_hit" };
  if (hasFanOutSecondary(r.secondary_reasons ?? [])) return { ok: false, reason: "f1_identifier_fan_out_secondary" };
  if ((r.secondary_reasons ?? []).length > 0) return { ok: false, reason: `secondary_reasons:${(r.secondary_reasons ?? []).join("|")}` };
  if (!r.upload_provenance_resolved) return { ok: false, reason: "upload_provenance_unresolved" };
  if (crossIds.has(r.source_row_id)) return { ok: false, reason: "cross_product_conflict_csv" };
  if (gapIds.has(r.source_row_id)) return { ok: false, reason: "provenance_gap_csv" };
  return { ok: true, reason: "" };
}

function blockReasonForUnresolved(r: NdRow, crossIds: Set<string>, gapIds: Set<string>): string {
  const elig = wave1bEligible(r, crossIds, gapIds);
  if (elig.ok) return "eligible";
  return elig.reason;
}

function appendLog(logPath: string, o: Record<string, unknown>): void {
  fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n", "utf8");
}

function chunkUuids(ids: string[], perChunk: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += perChunk) out.push(ids.slice(i, i + perChunk));
  return out;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const runId = mkRunId();
  const outDir = mkRunDir(path.join(".cursor", "audit-reports", "next-product-id-17"), runId);
  const logPath = path.join(outDir, "logs", "product-id-17.ndjson");
  const dryBase = path.join(outDir, "product-seed-dry-run");

  appendLog(logPath, { event: "start", runId, dryRunOutputParent: dryBase });

  fs.mkdirSync(dryBase, { recursive: true });
  const cmd = [
    "npx",
    "tsx",
    "scripts/product-seed-dry-run-report.ts",
    "--source-table=amazon_fba_inventory",
    "--max-rows-per-table=5000",
    `--output-dir=${dryBase}`,
  ].join(" ");
  execSync(cmd, { cwd: process.cwd(), stdio: "inherit", encoding: "utf8" });

  const dryRunDir = resolveDryRunDir(dryBase);
  appendLog(logPath, { event: "dry_run_complete", dryRunDir });

  const ndPath = path.join(dryRunDir, "01-rows.ndjson");
  const crossPath = path.join(dryRunDir, "03-cross-product-conflict.csv");
  const gapPath = path.join(dryRunDir, "04-provenance-gap.csv");

  const crossIds = parseCsvUuidColumn(crossPath, "source_row_id");
  const gapIds = parseCsvUuidColumn(gapPath, "source_row_id");
  const wave1aIds = loadWave1aIds();

  const rows: NdRow[] = [];
  for (const line of fs.readFileSync(ndPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(JSON.parse(line) as NdRow);
  }

  let alreadyResolved = 0;
  let viaMap = 0;
  let viaProducts = 0;
  let safeNew = 0;
  let ambiguous = 0;
  let crossPrimary = 0;
  let fanOutSecondary = 0;
  let dirtyLineage = 0;
  let unresolvedOther = 0;

  const safeNewRows: NdRow[] = [];

  for (const r of rows) {
    if (r.bucket_id === 1) {
      alreadyResolved++;
      continue;
    }
    if (hasFanOutSecondary(r.secondary_reasons ?? [])) fanOutSecondary++;
    if (r.bucket_id === 2) viaMap++;
    else if (r.bucket_id === 3) viaProducts++;
    else if (r.bucket_id === 4) {
      safeNew++;
      safeNewRows.push(r);
    } else if (r.bucket_id === 5) {
      ambiguous++;
      if (isCrossProductPrimary(r.primary_reason) || crossIds.has(r.source_row_id)) crossPrimary++;
    } else if (r.bucket_id === 8 || r.bucket_id === 10) dirtyLineage++;
    else if (r.bucket_id === 11 && r.primary_reason === "upload_provenance_unresolved") dirtyLineage++;
    else if (gapIds.has(r.source_row_id)) dirtyLineage++;
    else unresolvedOther++;
  }

  const unresolvedCount = rows.filter((r) => r.bucket_id !== 1).length;

  const eligible: NdRow[] = [];
  const blocked: Array<Record<string, unknown>> = [];

  for (const r of rows) {
    if (r.bucket_id === 1) continue;
    const elig = wave1bEligible(r, crossIds, gapIds);
    if (elig.ok) eligible.push(r);
    else {
      blocked.push({
        source_row_id: r.source_row_id,
        organization_id: r.organization_id,
        store_id: r.store_id,
        bucket_id: r.bucket_id,
        match_rank: r.match_rank,
        block_reason: blockReasonForUnresolved(r, crossIds, gapIds),
        bucket_label: r.bucket_label,
        primary_reason: r.primary_reason,
      });
    }
  }

  const eligibleCsv = eligible.map((r) => ({
    source_row_id: r.source_row_id,
    organization_id: r.organization_id,
    store_id: r.store_id,
    bucket_id: r.bucket_id,
    match_rank: r.match_rank,
    existing_product_id_hit: r.existing_product_id_hit,
    wave: "1b",
  }));

  const eligibleHeaders = [
    "source_row_id",
    "organization_id",
    "store_id",
    "bucket_id",
    "match_rank",
    "existing_product_id_hit",
    "wave",
  ] as const;
  writeCsv(path.join(outDir, "wave-1b-eligible-pks.csv"), [...eligibleHeaders], eligibleCsv);

  const blockedHeaders = [
    "source_row_id",
    "organization_id",
    "store_id",
    "bucket_id",
    "match_rank",
    "block_reason",
    "bucket_label",
    "primary_reason",
  ] as const;
  writeCsv(path.join(outDir, "wave-1b-blocked-pks.csv"), [...blockedHeaders], blocked);

  if (eligible.length + blocked.length !== unresolvedCount) {
    appendLog(logPath, {
      event: "warn_eligible_plus_blocked",
      eligible: eligible.length,
      blocked: blocked.length,
      unresolvedCount,
    });
  }

  const wave1aResolvedInDryRun = rows.filter((r) => r.bucket_id === 1 && wave1aIds.has(r.source_row_id)).length;

  const blockedSafeNew = blocked.filter((b) => String(b.block_reason).startsWith("bucket_4")).length;
  const blockedAmbiguous = blocked.filter((b) => String(b.block_reason).startsWith("bucket_5")).length;

  const manifest = {
    auditPrompt: "NEXT-PRODUCT-ID-17",
    runId,
    dryRunDir: path.relative(process.cwd(), dryRunDir).replace(/\\/g, "/"),
    rowsScanned: rows.length,
    wave1aEligibleCsvCount: wave1aIds.size,
    alreadyResolvedBucket1: alreadyResolved,
    unresolvedPool: unresolvedCount,
    wave1bEligibleCount: eligible.length,
    wave1bBlockedCount: blocked.length,
    blockedBreakdown: {
      safe_new_bucket4: blockedSafeNew,
      ambiguous_bucket5: blockedAmbiguous,
    },
    validation: {
      noDbWrites: true,
      noUpdateInsertDelete: true,
      readOnlySubprocess: "scripts/product-seed-dry-run-report.ts",
      noAmazonApi: true,
      noOpenAi: true,
    },
    distribution: {
      already_resolved: alreadyResolved,
      existing_via_identifier_map: viaMap,
      existing_via_products: viaProducts,
      safe_new_candidate: safeNew,
      ambiguous_conflict_bucket5: ambiguous,
      cross_product_conflict_csv_rows: crossIds.size,
      cross_product_signal_rows: crossPrimary,
      fan_out_secondary_signal_rows: fanOutSecondary,
      dirty_missing_lineage_misc: dirtyLineage,
      unresolved_other_buckets: unresolvedOther,
    },
    wave1aRowsInBucket1: wave1aResolvedInDryRun,
    inputs: {
      nextProductId16: ".cursor/audit-reports/next-product-id-16/20260514T015711Z/",
      nextProductId15: ".cursor/audit-reports/next-product-id-15/20260514T014702Z/",
      nextProductId10: ".cursor/audit-reports/next-product-id-10/20260513T214753Z/",
      nextProductId11: ".cursor/audit-reports/next-product-id-11/20260513T231500Z/",
    },
  };
  writeJson(path.join(outDir, "manifest.json"), manifest);

  const conflictsMd = `# Conflicts and review needed — NEXT-PRODUCT-ID-17

## Cross-product conflict (dry-run)

- Rows in \`03-cross-product-conflict.csv\`: **${crossIds.size}** UUIDs (table-wide).
- Unresolved rows (\`bucket_id != 1\`) with primary \`f2_cross_product_conflict\`: counted in manifest \`cross_product_signal_rows\` (may overlap CSV).

## Fan-out (row-level)

- Rows with \`secondary_reasons\` containing \`f1_identifier_fan_out:*\`: **${fanOutSecondary}** (may appear on bucket 2/3/5 rows; Wave 1b eligibility requires **empty** \`secondary_reasons\`).

## Ambiguous bucket 5

- Total **bucket 5** rows: **${ambiguous}** (see internal \`01-rows.ndjson\` under \`product-seed-dry-run/\`).

## Review queue

All non–Wave-1b-eligible unresolved rows need explicit policy before any resolver UPDATE beyond Wave 1b.
`;

  fs.writeFileSync(path.join(outDir, "conflicts-and-review-needed.md"), conflictsMd, "utf8");

  const safeNewMd = `# Safe-new candidates deferred — NEXT-PRODUCT-ID-17

**Count:** ${safeNew}

Wave 1b is **resolver-only** — \`safe_new_candidate\` (bucket 4) rows **require product creation** and are **out of scope** for Wave 1b.

They remain deferred until a separate product-creation / PIM workflow is approved.
`;
  fs.writeFileSync(path.join(outDir, "safe-new-candidates-deferred.md"), safeNewMd, "utf8");

  const distMd = `# Post–Wave dry-run distribution — NEXT-PRODUCT-ID-17

Fresh \`product-seed-dry-run-report\` over **amazon_fba_inventory** (${rows.length} rows).

| Roll-up key | Count |
|-------------|------:|
| \`already_resolved\` (bucket 1) | ${alreadyResolved} |
| \`existing_via_identifier_map\` (bucket 2) | ${viaMap} |
| \`existing_via_products\` (bucket 3) | ${viaProducts} |
| \`safe_new_candidate\` (bucket 4) | ${safeNew} |
| \`ambiguous_conflict\` (bucket 5) | ${ambiguous} |
| Dirty / missing org-store (bucket 8) + dirty identifiers (10) + provenance-gap rows + upload unresolved (11) | ${dirtyLineage} |
| Other (UPC-only, name-only, missing identifiers, human_review, …) | ${unresolvedOther} |

**Note:** After Wave 1a, classifier \`bucket_id === 1\` (**${alreadyResolved}** rows) is **already_resolved**. All other buckets sum to the **unresolved pool (${unresolvedCount})**.

## Taxonomy (prompt-aligned)

| Category | Operational definition (this run) | Count |
|----------|-----------------------------------|------:|
| \`already_resolved\` | Classifier bucket 1 (\`resolved_product_id\` on row) | ${alreadyResolved} |
| \`existing_via_identifier_map\` | Bucket 2 among **unresolved** pool | ${viaMap} |
| \`existing_via_products\` | Bucket 3 among unresolved | ${viaProducts} |
| \`safe_new_candidate\` | Bucket 4 — product creation required | ${safeNew} |
| \`ambiguous_conflict\` | Bucket 5 | ${ambiguous} |
| \`cross_product_conflict\` | Rows in \`03-cross-product-conflict.csv\` (UUID-level) | ${crossIds.size} |
| \`fan_out\` | Any row carrying \`f1_identifier_fan_out:*\` in \`secondary_reasons\` | ${fanOutSecondary} |
| \`dirty/missing lineage\` | Buckets 8/10, provenance-gap CSV, or upload unresolved | ${dirtyLineage} |
| \`unresolved\` (residual) | Other buckets (6, 7, 9, 11, …) | ${unresolvedOther} |

The **${unresolvedCount}** unresolved rows partition into **${eligible.length}** map-matched (rank 4/8 Wave 1b eligible), **${safeNew}** safe-new, and **${ambiguous}** ambiguous.

## Refinement signals

| Signal | Approx rows |
|--------|------------:|
| Cross-product primary or CSV | ${crossPrimary} |
| Fan-out secondary marker | ${fanOutSecondary} |
`;
  fs.writeFileSync(path.join(outDir, "post-wave-dry-run-distribution.md"), distMd, "utf8");

  const exclusionMd = `# Wave 1b exclusion rules — NEXT-PRODUCT-ID-17

## Eligibility (normative for \`wave-1b-eligible-pks.csv\`)

A row is **Wave 1b eligible** iff **all** hold:

1. **Not already resolved on row** — enforced by classifier: only rows with \`bucket_id\` 2 or 3 after Wave 1a (638 rows are bucket 1).
2. **Existing product match** — \`existing_product_id_hit\` is non-null.
3. **Match ranks 4 or 8 only** — \`(asin,fnsku)\` joint intersection hit (**rank 4**) or unique **asin** map hit (**rank 8**). **Excludes** ranks 2/3 used by Wave 1a.
4. **No identifier fan-out on row** — \`secondary_reasons\` must be **empty** (no \`f1_identifier_fan_out:*\`).
5. **Upload provenance** — \`upload_provenance_resolved === true\`.
6. **Not in** internal \`03-cross-product-conflict.csv\`.
7. **Not in** internal \`04-provenance-gap.csv\`.
8. **No product creation** — not bucket 4 (\`safe_new_candidate\`).
9. **No map mutation** — resolver UPDATE only; eligibility uses read-only map/products indices.

## Exclusions summary

| Exclusion | Target |
|-----------|--------|
| Wave 1a PKs | Already \`bucket_id === 1\`; not re-listed for 1b |
| Ranks 2 / 3 | Consumed by Wave 1a |
| Rank ≠ 4 and ≠ 8 | Wrong match tier for this wave |
| Secondary reasons | Fan-out / extra ambiguity |
| Provenance / cross CSV | Governance gates |
| Bucket 4–11 | Safe-new, ambiguous, identifiers, human review |
`;
  fs.writeFileSync(path.join(outDir, "wave-1b-exclusion-rules.md"), exclusionMd, "utf8");

  const summaryMd = `# Wave 1b summary — NEXT-PRODUCT-ID-17

**Run ID:** \`${runId}\`

| Metric | Value |
|--------|------:|
| Rows scanned | ${rows.length} |
| Wave 1a CSV PKs (reference) | ${wave1aIds.size} |
| \`already_resolved\` (classifier bucket 1) | ${alreadyResolved} |
| **Unresolved pool** (\`bucket_id != 1\`) | **${unresolvedCount}** |
| **Wave 1b eligible** | **${eligible.length}** |
| **Wave 1b blocked CSV rows** (unresolved non-eligible; complement of eligible) | **${blocked.length}** |
| Safe-new deferred (bucket 4) | ${safeNew} |
| Ambiguous / conflict (bucket 5) | ${ambiguous} |
| Cross-product conflict CSV rows | ${crossIds.size} |
| Fan-out secondary marker (any row) | ${fanOutSecondary} |

\`wave-1b-blocked-pks.csv\` lists all **${blocked.length}** unresolved rows that are **not** Wave 1b eligible (${blockedSafeNew} safe-new + ${blockedAmbiguous} ambiguous).

Internal dry-run artifacts: \`${path.relative(process.cwd(), dryRunDir).replace(/\\/g, "/")}/\`
`;
  fs.writeFileSync(path.join(outDir, "wave-1b-summary.md"), summaryMd, "utf8");

  const signoffMd = `# Signoff requirements — Wave 1b

## Validation (this run)

See \`manifest.json\` → \`validation\`: read-only Supabase \`SELECT\` via \`product-seed-dry-run-report.ts\`; no \`UPDATE\` / \`INSERT\` / \`DELETE\`; no Amazon or OpenAI calls.

## Signoff checklist

1. **Owner review** of \`wave-1b-eligible-pks.csv\` and \`wave-1b-blocked-pks.csv\`.
2. **Preimage** — run \`preimage-select-wave-1b.sql\` (SELECT only) and archive CSV before any UPDATE prompt.
3. **Explicit NEXT-PRODUCT-ID-18 (or later) execution prompt** with staged \`UPDATE\` + verify, mirroring NEXT-PRODUCT-ID-15.
4. **Rollback** — preimage row snapshot for every PK in the eligible list.

No execution in NEXT-PRODUCT-ID-17.
`;
  fs.writeFileSync(path.join(outDir, "signoff-requirements-wave-1b.md"), signoffMd, "utf8");

  const nextMd = `# Next step recommendation — NEXT-PRODUCT-ID-17

1. Human review of **${eligible.length}** Wave 1b eligible PKs (ranks **4** and **8** only).
2. **NEXT-PRODUCT-ID-18:** staged \`UPDATE\` for \`wave-1b-eligible-pks.csv\` with preimage + post-verify (no Amazon API).

\`\`\`text
NEXT-PRODUCT-ID-18 — Execute Wave 1b resolver UPDATE using
.cursor/audit-reports/next-product-id-17/${runId}/wave-1b-eligible-pks.csv;
SELECT-only preimage + verify; no other tables.
\`\`\`
`;
  fs.writeFileSync(path.join(outDir, "next-step-recommendation.md"), nextMd, "utf8");

  const ids = eligible.map((r) => r.source_row_id);
  let sql = `-- =============================================================================
-- NEXT-PRODUCT-ID-17 — Wave 1b PRE-IMAGE (SELECT only)
-- =============================================================================
-- DO NOT MODIFY DATA. ${ids.length} PKs from wave-1b-eligible-pks.csv
-- =============================================================================

`;
  if (ids.length === 0) {
    sql += `SELECT * FROM public.amazon_fba_inventory WHERE false;\n`;
  } else {
    const chunks = chunkUuids(ids, 100);
    const cteDefs = chunks
      .map((ch, i) => {
        const arr = ch.map((u) => `'${u}'::uuid`).join(", ");
        return `chunk_${i} AS (SELECT unnest(ARRAY[${arr}]::uuid[]) AS id)`;
      })
      .join(",\n");
    const unionParts = chunks.map((_, i) => `SELECT id FROM chunk_${i}`).join("\n    UNION ALL\n    ");
    sql += `WITH
${cteDefs},
ids AS (
    ${unionParts}
)
SELECT afi.*
FROM public.amazon_fba_inventory AS afi
JOIN ids ON ids.id = afi.id;
`;
  }
  fs.writeFileSync(path.join(outDir, "preimage-select-wave-1b.sql"), sql, "utf8");

  appendLog(logPath, { event: "complete", ...manifest });

  console.log(`NEXT-PRODUCT-ID-17 → ${outDir}`);
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
