/**
 * Spreadsheet identifier-map link dryrun (read-only).
 *
 *   npx tsx scripts/product-spreadsheet-identifier-map-link-dryrun.ts
 *   npx tsx scripts/product-spreadsheet-identifier-map-link-dryrun.ts --plan-run-id=20260529T210000Z
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const PLAN_BASE = ".cursor/audit-reports/product-spreadsheet-missing-product-link-plan";
const OUT_BASE = ".cursor/audit-reports/product-spreadsheet-identifier-map-link-dryrun";
const MATCH_SOURCE = "spreadsheet_dimensions_seller_sku_link";
const SOURCE_REPORT_TYPE = "spreadsheet_dimensions";
const CONFIDENCE = 0.9;

const SAM_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SAM_STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

type PlanCandidate = {
  spreadsheet_row: number;
  seller_sku: string;
  sheet_asin: string | null;
  sheet_fnsku: string | null;
  unit_upc: string | null;
  case_upc: string | null;
  brand: string | null;
  candidate_product_id: string;
};

type ValidationResult =
  | "pass_proposed_insert"
  | "excluded_already_linked"
  | "excluded_conflict"
  | "excluded_validation_failed";

type RowResult = PlanCandidate & {
  validation_status: ValidationResult;
  exclusion_reason: string | null;
  evidence_path: string | null;
  organization_id: string;
  store_id: string;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function planRunArg(): string {
  const a = process.argv.find((x) => x.startsWith("--plan-run-id="));
  if (a) return a.split("=")[1]!.trim();
  const base = path.join(process.cwd(), PLAN_BASE);
  if (!fs.existsSync(base)) return "20260529T210000Z";
  const runs = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, "manifest.json"))).sort().reverse();
  return runs[0] ?? "20260529T210000Z";
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if (c === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function loadCandidates(planDir: string): PlanCandidate[] {
  const csvPath = path.join(planDir, "identifier-map-candidates.csv");
  const text = fs.readFileSync(csvPath, "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]!);
  const idx = (name: string) => header.indexOf(name);
  return lines.slice(1).map((line) => {
    const cols = parseCsvLine(line);
    const pick = (name: string) => {
      const i = idx(name);
      const v = i >= 0 ? cols[i]?.trim() : "";
      return v || null;
    };
    return {
      spreadsheet_row: Number(cols[idx("spreadsheet_row")]),
      seller_sku: pick("seller_sku") ?? "",
      sheet_asin: pick("sheet_asin")?.toUpperCase() ?? null,
      sheet_fnsku: pick("sheet_fnsku")?.toUpperCase() ?? null,
      unit_upc: pick("unit_upc")?.replace(/\D/g, "") || null,
      case_upc: pick("case_upc")?.replace(/\D/g, "") || null,
      brand: pick("brand"),
      candidate_product_id: pick("candidate_product_id") ?? "",
    };
  });
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(filePath: string, headers: string[], rows: Record<string, unknown>[]): void {
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
}

function pushIndex(map: Map<string, Set<string>>, key: string | null | undefined, id: string): void {
  if (!key?.trim()) return;
  const k = key.trim();
  const s = map.get(k) ?? new Set();
  s.add(id);
  map.set(k, s);
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const planRunId = planRunArg();
  const planDir = path.join(process.cwd(), PLAN_BASE, planRunId);
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = dbUrl ? refFromSupabaseUrl(dbUrl) || getStagingProjectRef({ loadEnv: false }) : STAGING_REF;

  const blockers: string[] = [];
  if (!fs.existsSync(path.join(planDir, "identifier-map-candidates.csv"))) {
    blockers.push(`Missing plan: ${planDir}/identifier-map-candidates.csv`);
  }
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else if (ref !== STAGING_REF) blockers.push(`Target must be staging ${STAGING_REF}`);

  const candidates = loadCandidates(planDir);
  const results: RowResult[] = [];
  let orgId = SAM_ORG_ID;
  let storeId = SAM_STORE_ID;

  const productsByAsin = new Map<string, Set<string>>();
  const productsByFnsku = new Map<string, Set<string>>();
  const productsByUpc = new Map<string, Set<string>>();
  const productsBySku = new Map<string, Set<string>>();
  const validProductIds = new Set<string>();
  const mapBySellerSku = new Map<string, Set<string>>();
  const mapByAsin = new Map<string, Set<string>>();
  const mapByFnsku = new Map<string, Set<string>>();
  const mapByUpc = new Map<string, Set<string>>();

  if (blockers.length === 0) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    const storeRow = await client.query(`SELECT id::text, organization_id::text FROM public.stores WHERE id = $1::uuid`, [
      SAM_STORE_ID,
    ]);
    orgId = storeRow.rows[0]?.organization_id != null ? String(storeRow.rows[0].organization_id) : SAM_ORG_ID;
    storeId = storeRow.rows[0]?.id != null ? String(storeRow.rows[0].id) : SAM_STORE_ID;

    const pr = await client.query(
      `SELECT id::text, sku, asin, fnsku, upc_code, barcode
       FROM public.products
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`,
      [orgId, storeId],
    );
    for (const row of pr.rows as Record<string, string | null>[]) {
      const id = String(row.id);
      validProductIds.add(id);
      if (row.sku) pushIndex(productsBySku, String(row.sku).trim(), id);
      if (row.asin) pushIndex(productsByAsin, String(row.asin).trim().toUpperCase(), id);
      if (row.fnsku) pushIndex(productsByFnsku, String(row.fnsku).trim().toUpperCase(), id);
      if (row.upc_code) pushIndex(productsByUpc, String(row.upc_code).replace(/\D/g, ""), id);
      if (row.barcode) pushIndex(productsByUpc, String(row.barcode).replace(/\D/g, ""), id);
    }

    const mr = await client.query(
      `SELECT product_id::text, seller_sku, msku, asin, fnsku, upc_code
       FROM public.product_identifier_map
       WHERE organization_id = $1::uuid AND deleted_at IS NULL
         AND (store_id = $2::uuid OR store_id IS NULL)`,
      [orgId, storeId],
    );
    for (const row of mr.rows as Record<string, string | null>[]) {
      const pid = String(row.product_id ?? "");
      if (!pid) continue;
      if (row.seller_sku) pushIndex(mapBySellerSku, String(row.seller_sku).trim(), pid);
      if (row.msku) pushIndex(mapBySellerSku, String(row.msku).trim(), pid);
      if (row.asin) pushIndex(mapByAsin, String(row.asin).trim().toUpperCase(), pid);
      if (row.fnsku) pushIndex(mapByFnsku, String(row.fnsku).trim().toUpperCase(), pid);
      if (row.upc_code) pushIndex(mapByUpc, String(row.upc_code).replace(/\D/g, ""), pid);
    }

    await client.end();
  }

  const seenSellerSku = new Map<string, number>();

  for (const c of candidates) {
    const base: RowResult = {
      ...c,
      validation_status: "excluded_validation_failed",
      exclusion_reason: null,
      evidence_path: null,
      organization_id: orgId,
      store_id: storeId,
    };

    if (blockers.length > 0) {
      base.exclusion_reason = blockers.join("; ");
      results.push(base);
      continue;
    }

    const sku = c.seller_sku.trim();
    if (!sku) {
      base.exclusion_reason = "missing_seller_sku";
      results.push(base);
      continue;
    }
    if (!isUuid(c.candidate_product_id)) {
      base.exclusion_reason = "invalid_candidate_product_id";
      results.push(base);
      continue;
    }
    if (!validProductIds.has(c.candidate_product_id)) {
      base.exclusion_reason = "candidate_product_not_found_or_deleted";
      results.push(base);
      continue;
    }

    const dupRow = seenSellerSku.get(sku);
    if (dupRow != null) {
      base.validation_status = "excluded_conflict";
      base.exclusion_reason = `duplicate_seller_sku_in_batch_first_row_${dupRow}`;
      results.push(base);
      continue;
    }
    seenSellerSku.set(sku, c.spreadsheet_row);

    const productSkuHits = productsBySku.get(sku);
    if (productSkuHits?.size) {
      if (productSkuHits.size > 1 || [...productSkuHits][0] !== c.candidate_product_id) {
        base.validation_status = "excluded_conflict";
        base.exclusion_reason = "products_sku_already_exists_different_product";
        results.push(base);
        continue;
      }
      base.validation_status = "excluded_already_linked";
      base.exclusion_reason = "products_sku_already_matches_candidate_no_map_insert_needed";
      base.evidence_path = "products.sku";
      results.push(base);
      continue;
    }

    const mapSkuHits = mapBySellerSku.get(sku);
    if (mapSkuHits?.size) {
      if (mapSkuHits.size > 1) {
        base.validation_status = "excluded_conflict";
        base.exclusion_reason = `map_seller_sku_ambiguous_${mapSkuHits.size}`;
        results.push(base);
        continue;
      }
      const mapped = [...mapSkuHits][0]!;
      if (mapped === c.candidate_product_id) {
        base.validation_status = "excluded_already_linked";
        base.exclusion_reason = "map_seller_sku_already_points_to_candidate";
        base.evidence_path = "product_identifier_map.seller_sku";
        results.push(base);
        continue;
      }
      base.validation_status = "excluded_conflict";
      base.exclusion_reason = `map_seller_sku_points_to_other_product_${mapped}`;
      results.push(base);
      continue;
    }

    const resolvedIds = new Set<string>();
    const evidenceParts: string[] = [];
    const addHits = (label: string, map: Map<string, Set<string>>, key: string | null) => {
      if (!key) return;
      const fromProducts =
        label.startsWith("asin") ? productsByAsin :
        label.startsWith("fnsku") ? productsByFnsku :
        productsByUpc;
      const fromMap =
        label.startsWith("asin") ? mapByAsin :
        label.startsWith("fnsku") ? mapByFnsku :
        mapByUpc;
      const pHits = fromProducts.get(key);
      const mHits = fromMap.get(key);
      if (pHits?.size) {
        evidenceParts.push(`products.${label}:${pHits.size}`);
        for (const id of pHits) resolvedIds.add(id);
      }
      if (mHits?.size) {
        evidenceParts.push(`map.${label}:${mHits.size}`);
        for (const id of mHits) resolvedIds.add(id);
      }
    };

    addHits("asin", mapByAsin, c.sheet_asin);
    addHits("fnsku", mapByFnsku, c.sheet_fnsku);
    const upc = c.unit_upc ?? c.case_upc;
    addHits("upc", mapByUpc, upc);

    if (resolvedIds.size === 0) {
      base.exclusion_reason = "no_deterministic_identifier_evidence_recheck_failed";
      results.push(base);
      continue;
    }
    if (resolvedIds.size > 1) {
      base.validation_status = "excluded_conflict";
      base.exclusion_reason = `multi_product_identifier_evidence_${[...resolvedIds].join("|")}`;
      results.push(base);
      continue;
    }
    const resolved = [...resolvedIds][0]!;
    if (resolved !== c.candidate_product_id) {
      base.validation_status = "excluded_conflict";
      base.exclusion_reason = `recheck_product_mismatch_plan_${c.candidate_product_id}_resolved_${resolved}`;
      results.push(base);
      continue;
    }

    if (c.sheet_asin && c.sheet_fnsku) base.evidence_path = "asin+fnsku";
    else if (c.sheet_asin) base.evidence_path = "asin";
    else if (c.sheet_fnsku) base.evidence_path = "fnsku";
    else if (upc) base.evidence_path = "upc";
    else base.evidence_path = evidenceParts.join(";");

    base.validation_status = "pass_proposed_insert";
    base.exclusion_reason = null;
    results.push(base);
  }

  const pass = results.filter((r) => r.validation_status === "pass_proposed_insert");
  const alreadyLinked = results.filter((r) => r.validation_status === "excluded_already_linked");
  const excluded = results.filter(
    (r) => r.validation_status === "excluded_conflict" || r.validation_status === "excluded_validation_failed",
  );

  const insertHeaders = [
    "spreadsheet_row",
    "organization_id",
    "store_id",
    "product_id",
    "seller_sku",
    "asin",
    "fnsku",
    "upc_code",
    "match_source",
    "source_report_type",
    "confidence_score",
    "resolution_notes",
    "evidence_path",
  ];

  const proposedInserts = pass.map((r) => ({
    spreadsheet_row: r.spreadsheet_row,
    organization_id: r.organization_id,
    store_id: r.store_id,
    product_id: r.candidate_product_id,
    seller_sku: r.seller_sku,
    asin: r.sheet_asin,
    fnsku: r.sheet_fnsku,
    upc_code: r.unit_upc ?? r.case_upc,
    match_source: MATCH_SOURCE,
    source_report_type: SOURCE_REPORT_TYPE,
    confidence_score: CONFIDENCE,
    resolution_notes: `spreadsheet_row=${r.spreadsheet_row};plan=${planRunId};dryrun=${runId}`,
    evidence_path: r.evidence_path,
  }));

  writeCsv(path.join(outDir, "proposed-identifier-map-inserts.csv"), insertHeaders, proposedInserts);

  const excludedRows = [...excluded, ...alreadyLinked].map((r) => ({
    spreadsheet_row: r.spreadsheet_row,
    seller_sku: r.seller_sku,
    sheet_asin: r.sheet_asin,
    sheet_fnsku: r.sheet_fnsku,
    candidate_product_id: r.candidate_product_id,
    validation_status: r.validation_status,
    exclusion_reason: r.exclusion_reason,
  }));
  writeCsv(
    path.join(outDir, "excluded-conflicts.csv"),
    ["spreadsheet_row", "seller_sku", "sheet_asin", "sheet_fnsku", "candidate_product_id", "validation_status", "exclusion_reason"],
    excludedRows,
  );

  const rollbackSql = `-- Rollback for spreadsheet identifier-map link apply (staging only)
-- Batch: ${MATCH_SOURCE} / dryrun ${runId}
-- Rows: ${pass.length} proposed inserts

-- Preview rows before delete:
-- SELECT id, seller_sku, product_id, match_source, resolution_notes
-- FROM public.product_identifier_map
-- WHERE organization_id = '${orgId}'::uuid
--   AND store_id = '${storeId}'::uuid
--   AND match_source = '${MATCH_SOURCE}'
--   AND resolution_notes LIKE '%dryrun=${runId}%'
--   AND deleted_at IS NULL;

-- DELETE (use only after failed apply verification):
-- UPDATE public.product_identifier_map
-- SET deleted_at = now(), updated_at = now()
-- WHERE organization_id = '${orgId}'::uuid
--   AND store_id = '${storeId}'::uuid
--   AND match_source = '${MATCH_SOURCE}'
--   AND resolution_notes LIKE '%dryrun=${runId}%'
--   AND deleted_at IS NULL;
`;

  fs.writeFileSync(
    path.join(outDir, "dryrun-summary.md"),
    `# Identifier-map link dryrun summary

**Run:** \`${OUT_BASE}/${runId}/\`  
**Source plan:** \`${PLAN_BASE}/${planRunId}/\`  
**Staging:** \`${STAGING_REF}\` · org \`${orgId}\` · store \`${storeId}\`  
**Branch:** \`${branch}\`  
**Mode:** read-only dryrun · **no DB writes**

## Counts

| Metric | Count |
|--------|------:|
| Path-A candidates loaded | **${candidates.length}** |
| **Pass — proposed map INSERT** | **${pass.length}** |
| Already linked (no insert) | ${alreadyLinked.length} |
| Excluded (conflict / validation) | ${excluded.length} |

## Match source tag (apply batch)

\`${MATCH_SOURCE}\`

## Forbidden (unchanged)

- No \`products\` INSERT/UPDATE
- No packaging / vendor / brand writes
- No spreadsheet product auto-create
- No product_name merge
`,
  );

  fs.writeFileSync(
    path.join(outDir, "validation-results.md"),
    `# Validation results

Each Path-A candidate was re-checked against staging **read-only**.

## Checks

| Check | Rule |
|-------|------|
| Product exists | \`products.id\` active under org+store |
| Deterministic evidence | ASIN/FNSKU/UPC resolves to exactly one \`products.id\` matching plan candidate |
| No SKU collision | \`products.sku\` must not exist for another product |
| No map conflict | \`product_identifier_map.seller_sku\` must not point to a different \`product_id\` |
| No batch duplicate | Duplicate \`seller_sku\` in cohort excluded |
| Already linked | Existing \`products.sku\` or map row → excluded from insert (idempotent) |

## Outcome

| Status | Count |
|--------|------:|
| pass_proposed_insert | ${pass.length} |
| excluded_already_linked | ${alreadyLinked.length} |
| excluded_conflict | ${results.filter((r) => r.validation_status === "excluded_conflict").length} |
| excluded_validation_failed | ${results.filter((r) => r.validation_status === "excluded_validation_failed").length} |

## Top exclusion reasons

${Object.entries(
  excludedRows.reduce<Record<string, number>>((acc, r) => {
    const key = String(r.exclusion_reason ?? "unknown").split("_").slice(0, 3).join("_");
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {}),
)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .map(([k, v]) => `- \`${k}…\`: ${v}`)
  .join("\n")}
`,
  );

  fs.writeFileSync(
    path.join(outDir, "proposed-apply-plan.md"),
    `# Proposed apply plan (not executed)

## Scope

Insert **${pass.length}** rows into \`product_identifier_map\` on staging only.

## Row shape

| Column | Value |
|--------|-------|
| organization_id | Sam org |
| store_id | Sam store |
| product_id | Existing \`products.id\` (validated) |
| seller_sku | Spreadsheet seller-sku |
| asin / fnsku / upc_code | From sheet when present |
| match_source | \`${MATCH_SOURCE}\` |
| source_report_type | \`${SOURCE_REPORT_TYPE}\` |
| confidence_score | ${CONFIDENCE} |
| resolution_notes | \`spreadsheet_row=N;plan=${planRunId};dryrun=${runId}\` |

## SQL pattern (illustrative — do not run from dryrun)

\`\`\`sql
INSERT INTO public.product_identifier_map (
  organization_id, store_id, product_id, seller_sku, asin, fnsku, upc_code,
  match_source, source_report_type, confidence_score, resolution_notes
) VALUES (
  $org, $store, $product_id, $seller_sku, $asin, $fnsku, $upc,
  '${MATCH_SOURCE}', '${SOURCE_REPORT_TYPE}', ${CONFIDENCE}, $notes
);
\`\`\`

## Rollback

See soft-delete rollback block in this run folder (apply script should emit \`rollback.sql\`).

\`\`\`sql
${rollbackSql.trim()}
\`\`\`

## Post-apply verification

1. Count map rows with \`match_source = '${MATCH_SOURCE}'\` = **${pass.length}**
2. Re-run \`product-spreadsheet-staging-match-census-dryrun\` — expect packaging candidates > 0
3. Do **not** run packaging import in same transaction
`,
  );

  fs.writeFileSync(path.join(outDir, "rollback-reference.sql"), rollbackSql);

  fs.writeFileSync(
    path.join(outDir, "required-approval-file.md"),
    `# Required operator approval (before staging apply)

Create or update:

\`.cursor/operator-approvals/spreadsheet-identifier-map-link-staging-approval.md\`

\`\`\`text
APPROVED_TO_RUN_STAGING=false
APPROVED_SPREADSHEET_IDENTIFIER_MAP_LINK=false
\`\`\`

## Allowed when approved

| Allowed | Forbidden |
|---------|-----------|
| Staging INSERT \`product_identifier_map\` only (${pass.length} rows) | \`products\` INSERT/UPDATE |
| Batch \`match_source=${MATCH_SOURCE}\` | Packaging tables |
| Read \`proposed-identifier-map-inserts.csv\` from this dryrun | Vendor/brand updates |
| Post-insert verify count | Original/current DB |

## Preconditions

- [ ] Review \`${OUT_BASE}/${runId}/\`
- [ ] Confirm pass count **${pass.length}** matches operator expectation
- [ ] Confirm excluded count **${excluded.length + alreadyLinked.length}** reviewed
- [ ] Separate packaging wave blocked until re-census shows candidates

## Sign-off template

\`\`\`
APPROVED_TO_RUN_STAGING=true
APPROVED_SPREADSHEET_IDENTIFIER_MAP_LINK=true
Approved by:
UTC date:
Dryrun run_id: ${runId}
Plan run_id: ${planRunId}
\`\`\`
`,
  );

  fs.writeFileSync(
    path.join(outDir, "exact-next-prompts.md"),
    `# Exact next prompts

## 1 — Staging apply (after operator approval)

\`\`\`
MAIN-PRODUCT-SPREADSHEET-IDENTIFIER-MAP-LINK-STAGING-APPLY

Owner: Main/user
Branch: feature/product-canonicalization-v2
Mode: APPLY on staging only with operator approval

Scope: ${pass.length} rows from proposed-identifier-map-inserts.csv
Dryrun: ${OUT_BASE}/${runId}/
Approval: .cursor/operator-approvals/spreadsheet-identifier-map-link-staging-approval.md
Write: product_identifier_map INSERT only
Forbidden: products, packaging, vendor, spreadsheet auto-create
\`\`\`

## 2 — Re-census packaging backlog (after apply)

\`\`\`
MAIN-PRODUCT-SPREADSHEET-STAGING-MATCH-CENSUS-DRYRUN

Re-run after map links applied; expect packaging_candidate_existing_product > 0.
\`\`\`

## 3 — Product seed dryrun (parallel track, 8 rows)

\`\`\`
MAIN-PRODUCT-SPREADSHEET-PRODUCT-SEED-DRYRUN

Scope: 8 path-B rows from missing-product link plan — separate from map apply.
\`\`\`
`,
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "MAIN-PRODUCT-SPREADSHEET-IDENTIFIER-MAP-LINK-DRYRUN",
        run_id: runId,
        plan_run_id: planRunId,
        read_only: true,
        no_db_writes: true,
        branch,
        staging_ref: STAGING_REF,
        organization_id: orgId,
        store_id: storeId,
        candidate_count: candidates.length,
        pass_count: pass.length,
        already_linked_count: alreadyLinked.length,
        excluded_count: excluded.length,
        match_source: MATCH_SOURCE,
        approval_required: true,
        blockers,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: blockers.length === 0,
        outDir,
        candidate_count: candidates.length,
        pass_count: pass.length,
        already_linked_count: alreadyLinked.length,
        excluded_count: excluded.length,
        blockers,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
