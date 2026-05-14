/**
 * NEXT-PRODUCT-ID-17B — Wave 1b preimage verification + signoff package (read-only).
 *
 *   npx tsx scripts/next-product-id-17b-preimage-signoff-pack.ts
 *
 * No DB writes. Writes audit artifacts under .cursor/audit-reports/next-product-id-17b/<run_id>/.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { mkRunDir, mkRunId, writeCsv, writeJson } from "../lib/audits/product-seed-output";

const ID17_RUN = path.join(
  process.cwd(),
  ".cursor/audit-reports/next-product-id-17/20260514T020926Z",
);
const ID17_DRY = path.join(ID17_RUN, "product-seed-dry-run", "20260514T020928Z");
const WAVE1B_ELIGIBLE = path.join(ID17_RUN, "wave-1b-eligible-pks.csv");
const WAVE1B_BLOCKED = path.join(ID17_RUN, "wave-1b-blocked-pks.csv");
const WAVE1A_CSV = path.join(
  process.cwd(),
  ".cursor/audit-reports/next-product-id-11/20260513T231500Z/wave-1a-eligible-pks.csv",
);

type EligibleRow = {
  source_row_id: string;
  organization_id: string;
  store_id: string | null;
  bucket_id: number;
  match_rank: number;
  existing_product_id_hit: string;
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

function parseEligibleCsv(): EligibleRow[] {
  const raw = fs.readFileSync(WAVE1B_ELIGIBLE, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(",").map((h) => h.trim());
  const iId = header.indexOf("source_row_id");
  const iOrg = header.indexOf("organization_id");
  const iStore = header.indexOf("store_id");
  const iB = header.indexOf("bucket_id");
  const iR = header.indexOf("match_rank");
  const iHit = header.indexOf("existing_product_id_hit");
  const out: EligibleRow[] = [];
  for (let n = 1; n < lines.length; n++) {
    const parts = lines[n].split(",");
    out.push({
      source_row_id: parts[iId].trim(),
      organization_id: parts[iOrg].trim(),
      store_id: iStore >= 0 ? (parts[iStore]?.trim() || null) : null,
      bucket_id: parseInt(parts[iB], 10),
      match_rank: parseInt(parts[iR], 10),
      existing_product_id_hit: parts[iHit].trim(),
    });
  }
  return out;
}

function loadUuidSetFromCsv(filePath: string, col: string): Set<string> {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(",").map((h) => h.trim());
  const idx = header.indexOf(col);
  const s = new Set<string>();
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const v = parts[idx]?.trim();
    if (v) s.add(v);
  }
  return s;
}

function parseCsvUuidColumn(filePath: string, colName: string): Set<string> {
  if (!fs.existsSync(filePath)) return new Set();
  return loadUuidSetFromCsv(filePath, colName);
}

function loadNdjsonRowsById(ndPath: string): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>();
  if (!fs.existsSync(ndPath)) return m;
  for (const line of fs.readFileSync(ndPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as Record<string, unknown>;
    const id = String(o.source_row_id ?? "");
    if (id) m.set(id, o);
  }
  return m;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

type DbRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  product_name: string | null;
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
  identifier_resolution_status: string | null;
  identifier_resolution_confidence: number | null;
  updated_at: string | null;
};

const SELECT_COLS =
  "id, organization_id, store_id, sku, fnsku, asin, product_name, resolved_product_id, resolved_catalog_product_id, identifier_resolution_status, identifier_resolution_confidence, updated_at";

async function fetchByIds(sb: SupabaseClient, ids: string[]): Promise<DbRow[]> {
  const all: DbRow[] = [];
  for (const batch of chunk(ids, 100)) {
    const { data, error } = await sb
      .from("amazon_fba_inventory")
      .select(SELECT_COLS)
      .in("id", batch);
    if (error) throw new Error(error.message);
    all.push(...((data ?? []) as DbRow[]));
  }
  return all;
}

function appendLog(p: string, o: Record<string, unknown>): void {
  fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n", "utf8");
}

function buildPreimageSql(ids: string[]): string {
  const header = `-- NEXT-PRODUCT-ID-17B — Wave 1b preimage (SELECT only)
-- ${ids.length} PKs from wave-1b-eligible-pks.csv
-- Columns: ${SELECT_COLS.replace(/,/g, ",")}
`;
  if (ids.length === 0) return `${header}\nSELECT ${SELECT_COLS} FROM public.amazon_fba_inventory WHERE false;\n`;
  const parts = chunk(ids, 100).map((ch, i) => {
    const arr = ch.map((u) => `'${u}'::uuid`).join(", ");
    return `chunk_${i} AS (SELECT unnest(ARRAY[${arr}]::uuid[]) AS id)`;
  });
  const union = chunk(ids, 100)
    .map((_, i) => `SELECT id FROM chunk_${i}`)
    .join("\n    UNION ALL\n    ");
  return `${header}
WITH
${parts.join(",\n")},
ids AS (
    ${union}
)
SELECT ${SELECT_COLS.split(", ").map((c) => `afi.${c}`).join(", ")}
FROM public.amazon_fba_inventory AS afi
JOIN ids ON ids.id = afi.id
ORDER BY afi.id;
`;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const runId = mkRunId();
  const outDir = mkRunDir(path.join(".cursor", "audit-reports", "next-product-id-17b"), runId);
  const logPath = path.join(outDir, "logs", "product-id-17b.ndjson");
  appendLog(logPath, { event: "start", runId });

  const eligible = parseEligibleCsv();
  const wave1aIds = loadUuidSetFromCsv(WAVE1A_CSV, "source_row_id");
  const crossIds = parseCsvUuidColumn(path.join(ID17_DRY, "03-cross-product-conflict.csv"), "source_row_id");
  const gapIds = parseCsvUuidColumn(path.join(ID17_DRY, "04-provenance-gap.csv"), "source_row_id");
  const dryRows = loadNdjsonRowsById(path.join(ID17_DRY, "01-rows.ndjson"));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const expectedCount = eligible.length;
  const ids = eligible.map((e) => e.source_row_id);
  const byCsv = new Map(eligible.map((e) => [e.source_row_id, e]));

  const dbRows = await fetchByIds(sb, ids);
  appendLog(logPath, { event: "db_fetch", rowCount: dbRows.length });

  const issues: string[] = [];
  if (dbRows.length !== expectedCount) issues.push(`db_row_count_mismatch:expected_${expectedCount}_got_${dbRows.length}`);

  function rowResolverClear(r: DbRow): boolean {
    return (
      r.resolved_product_id == null &&
      r.resolved_catalog_product_id == null &&
      (r.identifier_resolution_status == null || r.identifier_resolution_status === "") &&
      r.identifier_resolution_confidence == null
    );
  }
  const unclearRows = dbRows.filter((r) => !rowResolverClear(r));

  let orgStoreMismatchRows = 0;
  for (const r of dbRows) {
    const ex = byCsv.get(r.id);
    if (!ex) {
      issues.push(`missing_csv_row:${r.id}`);
      continue;
    }
    if (r.organization_id !== ex.organization_id || (r.store_id ?? null) !== (ex.store_id ?? null)) orgStoreMismatchRows++;
  }

  if (unclearRows.length > 0) issues.push(`resolver_fields_not_clear:${unclearRows.length}`);
  if (orgStoreMismatchRows > 0) issues.push(`org_store_mismatch_rows:${orgStoreMismatchRows}`);

  const nullResolverStrict = unclearRows.length === 0 && dbRows.length > 0;

  let wave1aOverlap = 0;
  let crossOverlap = 0;
  let gapOverlap = 0;
  let dryRunFanout = 0;
  let missingDryRow = 0;

  for (const id of ids) {
    if (wave1aIds.has(id)) wave1aOverlap++;
    if (crossIds.has(id)) crossOverlap++;
    if (gapIds.has(id)) gapOverlap++;
    const dr = dryRows.get(id);
    if (!dr) missingDryRow++;
    else {
      const sec = dr.secondary_reasons as string[] | undefined;
      if (Array.isArray(sec) && sec.some((s) => String(s).startsWith("f1_identifier_fan_out"))) dryRunFanout++;
    }
  }

  if (wave1aOverlap > 0) issues.push(`wave_1a_overlap:${wave1aOverlap}`);
  if (crossOverlap > 0) issues.push(`cross_product_csv_overlap:${crossOverlap}`);
  if (gapOverlap > 0) issues.push(`provenance_gap_overlap:${gapOverlap}`);
  if (dryRunFanout > 0) issues.push(`dry_run_secondary_fanout:${dryRunFanout}`);
  if (missingDryRow > 0) issues.push(`missing_dry_run_row:${missingDryRow}`);

  let productHitMismatch = 0;
  for (const id of ids) {
    const dr = dryRows.get(id);
    const ex = byCsv.get(id);
    if (dr && ex) {
      const hit = String(dr.existing_product_id_hit ?? "").trim();
      if (hit !== ex.existing_product_id_hit) productHitMismatch++;
    }
  }
  if (productHitMismatch > 0) issues.push(`existing_product_id_hit_mismatch_vs_dry_run:${productHitMismatch}`);

  const scopePass =
    issues.length === 0 &&
    dbRows.length === 144 &&
    nullResolverStrict &&
    wave1aOverlap === 0 &&
    crossOverlap === 0 &&
    gapOverlap === 0 &&
    dryRunFanout === 0 &&
    missingDryRow === 0 &&
    productHitMismatch === 0;

  const preimageCsvRows = dbRows.map((r) => ({ ...r } as Record<string, unknown>));
  writeCsv(path.join(outDir, "wave-1b-preimage-export.csv"), SELECT_COLS.split(", ") as unknown as string[], preimageCsvRows);

  fs.writeFileSync(path.join(outDir, "wave-1b-preimage-select-columns.sql"), buildPreimageSql(ids), "utf8");

  const manifest = {
    auditPrompt: "NEXT-PRODUCT-ID-17B",
    runId,
    eligibleCsvCount: expectedCount,
    preimageDbRowCount: dbRows.length,
    wave1aOverlapCount: wave1aOverlap,
    crossCsvOverlapCount: crossOverlap,
    provenanceGapOverlapCount: gapOverlap,
    dryRunFanoutOnEligible: dryRunFanout,
    missingDryRunRowCount: missingDryRow,
    dryRunProductHitMismatchCount: productHitMismatch,
    resolverFieldsAllNullStrict: nullResolverStrict && dbRows.length === 144,
    scopeIntegrityPass: scopePass,
    signoffStatus: scopePass ? "READY_FOR_OWNER_SIGNOFF" : "BLOCKED",
    mayProceedTo17cPrompt: scopePass,
    inputs: {
      nextProductId17: ".cursor/audit-reports/next-product-id-17/20260514T020926Z/",
      nextProductId16: ".cursor/audit-reports/next-product-id-16/20260514T015711Z/",
      nextProductId15: ".cursor/audit-reports/next-product-id-15/20260514T014702Z/",
    },
    validation: {
      noDbWrites: true,
      noUpdateInsertDelete: true,
      noAmazonApi: true,
      noOpenAi: true,
    },
  };
  writeJson(path.join(outDir, "manifest.json"), manifest);
  appendLog(logPath, { event: "manifest", ...manifest });

  fs.writeFileSync(
    path.join(outDir, "wave-1b-preimage-summary.md"),
    `# Wave 1b preimage summary — NEXT-PRODUCT-ID-17B

**Run ID:** \`${runId}\`

| Check | Result |
|-------|--------|
| Eligible PKs (CSV) | ${expectedCount} |
| Rows returned from DB | ${dbRows.length} |
| \`resolved_product_id\` / \`resolved_catalog_product_id\` / status / confidence all null | **${nullResolverStrict && dbRows.length === 144 ? "YES" : "NO"}** |
| Overlap with Wave 1a PK set | ${wave1aOverlap} |
| Overlap with dry-run \`03-cross-product-conflict.csv\` | ${crossOverlap} |
| Overlap with dry-run \`04-provenance-gap.csv\` | ${gapOverlap} |
| Eligible rows with \`f1_identifier_fan_out\` in dry-run \`01-rows.ndjson\` | ${dryRunFanout} |
| Missing row in dry-run NDJSON | ${missingDryRow} |
| Org/store mismatch vs CSV | ${orgStoreMismatchRows} |
| \`existing_product_id_hit\` (CSV vs dry-run NDJSON) | ${productHitMismatch === 0 ? "OK" : "FAIL (" + productHitMismatch + ")"} |

## Artifacts

- **Preimage CSV (this run):** \`wave-1b-preimage-export.csv\` (${dbRows.length} rows)
- **Preimage SQL (column-explicit):** \`wave-1b-preimage-select-columns.sql\`

## Issues

${issues.length ? issues.map((x) => `- \`${x}\``).join("\n") : "- (none)"}
`,
    "utf8",
  );

  const blockedLines = fs.readFileSync(WAVE1B_BLOCKED, "utf8").split(/\r?\n/).filter((l) => l.trim()).length;
  const blockedCount = Math.max(0, blockedLines - 1);

  fs.writeFileSync(
    path.join(outDir, "wave-1b-blocked-summary.md"),
    `# Wave 1b blocked summary — NEXT-PRODUCT-ID-17B

Source: [NEXT-PRODUCT-ID-17 \`wave-1b-blocked-pks.csv\`](../next-product-id-17/20260514T020926Z/wave-1b-blocked-pks.csv)

| Metric | Value |
|--------|------:|
| Blocked CSV data rows | ${blockedCount} |
| Unresolved pool (from ID-17) | 311 |
| Wave 1b eligible | 144 |

Blocked rows are **not** in the Wave 1b preimage / UPDATE scope.
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "wave-1b-scope-integrity.md"),
    `# Wave 1b scope integrity — NEXT-PRODUCT-ID-17B

## Verdict

**${scopePass ? "PASS" : "FAIL"}**

## Rules checked

1. Exactly **144** eligible PKs from CSV; DB returned **${dbRows.length}** rows.
2. All eligible rows **unresolved** (resolver columns null / empty before UPDATE).
3. **Zero** PK overlap with Wave 1a eligible set ([\`wave-1a-eligible-pks.csv\`](../next-product-id-11/20260513T231500Z/wave-1a-eligible-pks.csv)).
4. **Zero** PK overlap with cross-product and provenance-gap CSVs from ID-17 dry-run.
5. **Zero** dry-run \`f1_identifier_fan_out\` secondaries on eligible IDs (matches ID-17 eligibility gate).
6. \`existing_product_id_hit\` in dry-run NDJSON matches CSV for every eligible PK (mismatches: **${productHitMismatch}**).
7. \`organization_id\` / \`store_id\` match CSV for fetched rows (mismatch rows: **${orgStoreMismatchRows}**).

${scopePass ? "Wave 1b staged UPDATE prompt **may** be authored as NEXT-PRODUCT-ID-17C after owner signoff + attachment policy below." : "**Do not** proceed to 17C until issues are cleared."}
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "wave-1b-signoff-form_TO_FILL.md"),
    `# Wave 1b signoff form (TO FILL) — NEXT-PRODUCT-ID-17B

<!-- markdownlint-disable MD013 MD060 -->

## Wave metadata

| Field | Value |
|-------|--------|
| Wave name | Amazon FBA inventory — Wave 1b resolver backfill |
| Eligibility pack (NEXT-PRODUCT-ID-17) | \`20260514T020926Z\` |
| Preimage / signoff pack (NEXT-PRODUCT-ID-17B) | \`${runId}\` |
| Eligible PK count | 144 |
| Target database | __________________ (project ref / URL) |

## Automated checks (this pack)

| Check | Required | Actual |
|-------|----------|--------|
| DB preimage row count | 144 | ${dbRows.length} |
| Resolver fields null | all | ${nullResolverStrict ? "all null" : "see preimage-summary"} |
| Wave 1a overlap | 0 | ${wave1aOverlap} |
| Cross-product CSV overlap | 0 | ${crossOverlap} |
| Provenance gap overlap | 0 | ${gapOverlap} |
| Dry-run fan-out on eligible | 0 | ${dryRunFanout} |
| \`existing_product_id_hit\` CSV vs NDJSON mismatches | 0 | ${productHitMismatch} |
| Scope integrity | PASS | **${scopePass ? "PASS" : "FAIL"}** |

## Approvals (required before NEXT-PRODUCT-ID-17C)

| Role | Name | Date | Signature / link |
|------|------|------|-------------------|
| Product owner | | | |
| Data / resolver owner | | | |
| Engineering (executor) | | | |

## Attachments checklist

- [ ] \`wave-1b-preimage-export.csv\` from this run **or** equivalent export from \`wave-1b-preimage-select-columns.sql\`
- [ ] Confirmation **144** PKs and resolver fields **null** pre-update
- [ ] Confirmation **zero** overlap with Wave 1a PK set
- [ ] Link to [NEXT-PRODUCT-ID-15](../next-product-id-15/20260514T014702Z/) execution pattern for rollback discipline
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "wave-1b-staged-update-readiness.md"),
    `# Wave 1b staged UPDATE readiness — NEXT-PRODUCT-ID-17B

## Gate (all must be true before 17C)

| # | Gate | Status |
|---|------|--------|
| 1 | Preimage CSV attached / archived | **Operator** |
| 2 | Signoff form complete (all roles) | **Operator** |
| 3 | Row count = 144 | **${dbRows.length === 144 ? "OK" : "FAIL"}** |
| 4 | Scope integrity PASS | **${scopePass ? "PASS" : "FAIL"}** |

**Automated signoff status:** \`${manifest.signoffStatus}\`

**May create NEXT-PRODUCT-ID-17C prompt:** ${scopePass ? "**Yes** (after human signoff + attachment)" : "**No** (fix blockers first)"}
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "next-step-recommendation.md"),
    `# Next step — NEXT-PRODUCT-ID-17B

${scopePass ? `1. Owners complete [\`wave-1b-signoff-form_TO_FILL.md\`](./wave-1b-signoff-form_TO_FILL.md).\n2. Attach/export preimage (\`wave-1b-preimage-export.csv\` or SQL export).\n3. Run **NEXT-PRODUCT-ID-17C** — Wave 1b staged \`UPDATE\` + verify (mirror NEXT-PRODUCT-ID-15).` : `1. Investigate issues listed in [\`wave-1b-preimage-summary.md\`](./wave-1b-preimage-summary.md).\n2. Re-run this pack after data or CSV corrections.`}

\`\`\`text
NEXT-PRODUCT-ID-17C — Wave 1b staged UPDATE for amazon_fba_inventory using
.cursor/audit-reports/next-product-id-17/20260514T020926Z/wave-1b-eligible-pks.csv;
preimage + post-verify; no other tables.
\`\`\`
`,
    "utf8",
  );

  appendLog(logPath, { event: "complete", outDir });
  console.log(`NEXT-PRODUCT-ID-17B → ${outDir}`);
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
