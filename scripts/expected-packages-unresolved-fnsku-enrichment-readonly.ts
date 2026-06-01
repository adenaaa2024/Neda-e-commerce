/**
 * EXPECTED-PACKAGES-UNRESOLVED-FNSKU-ENRICHMENT-READONLY
 *   npx tsx scripts/expected-packages-unresolved-fnsku-enrichment-readonly.ts --run-id=<UTC>
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
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/expected-packages-unresolved-fnsku-enrichment-readonly";
const SHEET_CSV =
  ".cursor/audit-reports/product-spreadsheet-staging-match-census-dryrun/20260530T065129Z/all-classified-rows.csv";
const MISMATCH_CSV =
  ".cursor/audit-reports/product-sheet-phase-f-resolve-readonly/20260531T220000Z/identifier-mismatch-review-queue.csv";

type EpRow = {
  id: string;
  sku: string | null;
  fnsku: string | null;
  tracking_number: string | null;
  build_source: string | null;
};

type SheetRow = {
  seller_sku: string;
  sheet_asin: string;
  sheet_fnsku: string;
  brand: string;
  classification: string;
  product_id: string;
};

type FnskuGroup = {
  fnsku: string;
  ep_count: number;
  distinct_skus: string[];
  sample_skus: string[];
  extracted_asins: string[];
  evidence: string[];
  seed_class: string;
  recommended_action: string;
  ai_review_reason: string | null;
  block_reason: string | null;
  sheet_hits: number;
  sheet_product_ids: string[];
  sheet_asins: string[];
  inventory_source_hits: number;
  inventory_product_ids: string[];
  catalog_hits: number;
  sp_api_eligible: boolean;
  sample_ep_ids: string[];
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function loadSheetIndex(): {
  byFnsku: Map<string, SheetRow[]>;
  bySku: Map<string, SheetRow[]>;
  mismatchFnskus: Set<string>;
} {
  const byFnsku = new Map<string, SheetRow[]>();
  const bySku = new Map<string, SheetRow[]>();
  const mismatchFnskus = new Set<string>();

  if (fs.existsSync(path.join(process.cwd(), SHEET_CSV))) {
    const lines = fs.readFileSync(path.join(process.cwd(), SHEET_CSV), "utf8").split(/\r?\n/).filter(Boolean);
    const headers = parseCsvLine(lines[0]!);
    for (const line of lines.slice(1)) {
      const vals = parseCsvLine(line);
      const o: Record<string, string> = {};
      headers.forEach((h, i) => {
        o[h] = vals[i] ?? "";
      });
      const row: SheetRow = {
        seller_sku: o.seller_sku?.trim() ?? "",
        sheet_asin: o.sheet_asin?.trim() ?? "",
        sheet_fnsku: o.sheet_fnsku?.trim() ?? "",
        brand: o.brand?.trim() ?? "",
        classification: o.classification?.trim() ?? "",
        product_id: o.product_id?.trim() ?? "",
      };
      if (row.sheet_fnsku) {
        const k = row.sheet_fnsku.toUpperCase();
        const list = byFnsku.get(k) ?? [];
        list.push(row);
        byFnsku.set(k, list);
      }
      if (row.seller_sku) {
        const k = row.seller_sku.toUpperCase();
        const list = bySku.get(k) ?? [];
        list.push(row);
        bySku.set(k, list);
      }
    }
  }

  if (fs.existsSync(path.join(process.cwd(), MISMATCH_CSV))) {
    const lines = fs.readFileSync(path.join(process.cwd(), MISMATCH_CSV), "utf8").split(/\r?\n/).filter(Boolean);
    const headers = parseCsvLine(lines[0]!);
    const fi = headers.indexOf("sheet_fnsku");
    for (const line of lines.slice(1)) {
      const vals = parseCsvLine(line);
      const f = vals[fi]?.trim();
      if (f) mismatchFnskus.add(f.toUpperCase());
    }
  }

  return { byFnsku, bySku, mismatchFnskus };
}

function extractAsinsFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const m = text.toUpperCase().match(/\bB[0-9A-Z]{9}\b/g);
  return m ? [...new Set(m)] : [];
}

function isDirtySku(sku: string | null, fnsku: string | null): boolean {
  const s = (sku ?? "").trim().toUpperCase();
  const f = (fnsku ?? "").trim().toUpperCase();
  if (s === "UNKNOW" || s === "UNKNOWN") return true;
  if (/^(TEST|DUMMY|PLACEHOLDER|NULL|N\/A|NA|XXX)/.test(s)) return true;
  if (/^(TEST|DUMMY|PLACEHOLDER)/.test(f)) return true;
  if (f && !/^[XB][0-9A-Z]{9,}$/i.test(f) && f.length < 5) return true;
  return false;
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

async function tableExists(client: pg.Client, name: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name],
  );
  return (r.rowCount ?? 0) > 0;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (
    !dbUrl ||
    getStagingProjectRef({ loadEnv: false }) !== STAGING_REF ||
    !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)
  ) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const sheetIndex = loadSheetIndex();
  const spApiEnabled = ["1", "true", "yes"].includes(
    (process.env.AMAZON_SP_API_ENABLED ?? "").trim().toLowerCase(),
  );

  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
  });
  await client.connect();
  await client.query("SET statement_timeout = '180s'");

  const classC = await client.query(`
    WITH base AS (
      SELECT ep.id, ep.sku, ep.fnsku, ep.tracking_number, ep.build_source
      FROM public.expected_packages ep
      WHERE ep.resolved_product_id IS NULL
        AND NULLIF(btrim(ep.fnsku), '') IS NOT NULL
    ),
    map_hit AS (
      SELECT b.id, COUNT(DISTINCT m.product_id)::int AS c
      FROM base b
      LEFT JOIN public.product_identifier_map m
        ON m.deleted_at IS NULL AND m.organization_id = $1::uuid
       AND (m.store_id = $2::uuid OR m.store_id IS NULL)
       AND upper(btrim(m.fnsku)) = upper(btrim(b.fnsku))
      GROUP BY b.id
    ),
    prod_hit AS (
      SELECT b.id, COUNT(DISTINCT p.id)::int AS c
      FROM base b
      LEFT JOIN public.products p
        ON p.organization_id = $1::uuid AND p.store_id = $2::uuid
       AND upper(btrim(p.fnsku)) = upper(btrim(b.fnsku))
      GROUP BY b.id
    )
    SELECT b.*
    FROM base b
    LEFT JOIN map_hit mh ON mh.id = b.id
    LEFT JOIN prod_hit ph ON ph.id = b.id
    WHERE COALESCE(mh.c, 0) = 0 AND COALESCE(ph.c, 0) = 0
  `, [ORG, STORE]);

  const epRows = classC.rows as EpRow[];

  const inventoryTables = [
    "amazon_fba_inventory",
    "amazon_manage_fba_inventory",
    "amazon_amazon_fulfilled_inventory",
    "amazon_removals",
    "amazon_removal_shipments",
  ];
  const existingInv = [];
  for (const t of inventoryTables) {
    if (await tableExists(client, t)) existingInv.push(t);
  }

  const invByFnsku = new Map<string, { product_ids: Set<string>; sources: Set<string>; names: Set<string> }>();
  if (existingInv.length) {
    for (const table of existingInv) {
      const hasProductId = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND column_name IN ('product_id','resolved_product_id','fnsku','sku','seller_sku','fulfillment_channel_sku','asin','product_name')`,
        [table],
      );
      const cols = new Set(hasProductId.rows.map((r: { column_name: string }) => r.column_name));
      if (!cols.has("fnsku") && !cols.has("sku") && !cols.has("seller_sku") && !cols.has("fulfillment_channel_sku")) {
        continue;
      }
      const pidExpr = cols.has("resolved_product_id")
        ? "COALESCE(resolved_product_id, product_id)"
        : cols.has("product_id")
          ? "product_id"
          : "NULL::uuid";
      const fnskuExpr = cols.has("fnsku")
        ? "fnsku"
        : cols.has("fulfillment_channel_sku")
          ? "fulfillment_channel_sku"
          : "NULL::text";
      const nameExpr = cols.has("product_name") ? "product_name" : "NULL::text";
      const r = await client.query(`
        SELECT upper(btrim(${fnskuExpr})) AS fnsku_key,
          ${pidExpr}::text AS product_id,
          ${nameExpr} AS product_name
        FROM public.${table}
        WHERE organization_id = $1::uuid
          AND (${cols.has("store_id") ? "store_id = $2::uuid OR store_id IS NULL" : "true"})
          AND NULLIF(btrim(${fnskuExpr}), '') IS NOT NULL
      `, cols.has("store_id") ? [ORG, STORE] : [ORG]);
      for (const row of r.rows as { fnsku_key: string; product_id: string | null; product_name: string | null }[]) {
        if (!row.fnsku_key) continue;
        const hit = invByFnsku.get(row.fnsku_key) ?? { product_ids: new Set(), sources: new Set(), names: new Set() };
        hit.sources.add(table);
        if (row.product_id) hit.product_ids.add(row.product_id);
        if (row.product_name) hit.names.add(row.product_name);
        invByFnsku.set(row.fnsku_key, hit);
      }
    }
  }

  const catalogByFnsku = new Map<string, number>();
  if (await tableExists(client, "catalog_products")) {
    const r = await client.query(`
      SELECT upper(btrim(fnsku)) AS fnsku_key, COUNT(*)::int AS c
      FROM public.catalog_products
      WHERE organization_id = $1::uuid AND store_id = $2::uuid
        AND NULLIF(btrim(fnsku), '') IS NOT NULL
      GROUP BY 1
    `, [ORG, STORE]);
    for (const row of r.rows as { fnsku_key: string; c: number }[]) {
      catalogByFnsku.set(row.fnsku_key, row.c);
    }
  }

  let orgAmazonKeyCount = 0;
  if (await tableExists(client, "organization_api_keys")) {
    const keyCols = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='organization_api_keys'`,
    );
    const kc = new Set(keyCols.rows.map((r: { column_name: string }) => r.column_name));
    const providerFilter = kc.has("provider")
      ? "AND provider ILIKE '%amazon%'"
      : kc.has("key_type")
        ? "AND key_type ILIKE '%amazon%'"
        : "";
    const deletedFilter = kc.has("deleted_at") ? "AND deleted_at IS NULL" : "";
    const r = await client.query(`
      SELECT COUNT(*)::int AS c FROM public.organization_api_keys
      WHERE organization_id = $1::uuid ${providerFilter} ${deletedFilter}
    `, [ORG]);
    orgAmazonKeyCount = Number(r.rows[0]?.c ?? 0);
  }

  await client.end();

  const byFnsku = new Map<string, EpRow[]>();
  for (const row of epRows) {
    const k = (row.fnsku ?? "").trim().toUpperCase();
    if (!k) continue;
    const list = byFnsku.get(k) ?? [];
    list.push(row);
    byFnsku.set(k, list);
  }

  const groups: FnskuGroup[] = [];
  const bucketCounts: Record<string, number> = {};

  for (const [fnsku, rows] of byFnsku.entries()) {
    const skus = [...new Set(rows.map((r) => (r.sku ?? "").trim()).filter(Boolean))];
    const extractedAsins = [
      ...new Set(rows.flatMap((r) => extractAsinsFromText(r.sku)).concat(extractAsinsFromText(fnsku))),
    ];
    const sheetHits = sheetIndex.byFnsku.get(fnsku) ?? [];
    const sheetBySku = rows.flatMap((r) => sheetIndex.bySku.get((r.sku ?? "").toUpperCase()) ?? []);
    const allSheet = [...sheetHits, ...sheetBySku];
    const uniqueSheet = new Map<string, SheetRow>();
    for (const s of allSheet) uniqueSheet.set(`${s.seller_sku}|${s.sheet_asin}|${s.product_id}`, s);
    const sheetRows = [...uniqueSheet.values()];
    const sheetProductIds = [...new Set(sheetRows.map((s) => s.product_id).filter(Boolean))];
    const sheetAsins = [...new Set(sheetRows.map((s) => s.sheet_asin).filter(Boolean))];
    const inv = invByFnsku.get(fnsku);
    const invProductIds = inv ? [...inv.product_ids] : [];
    const catalogHits = catalogByFnsku.get(fnsku) ?? 0;
    const spApiEligible =
      spApiEnabled &&
      (Number(orgAmazonKeyCount) > 0) &&
      (extractedAsins.length > 0 || sheetAsins.some((a) => /^B[0-9A-Z]{9}$/i.test(a)));

    const evidence: string[] = [];
    if (sheetRows.length) evidence.push(`product_sheet(${sheetRows.length})`);
    if (inv?.sources.size) evidence.push(`inventory:${[...inv.sources].join("+")}`);
    if (catalogHits) evidence.push(`catalog_products(${catalogHits})`);
    if (extractedAsins.length) evidence.push(`sku_asin_extract(${extractedAsins.join("|")})`);
    if (spApiEligible) evidence.push("sp_api_eligible");
    if (!evidence.length) evidence.push("no_local_evidence");

    let seed_class = "blocked";
    let recommended_action = "hold_no_governed_evidence";
    let ai_review_reason: string | null = null;
    let block_reason: string | null = null;

    const dirty = rows.some((r) => isDirtySku(r.sku, r.fnsku));
    const mismatch = sheetIndex.mismatchFnskus.has(fnsku);
    const sheetConflict = sheetRows.some((s) => s.classification === "blocked_product_insert");
    const multiSheetProducts = sheetProductIds.length > 1;
    const multiAsins = new Set([...sheetAsins, ...extractedAsins]).size > 1;
    const multiInvProducts = invProductIds.length > 1;

    if (dirty && !extractedAsins.length && !sheetRows.length) {
      block_reason = "dirty_or_unknown_sku_no_asin";
      seed_class = "blocked";
      recommended_action = "quarantine_or_fix_source_identifiers";
    } else if (mismatch) {
      block_reason = "product_sheet_class_a_identifier_mismatch";
      seed_class = "blocked";
      recommended_action = "resolve_identifier_mismatch_before_seed";
    } else if (multiInvProducts || multiSheetProducts || multiAsins) {
      ai_review_reason = multiInvProducts
        ? "multiple_inventory_product_ids"
        : multiSheetProducts
          ? "multiple_sheet_product_ids"
          : "multiple_asin_candidates";
      seed_class = "ai_review_needed";
      recommended_action = "operator_pick_canonical_asin_product";
    } else if (
      sheetProductIds.length === 1 &&
      sheetRows.every((s) => s.product_id && s.classification !== "blocked_product_insert") &&
      !sheetConflict
    ) {
      seed_class = "safe_governed_seed";
      recommended_action = "governed_product_seed_from_sheet_row_then_map_bridge";
    } else if (invProductIds.length === 1 && extractedAsins.length === 1) {
      seed_class = "safe_governed_seed";
      recommended_action = "governed_product_seed_from_inventory_plus_asin_evidence";
    } else if (invProductIds.length === 1 && sheetAsins.length === 1) {
      seed_class = "safe_governed_seed";
      recommended_action = "governed_product_seed_inventory_sheet_asin_agree";
    } else if (spApiEligible && extractedAsins.length === 1) {
      seed_class = "ai_review_needed";
      ai_review_reason = "sp_api_catalog_lookup_suggested_not_auto";
      recommended_action = "governed_sp_api_evidence_dryrun_then_seed";
    } else if (sheetRows.length || inv?.names.size || catalogHits) {
      seed_class = "ai_review_needed";
      ai_review_reason = "partial_evidence_needs_operator_or_ai_review";
      recommended_action = "ai_assist_review_suggestion_only";
    } else {
      block_reason = "no_governed_evidence_path";
      seed_class = "blocked";
      recommended_action = "enrich_source_or_manual_research";
    }

    bucketCounts[seed_class] = (bucketCounts[seed_class] ?? 0) + 1;

    groups.push({
      fnsku,
      ep_count: rows.length,
      distinct_skus: skus,
      sample_skus: skus.slice(0, 5),
      extracted_asins: extractedAsins,
      evidence,
      seed_class,
      recommended_action,
      ai_review_reason,
      block_reason,
      sheet_hits: sheetRows.length,
      sheet_product_ids: sheetProductIds,
      sheet_asins: sheetAsins,
      inventory_source_hits: inv?.sources.size ?? 0,
      inventory_product_ids: invProductIds,
      catalog_hits: catalogHits,
      sp_api_eligible: spApiEligible,
      sample_ep_ids: rows.slice(0, 3).map((r) => r.id),
    });
  }

  groups.sort((a, b) => {
    const order = { safe_governed_seed: 0, ai_review_needed: 1, blocked: 2 };
    return (order[a.seed_class as keyof typeof order] ?? 9) - (order[b.seed_class as keyof typeof order] ?? 9) || b.ep_count - a.ep_count;
  });

  const safe = groups.filter((g) => g.seed_class === "safe_governed_seed");
  const aiReview = groups.filter((g) => g.seed_class === "ai_review_needed");
  const blocked = groups.filter((g) => g.seed_class === "blocked");
  const sampleSafe = safe.slice(0, 25);

  const evidenceBucketCounts: Record<string, number> = {};
  for (const g of groups) {
    for (const e of g.evidence) {
      const key = e.split("(")[0]!;
      evidenceBucketCounts[key] = (evidenceBucketCounts[key] ?? 0) + 1;
    }
  }

  writeCsv(
    path.join(outDir, "fnsku-groups-classified.csv"),
    [
      "fnsku",
      "ep_count",
      "seed_class",
      "recommended_action",
      "evidence",
      "sheet_hits",
      "sheet_product_ids",
      "sheet_asins",
      "inventory_product_ids",
      "catalog_hits",
      "extracted_asins",
      "sp_api_eligible",
      "ai_review_reason",
      "block_reason",
      "sample_skus",
    ],
    groups.map((g) => ({
      fnsku: g.fnsku,
      ep_count: g.ep_count,
      seed_class: g.seed_class,
      recommended_action: g.recommended_action,
      evidence: g.evidence.join(";"),
      sheet_hits: g.sheet_hits,
      sheet_product_ids: g.sheet_product_ids.join("|"),
      sheet_asins: g.sheet_asins.join("|"),
      inventory_product_ids: g.inventory_product_ids.join("|"),
      catalog_hits: g.catalog_hits,
      extracted_asins: g.extracted_asins.join("|"),
      sp_api_eligible: g.sp_api_eligible,
      ai_review_reason: g.ai_review_reason,
      block_reason: g.block_reason,
      sample_skus: g.sample_skus.join("|"),
    })),
  );

  writeCsv(
    path.join(outDir, "sample-safe-governed-seed-max25.csv"),
    ["fnsku", "ep_count", "recommended_action", "sheet_product_ids", "sheet_asins", "extracted_asins", "evidence"],
    sampleSafe.map((g) => ({
      fnsku: g.fnsku,
      ep_count: g.ep_count,
      recommended_action: g.recommended_action,
      sheet_product_ids: g.sheet_product_ids.join("|"),
      sheet_asins: g.sheet_asins.join("|"),
      extracted_asins: g.extracted_asins.join("|"),
      evidence: g.evidence.join(";"),
    })),
  );

  const report = `# EXPECTED-PACKAGES-UNRESOLVED-FNSKU-ENRICHMENT-READONLY

Run: \`${runId}\`  
Mode: **read-only** · staging \`${STAGING_REF}\`  
Class C source: unresolved \`expected_packages\` with FNSKU, zero spine match

# DISTINCT_FNSKU_COUNT

| Metric | Count |
|--------|------:|
| Class C EP rows | **${epRows.length}** |
| **Distinct FNSKUs** | **${groups.length}** |
| EP rows per FNSKU (avg) | ${groups.length ? (epRows.length / groups.length).toFixed(1) : "—"} |

# EVIDENCE_BUCKETS

| Evidence signal | FNSKU groups with signal |
|-----------------|-------------------------:|
${Object.entries(evidenceBucketCounts)
  .sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `| ${k} | ${n} |`)
  .join("\n")}

| Environment | Value |
|-------------|-------|
| SP-API enabled (env) | ${spApiEnabled} |
| Org Amazon API keys | ${orgAmazonKeyCount} |
| Product sheet index | ${sheetIndex.byFnsku.size} FNSKUs |
| Identifier mismatch blocklist | ${sheetIndex.mismatchFnskus.size} FNSKUs |

# SEED_CLASSIFICATION

| Class | FNSKU groups | EP rows |
|-------|-------------:|--------:|
| **safe_governed_seed** | **${safe.length}** | ${safe.reduce((a, g) => a + g.ep_count, 0)} |
| **ai_review_needed** | **${aiReview.length}** | ${aiReview.reduce((a, g) => a + g.ep_count, 0)} |
| **blocked** | **${blocked.length}** | ${blocked.reduce((a, g) => a + g.ep_count, 0)} |

# SAFE_GOVERNED_SEED_CANDIDATES

${safe.length ? `Top safe groups (max 25 sample in \`sample-safe-governed-seed-max25.csv\`):` : "None — no FNSKU group met safe governed seed criteria."}

${sampleSafe
  .slice(0, 10)
  .map(
    (g) =>
      `- \`${g.fnsku}\` (${g.ep_count} EP) — ${g.recommended_action}; evidence: ${g.evidence.join(", ")}`,
  )
  .join("\n")}

# AI_REVIEW_NEEDED

${aiReview.length} FNSKU groups — partial evidence, multi-ASIN, or SP-API lookup suggested (no auto-write).

Top reasons:
${[...new Set(aiReview.map((g) => g.ai_review_reason).filter(Boolean))]
  .slice(0, 8)
  .map((r) => `- ${r}`)
  .join("\n") || "- (see fnsku-groups-classified.csv)"}

# BLOCKED_CANDIDATES

${blocked.length} FNSKU groups — dirty identifiers, mismatch blocklist, or no governed evidence.

Top block reasons:
${[...new Set(blocked.map((g) => g.block_reason).filter(Boolean))]
  .slice(0, 8)
  .map((r) => `- ${r}`)
  .join("\n") || "- (see fnsku-groups-classified.csv)"}

# NEXT_SAMPLE_SEED_APPROVAL_PROMPT

\`\`\`text
EXPECTED-PACKAGES-GOVERNED-PRODUCT-SEED-SAMPLE-WAVE-STAGING

After operator review of sample-safe-governed-seed-max25.csv (≤25 distinct FNSKUs):
- Staging ref eiqfaapyumhixxoeltgu only
- Governed product INSERT + product_identifier_map bridge for Class C EP rows tied to approved FNSKUs
- Zero fuzzy title/OCR merge
- Zero auto SP-API write without separate evidence dry-run approval
- Skip FNSKUs on identifier_mismatch blocklist
- Skip ai_review_needed and blocked classes until separately approved

Required flags:
APPROVED_TO_RUN_STAGING=true
APPROVED_EP_GOVERNED_PRODUCT_SEED_SAMPLE=true
APPROVED_PRODUCT_INSERT_MAX_25=true
APPROVED_MAP_BRIDGE=true
APPROVED_SP_API_EVIDENCE_WRITE=false
TARGET_SUPABASE_REF=eiqfaapyumhixxoeltgu
\`\`\`

# ARTIFACTS

- \`fnsku-groups-classified.csv\` — all ${groups.length} FNSKU groups
- \`sample-safe-governed-seed-max25.csv\` — ≤25 safe seed candidates
`;

  fs.writeFileSync(path.join(outDir, "enrichment-report.md"), report);
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        audit_id: "EXPECTED-PACKAGES-UNRESOLVED-FNSKU-ENRICHMENT-READONLY",
        run_id: runId,
        staging_ref: STAGING_REF,
        class_c_ep_rows: epRows.length,
        distinct_fnsku: groups.length,
        seed_classification: bucketCounts,
        evidence_buckets: evidenceBucketCounts,
        safe_governed_seed_groups: safe.length,
        ai_review_groups: aiReview.length,
        blocked_groups: blocked.length,
        sample_safe_max25: sampleSafe.length,
      },
      null,
      2,
    ),
  );

  console.log(report);
  console.log(`\nWrote ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
