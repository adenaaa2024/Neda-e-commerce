/**
 * EXPECTED-PACKAGES-GOVERNED-PRODUCT-SEED-PLAN
 * Read-only plan for Class C FNSKU-only unresolved expected_packages.
 *
 *   npx tsx scripts/expected-packages-governed-product-seed-plan.ts --run-id=<UTC>
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
const OUT_BASE = ".cursor/audit-reports/expected-packages-governed-product-seed-plan";
const SHEET_CSV =
  ".cursor/audit-reports/product-spreadsheet-staging-match-census-dryrun/20260530T065129Z/all-classified-rows.csv";
const MISMATCH_CSV =
  ".cursor/audit-reports/product-sheet-phase-f-resolve-readonly/20260607T160000Z/identifier-mismatch-review-queue.csv";

type EpRow = {
  id: string;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
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
  evidence: string[];
  disposition: "safe_governed_seed" | "manual_review" | "blocked";
  recommended_action: string;
  review_reason: string | null;
  block_reason: string | null;
  sheet_hits: number;
  sheet_product_ids: string[];
  sheet_asins: string[];
  catalog_hits: number;
  catalog_asins: string[];
  removal_hits: number;
  removal_asins: string[];
  removal_skus: string[];
  inventory_sources: string[];
  sp_api_eligible: boolean;
  proposed_seller_sku: string | null;
  proposed_asin: string | null;
  sample_ep_ids: string[];
};

const REQUIRED_FIELDS_FOR_PRODUCT_SEED = [
  "organization_id (fixed org scope)",
  "store_id (fixed store scope)",
  "sku / seller_sku (from EP.sku or sheet row — not title-derived)",
  "fnsku (from EP — shape-valid X#########)",
  "asin (from sheet, catalog_products, removal raw, or SP-API evidence — never title-only)",
  "product_name (from sheet row or catalog listing JSON only — no OCR/fuzzy merge)",
  "identifier_resolution_status = pending until map+resolver",
  "governance: match_source + external_listing_id on product_identifier_map insert",
  "post-seed: rerun expected_packages resolver (map-only backfill, no EP→RI copy)",
] as const;

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
        (byFnsku.get(k) ?? byFnsku.set(k, []).get(k)!).push(row);
      }
      if (row.seller_sku) {
        const k = row.seller_sku.toUpperCase();
        (bySku.get(k) ?? bySku.set(k, []).get(k)!).push(row);
      }
    }
  }

  if (fs.existsSync(path.join(process.cwd(), MISMATCH_CSV))) {
    const lines = fs.readFileSync(path.join(process.cwd(), MISMATCH_CSV), "utf8").split(/\r?\n/).filter(Boolean);
    const headers = parseCsvLine(lines[0]!);
    const fi = headers.indexOf("sheet_fnsku");
    for (const line of lines.slice(1)) {
      const f = parseCsvLine(line)[fi]?.trim();
      if (f) mismatchFnskus.add(f.toUpperCase());
    }
  }

  return { byFnsku, bySku, mismatchFnskus };
}

function extractAsins(text: string | null | undefined): string[] {
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

  const epCols = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='expected_packages'`,
  );
  const epColSet = new Set(epCols.rows.map((r: { column_name: string }) => r.column_name));
  const hasEpAsin = epColSet.has("asin");

  const classC = await client.query(
    `
    WITH unresolved AS (
      SELECT ep.id, ep.sku, ep.fnsku,
        ${hasEpAsin ? "ep.asin" : "NULL::text AS asin"},
        ep.tracking_number, ep.build_source
      FROM public.expected_packages ep
      WHERE ep.organization_id = $1::uuid AND ep.store_id = $2::uuid
        AND ep.resolved_product_id IS NULL
        AND NULLIF(btrim(ep.fnsku), '') IS NOT NULL
        AND ${hasEpAsin ? "NULLIF(btrim(ep.asin), '') IS NULL" : "true"}
    ),
    map_hit AS (
      SELECT u.id, COUNT(DISTINCT m.product_id)::int AS c
      FROM unresolved u
      LEFT JOIN public.product_identifier_map m
        ON m.deleted_at IS NULL AND m.organization_id = $1::uuid AND m.store_id = $2::uuid
       AND upper(btrim(m.fnsku)) = upper(btrim(u.fnsku))
      GROUP BY u.id
    ),
    prod_hit AS (
      SELECT u.id, COUNT(DISTINCT p.id)::int AS c
      FROM unresolved u
      LEFT JOIN public.products p
        ON p.organization_id = $1::uuid AND p.store_id = $2::uuid AND p.deleted_at IS NULL
       AND upper(btrim(p.fnsku)) = upper(btrim(u.fnsku))
      GROUP BY u.id
    )
    SELECT u.*
    FROM unresolved u
    LEFT JOIN map_hit mh ON mh.id = u.id
    LEFT JOIN prod_hit ph ON ph.id = u.id
    WHERE COALESCE(mh.c, 0) = 0 AND COALESCE(ph.c, 0) = 0
    ORDER BY u.fnsku, u.id
    `,
    [ORG, STORE],
  );

  const epRows = classC.rows as EpRow[];

  const catalogByFnsku = new Map<string, { count: number; asins: Set<string> }>();
  if (await tableExists(client, "catalog_products")) {
    const r = await client.query(
      `
      SELECT upper(btrim(fnsku)) AS fnsku_key, asin, COUNT(*)::int AS c
      FROM public.catalog_products
      WHERE organization_id = $1::uuid AND store_id = $2::uuid
        AND NULLIF(btrim(fnsku), '') IS NOT NULL
      GROUP BY 1, 2
      `,
      [ORG, STORE],
    );
    for (const row of r.rows as { fnsku_key: string; asin: string | null; c: number }[]) {
      const hit = catalogByFnsku.get(row.fnsku_key) ?? { count: 0, asins: new Set<string>() };
      hit.count += row.c;
      if (row.asin) hit.asins.add(row.asin.toUpperCase());
      catalogByFnsku.set(row.fnsku_key, hit);
    }
  }

  const removalByFnsku = new Map<string, { count: number; asins: Set<string>; skus: Set<string> }>();
  for (const table of ["amazon_removals", "amazon_removal_shipments"] as const) {
    if (!(await tableExists(client, table))) continue;
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
      [table],
    );
    const cset = new Set(cols.rows.map((r: { column_name: string }) => r.column_name));
    const fnskuCol = cset.has("fnsku")
      ? "fnsku"
      : cset.has("fulfillment_channel_sku")
        ? "fulfillment_channel_sku"
        : null;
    if (!fnskuCol) continue;
    const asinCol = cset.has("asin") ? "asin" : null;
    const skuCol = cset.has("sku") ? "sku" : cset.has("seller_sku") ? "seller_sku" : null;
    const r = await client.query(`
      SELECT upper(btrim(${fnskuCol})) AS fnsku_key,
        ${asinCol ? `NULLIF(btrim(${asinCol}), '')` : "NULL::text"} AS asin,
        ${skuCol ? `NULLIF(btrim(${skuCol}), '')` : "NULL::text"} AS sku
      FROM public.${table}
      WHERE organization_id = $1::uuid
        AND NULLIF(btrim(${fnskuCol}), '') IS NOT NULL
    `, [ORG]);
    for (const row of r.rows as { fnsku_key: string; asin: string | null; sku: string | null }[]) {
      if (!row.fnsku_key) continue;
      const hit = removalByFnsku.get(row.fnsku_key) ?? { count: 0, asins: new Set(), skus: new Set() };
      hit.count += 1;
      if (row.asin) hit.asins.add(row.asin.toUpperCase());
      if (row.sku) hit.skus.add(row.sku);
      removalByFnsku.set(row.fnsku_key, hit);
    }
  }

  let orgAmazonKeyCount = 0;
  if (await tableExists(client, "organization_api_keys")) {
    const r = await client.query(
      `SELECT COUNT(*)::int AS c FROM public.organization_api_keys WHERE organization_id = $1::uuid`,
      [ORG],
    );
    orgAmazonKeyCount = Number(r.rows[0]?.c ?? 0);
  }

  await client.end();

  const byFnsku = new Map<string, EpRow[]>();
  for (const row of epRows) {
    const k = (row.fnsku ?? "").trim().toUpperCase();
    if (!k) continue;
    (byFnsku.get(k) ?? byFnsku.set(k, []).get(k)!).push(row);
  }

  const groups: FnskuGroup[] = [];

  for (const [fnsku, rows] of byFnsku.entries()) {
    const skus = [...new Set(rows.map((r) => (r.sku ?? "").trim()).filter(Boolean))];
    const extractedAsins = [...new Set(rows.flatMap((r) => extractAsins(r.sku)))];
    const sheetHits = sheetIndex.byFnsku.get(fnsku) ?? [];
    const sheetBySku = rows.flatMap((r) => sheetIndex.bySku.get((r.sku ?? "").toUpperCase()) ?? []);
    const uniqueSheet = new Map<string, SheetRow>();
    for (const s of [...sheetHits, ...sheetBySku]) uniqueSheet.set(`${s.seller_sku}|${s.sheet_asin}|${s.product_id}`, s);
    const sheetRows = [...uniqueSheet.values()];
    const sheetProductIds = [...new Set(sheetRows.map((s) => s.product_id).filter(Boolean))];
    const sheetAsins = [...new Set(sheetRows.map((s) => s.sheet_asin).filter(Boolean))];
    const catalog = catalogByFnsku.get(fnsku);
    const catalogAsins = catalog ? [...catalog.asins] : [];
    const removal = removalByFnsku.get(fnsku);
    const removalAsins = removal ? [...removal.asins] : [];
    const removalSkus = removal ? [...removal.skus] : [];
    const allAsinCandidates = [...new Set([...sheetAsins, ...catalogAsins, ...removalAsins, ...extractedAsins])].filter(
      (a) => /^B[0-9A-Z]{9}$/i.test(a),
    );

    const evidence: string[] = [];
    if (sheetRows.length) evidence.push(`product_sheet(${sheetRows.length})`);
    if (removal?.count) evidence.push(`removal_raw(${removal.count})`);
    if (catalog?.count) evidence.push(`catalog_products(${catalog.count})`);
    if (extractedAsins.length) evidence.push(`sku_asin_extract(${extractedAsins.join("|")})`);
    const spApiEligible =
      spApiEnabled && orgAmazonKeyCount > 0 && allAsinCandidates.length === 1;
    if (spApiEligible) evidence.push("sp_api_catalog_confirm_eligible");
    if (!evidence.length) evidence.push("no_local_evidence");

    const dirty = rows.some((r) => isDirtySku(r.sku, r.fnsku));
    const mismatch = sheetIndex.mismatchFnskus.has(fnsku);
    const sheetConflict = sheetRows.some((s) => s.classification === "blocked_product_insert");
    const multiSheetProducts = sheetProductIds.length > 1;
    const multiAsins = allAsinCandidates.length > 1;

    let disposition: FnskuGroup["disposition"] = "blocked";
    let recommended_action = "hold_no_governed_evidence";
    let review_reason: string | null = null;
    let block_reason: string | null = null;

    const proposedSellerSku =
      sheetRows[0]?.seller_sku ?? removalSkus[0] ?? skus[0] ?? null;
    const proposedAsin = allAsinCandidates.length === 1 ? allAsinCandidates[0]! : null;

    if (dirty && !allAsinCandidates.length && !sheetRows.length) {
      block_reason = "dirty_or_unknown_sku_no_asin";
      disposition = "blocked";
      recommended_action = "quarantine_or_fix_source_identifiers";
    } else if (mismatch) {
      block_reason = "product_sheet_class_a_identifier_mismatch";
      disposition = "blocked";
      recommended_action = "resolve_identifier_mismatch_before_seed";
    } else if (sheetConflict) {
      block_reason = "sheet_blocked_product_insert_class";
      disposition = "blocked";
      recommended_action = "governed_seed_approval_required_for_blocked_class";
    } else if (multiSheetProducts || multiAsins) {
      review_reason = multiSheetProducts ? "multiple_sheet_product_ids" : "multiple_asin_candidates";
      disposition = "manual_review";
      recommended_action = "operator_pick_canonical_asin_and_sku";
    } else if (
      sheetProductIds.length === 1 &&
      sheetRows.every((s) => s.product_id && s.classification !== "blocked_product_insert") &&
      allAsinCandidates.length === 1
    ) {
      disposition = "safe_governed_seed";
      recommended_action = "seed_product_from_sheet_link_existing_product_id_then_map";
    } else if (allAsinCandidates.length === 1 && (sheetRows.length || removal?.count || catalog?.count)) {
      disposition = "safe_governed_seed";
      recommended_action = "seed_product_from_evidence_asin_fnsku_then_map_bridge";
    } else if (spApiEligible) {
      review_reason = "sp_api_catalog_lookup_suggested_not_auto";
      disposition = "manual_review";
      recommended_action = "sp_api_evidence_dryrun_then_operator_approve_seed";
    } else if (sheetRows.length || removal?.count || catalog?.count) {
      review_reason = "partial_evidence_missing_unique_asin";
      disposition = "manual_review";
      recommended_action = "enrich_asin_via_sp_api_or_sheet_then_review";
    } else {
      block_reason = "no_governed_evidence_path";
      disposition = "blocked";
      recommended_action = "manual_research_or_source_enrichment";
    }

    groups.push({
      fnsku,
      ep_count: rows.length,
      distinct_skus: skus,
      evidence,
      disposition,
      recommended_action,
      review_reason,
      block_reason,
      sheet_hits: sheetRows.length,
      sheet_product_ids: sheetProductIds,
      sheet_asins: sheetAsins,
      catalog_hits: catalog?.count ?? 0,
      catalog_asins: catalogAsins,
      removal_hits: removal?.count ?? 0,
      removal_asins: removalAsins,
      removal_skus: removalSkus,
      inventory_sources: removal?.count ? ["amazon_removals", "amazon_removal_shipments"].filter(Boolean) : [],
      sp_api_eligible: spApiEligible,
      proposed_seller_sku: proposedSellerSku,
      proposed_asin: proposedAsin,
      sample_ep_ids: rows.slice(0, 3).map((r) => r.id),
    });
  }

  groups.sort((a, b) => {
    const order = { safe_governed_seed: 0, manual_review: 1, blocked: 2 };
    return (
      (order[a.disposition] ?? 9) - (order[b.disposition] ?? 9) || b.ep_count - a.ep_count
    );
  });

  const safe = groups.filter((g) => g.disposition === "safe_governed_seed");
  const manualReview = groups.filter((g) => g.disposition === "manual_review");
  const blocked = groups.filter((g) => g.disposition === "blocked");
  const sampleSafe = safe.slice(0, 25);

  writeCsv(
    path.join(outDir, "fnsku-groups-classified.csv"),
    [
      "fnsku",
      "ep_count",
      "disposition",
      "recommended_action",
      "evidence",
      "proposed_seller_sku",
      "proposed_asin",
      "sheet_hits",
      "catalog_hits",
      "removal_hits",
      "review_reason",
      "block_reason",
    ],
    groups.map((g) => ({
      fnsku: g.fnsku,
      ep_count: g.ep_count,
      disposition: g.disposition,
      recommended_action: g.recommended_action,
      evidence: g.evidence.join(";"),
      proposed_seller_sku: g.proposed_seller_sku,
      proposed_asin: g.proposed_asin,
      sheet_hits: g.sheet_hits,
      catalog_hits: g.catalog_hits,
      removal_hits: g.removal_hits,
      review_reason: g.review_reason,
      block_reason: g.block_reason,
    })),
  );

  writeCsv(
    path.join(outDir, "safe-seed-candidates-max25.csv"),
    [
      "fnsku",
      "ep_count",
      "proposed_seller_sku",
      "proposed_asin",
      "recommended_action",
      "evidence",
      "sample_ep_ids",
    ],
    sampleSafe.map((g) => ({
      fnsku: g.fnsku,
      ep_count: g.ep_count,
      proposed_seller_sku: g.proposed_seller_sku,
      proposed_asin: g.proposed_asin,
      recommended_action: g.recommended_action,
      evidence: g.evidence.join(";"),
      sample_ep_ids: g.sample_ep_ids.join("|"),
    })),
  );

  const exactApplyPrompt =
    sampleSafe.length > 0
      ? `EXPECTED-PACKAGES-GOVERNED-PRODUCT-SEED-SAMPLE-WAVE-STAGING

Staging ref: ${STAGING_REF} only · max 25 distinct FNSKUs from safe-seed-candidates-max25.csv

Execute order (governed Product Core path):
1. Operator approval with APPROVED_EP_GOVERNED_PRODUCT_SEED_SAMPLE=true, APPROVED_PRODUCT_INSERT_MAX_25=true
2. For each approved FNSKU: INSERT products (exact fields only) OR link existing sheet product_id when present
3. INSERT product_identifier_map (seller_sku + fnsku + asin + match_source + external_listing_id)
4. Rerun expected_packages resolver — map-only; no EP→return_items copy
5. Verify resolved_product_id set on affected EP rows; rollback.sql required

Forbidden: fuzzy/title/OCR seed, bulk >25, SP-API auto-write without evidence dry-run, identifier_mismatch FNSKUs

Sample FNSKUs (${sampleSafe.length}):
${sampleSafe.map((g) => `- ${g.fnsku} (${g.ep_count} EP) asin=${g.proposed_asin ?? "?"} sku=${g.proposed_seller_sku ?? "?"}`).join("\n")}`
      : "NONE — no safe governed seed candidates; resolve manual_review/blocked buckets first";

  const safeToApply = sampleSafe.length > 0 ? "yes_with_operator_approval" : "no";

  const manifest = {
    prompt: "EXPECTED-PACKAGES-GOVERNED-PRODUCT-SEED-PLAN",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "read-only",
    class_c_fnsku_only_ep_rows: epRows.length,
    distinct_fnsku_count: groups.length,
    safe_seed_candidates_max25: sampleSafe.length,
    safe_seed_ep_rows: safe.reduce((a, g) => a + g.ep_count, 0),
    manual_review: {
      fnsku_groups: manualReview.length,
      ep_rows: manualReview.reduce((a, g) => a + g.ep_count, 0),
      top_reasons: [...new Set(manualReview.map((g) => g.review_reason).filter(Boolean))].slice(0, 8),
    },
    blocked: {
      fnsku_groups: blocked.length,
      ep_rows: blocked.reduce((a, g) => a + g.ep_count, 0),
      top_reasons: [...new Set(blocked.map((g) => g.block_reason).filter(Boolean))].slice(0, 8),
    },
    evidence_summary: {
      product_sheet_fnsku_groups: groups.filter((g) => g.sheet_hits > 0).length,
      catalog_products_fnsku_groups: groups.filter((g) => g.catalog_hits > 0).length,
      removal_raw_fnsku_groups: groups.filter((g) => g.removal_hits > 0).length,
      sp_api_confirm_eligible_groups: groups.filter((g) => g.sp_api_eligible).length,
      no_local_evidence_groups: groups.filter((g) => g.evidence.includes("no_local_evidence")).length,
    },
    required_fields_for_product_seed: REQUIRED_FIELDS_FOR_PRODUCT_SEED,
    architecture: {
      seed_path: "products INSERT via governed approval only when spine missing",
      map_path: "product_identifier_map insert with match_source external_listing_id",
      resolver_path: "rerun expected_packages resolver after map bridge",
      forbidden: ["fuzzy_merge", "ocr_title_only", "bulk_create_without_approval", "auto_sp_api_write"],
    },
    exact_apply_prompt_max25: exactApplyPrompt,
    SAFE_TO_APPLY: safeToApply,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "seed-plan.md"),
    [
      "# EXPECTED-PACKAGES-GOVERNED-PRODUCT-SEED-PLAN",
      "",
      `Run: \`${runId}\` · read-only · staging \`${STAGING_REF}\``,
      "",
      "## distinct_fnsku_count",
      "",
      `Class C FNSKU-only EP rows: **${epRows.length}** · Distinct FNSKUs: **${groups.length}**`,
      "",
      "## Classification",
      "",
      `| Bucket | FNSKU groups | EP rows |`,
      `|--------|-------------:|--------:|`,
      `| safe_governed_seed | ${safe.length} | ${safe.reduce((a, g) => a + g.ep_count, 0)} |`,
      `| manual_review | ${manualReview.length} | ${manualReview.reduce((a, g) => a + g.ep_count, 0)} |`,
      `| blocked | ${blocked.length} | ${blocked.reduce((a, g) => a + g.ep_count, 0)} |`,
      "",
      "## safe_seed_candidates_max25",
      "",
      `**${sampleSafe.length}** candidates in \`safe-seed-candidates-max25.csv\``,
      "",
      "## SAFE_TO_APPLY",
      "",
      `**${safeToApply}**`,
      "",
      "## exact_apply_prompt_max25",
      "",
      "```text",
      exactApplyPrompt,
      "```",
    ].join("\n"),
  );

  console.log(JSON.stringify(manifest, null, 2));
  console.log(`\nWrote ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
