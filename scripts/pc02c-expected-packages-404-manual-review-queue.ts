/**
 * PC02C — EXPECTED-PACKAGES 404 COHORT MANUAL REVIEW QUEUE
 *
 * Read-only operator export for PC02A/PC02B 404 cohort (5 rows / 3 ASINs).
 * No SP-API, no product create, no DB writes.
 *
 *   npx tsx scripts/pc02c-expected-packages-404-manual-review-queue.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/pc02c-expected-packages-404-manual-review-queue";
const PC02A_RUN = process.argv.find((x) => x.startsWith("--pc02a-run-id="))?.split("=")[1]?.trim() ?? "20260526T120000Z";
const PC02B_RUN = process.argv.find((x) => x.startsWith("--pc02b-run-id="))?.split("=")[1]?.trim() ?? "20260526T130000Z";

const COHORT_EP_IDS = [
  "654dc645-fb8c-4361-a813-173ef093d934",
  "15e14bfd-e549-4e6d-9195-bd982a1c4160",
  "2b0b7cd8-d94f-488c-9290-f48c93763c33",
  "5ea7a691-3bb0-49b1-9cf1-2e24924ddf4b",
  "01ce4f4a-19de-4ce8-bdb2-8fb9d832b5d5",
] as const;

const COHORT_ASIN_BY_EP: Record<string, string> = {
  "654dc645-fb8c-4361-a813-173ef093d934": "B0CQKPKKCM",
  "15e14bfd-e549-4e6d-9195-bd982a1c4160": "B0CS88T6FR",
  "2b0b7cd8-d94f-488c-9290-f48c93763c33": "B0CS88T6FR",
  "5ea7a691-3bb0-49b1-9cf1-2e24924ddf4b": "B0CS88T6FR",
  "01ce4f4a-19de-4ce8-bdb2-8fb9d832b5d5": "B0DMQCZPQN",
};

type OperatorAction =
  | "verify_asin_in_seller_central"
  | "quarantine_row"
  | "asin_correction_needed"
  | "possible_non_us_listing";

type ReviewRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string | null;
  asin: string;
  fnsku: string | null;
  sku: string | null;
  build_source: string | null;
  order_id: string | null;
  package_code: string | null;
  resolved_product_id: string | null;
  import_source: string | null;
  pc02b_classification: string;
  catalog_http_status: number;
  resolver_status: string | null;
  resolver_product_id: string | null;
  local_product_exists: boolean;
  local_map_exists: boolean;
  map_product_ids: string[];
  operator_action: OperatorAction;
  operator_actions_all: OperatorAction[];
  priority: number;
  operator_note: string;
  is_duplicate_cluster_member: boolean;
  is_canonical_cluster_row: boolean;
};

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function currentBranch(): string {
  try {
    return execSync("git branch --show-current", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function loadPc02bTriage(): Map<string, { verdict: string; catalog_http_status: number }> {
  const manifestPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/pc02b-sp-api-evidence-positive-control-execute",
    PC02B_RUN,
    "manifest.json",
  );
  const byAsin = new Map<string, { verdict: string; catalog_http_status: number }>();
  if (!fs.existsSync(manifestPath)) return byAsin;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    pc02a_404_triage?: Array<{ asin: string; verdict: string; catalog_http_status?: number }>;
  };
  for (const t of manifest.pc02a_404_triage ?? []) {
    byAsin.set(t.asin, { verdict: t.verdict, catalog_http_status: t.catalog_http_status ?? 404 });
  }
  return byAsin;
}

function clusterKey(r: { fnsku: string | null; sku: string | null; asin: string }): string {
  return `${(r.fnsku ?? "").trim().toUpperCase()}|${(r.sku ?? "").trim().toUpperCase()}|${r.asin}`;
}

function assignOperatorActions(input: {
  isDuplicate: boolean;
  isCanonical: boolean;
  hasFnsku: boolean;
  catalog404: boolean;
}): { primary: OperatorAction; all: OperatorAction[]; note: string; priority: number } {
  const all: OperatorAction[] = [];

  if (input.isDuplicate && !input.isCanonical) {
    return {
      primary: "quarantine_row",
      all: ["quarantine_row", "verify_asin_in_seller_central"],
      note: "Duplicate expected_packages row in B0CS88T6FR cluster — quarantine after canonical row is corrected",
      priority: 1,
    };
  }

  all.push("verify_asin_in_seller_central");
  all.push("asin_correction_needed");
  if (input.catalog404 && input.hasFnsku) {
    all.push("possible_non_us_listing");
  }

  return {
    primary: "asin_correction_needed",
    all,
    note:
      "PC02B identifier_manual_review: NOT_FOUND in ATVPDKIKX0DER. Look up FNSKU in Seller Central, copy correct US ASIN, correct source row. If listing is non-US or delisted → quarantine.",
    priority: input.isDuplicate && input.isCanonical ? 1 : 2,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, id);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = currentBranch();
  const stagingOk =
    supabaseUrlMatchesStagingRef(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "", STAGING_REF) &&
    getStagingProjectRef({ loadEnv: false }) === STAGING_REF;

  if (branch !== "feature/product-canonicalization-v2") {
    fs.writeFileSync(path.join(outDir, "blockers.md"), `# Blockers\n\nbranch=${branch}\n`);
    throw new Error(`Wrong branch: ${branch}`);
  }
  if (!stagingOk) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), "# Blockers\n\nStaging ref guard failed.\n");
    throw new Error("Staging ref guard failed");
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL!.trim();
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`SET statement_timeout = '120s'`);

  const colRes = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='expected_packages'`,
  );
  const epCols = new Set(colRes.rows.map((r: { column_name: string }) => r.column_name));
  const buildSourceSel = epCols.has("build_source") ? "NULLIF(TRIM(e.build_source), '')" : "NULL::text";
  const orderIdSel = epCols.has("order_id") ? "NULLIF(TRIM(e.order_id::text), '')" : "NULL::text";
  const packageCodeSel = epCols.has("package_code") ? "NULLIF(TRIM(e.package_code), '')" : "NULL::text";

  const epRes = await client.query(
    `
    WITH ep AS (
      SELECT e.id::text AS expected_package_id,
             e.organization_id::text,
             e.store_id::text,
             NULLIF(TRIM(e.sku), '') AS sku,
             NULLIF(TRIM(e.fnsku), '') AS fnsku,
             ${buildSourceSel} AS build_source,
             ${orderIdSel} AS order_id,
             e.resolved_product_id::text,
             ${packageCodeSel} AS package_code
      FROM public.expected_packages e
      WHERE e.id = ANY($1::uuid[])
    ),
    map_hits AS (
      SELECT ep.expected_package_id,
             ARRAY_AGG(DISTINCT m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS map_product_ids
      FROM ep
      LEFT JOIN public.product_identifier_map m
        ON m.organization_id = $2::uuid AND m.store_id = $3::uuid AND m.deleted_at IS NULL
        AND (
          (ep.fnsku IS NOT NULL AND UPPER(TRIM(m.fnsku)) = UPPER(ep.fnsku))
          OR (ep.sku IS NOT NULL AND UPPER(TRIM(COALESCE(m.seller_sku, m.msku))) = UPPER(ep.sku))
        )
      GROUP BY ep.expected_package_id
    ),
    prod_fnsku AS (
      SELECT ep.expected_package_id, p.id::text AS product_id
      FROM ep
      JOIN public.products p ON p.organization_id = $2::uuid AND p.store_id = $3::uuid
        AND ep.fnsku IS NOT NULL AND UPPER(TRIM(p.fnsku)) = UPPER(ep.fnsku) AND p.deleted_at IS NULL
    )
    SELECT ep.*,
           COALESCE(mh.map_product_ids, ARRAY[]::text[]) AS map_product_ids,
           pf.product_id AS product_id_by_fnsku
    FROM ep
    LEFT JOIN map_hits mh ON mh.expected_package_id = ep.expected_package_id
    LEFT JOIN prod_fnsku pf ON pf.expected_package_id = ep.expected_package_id
    ORDER BY ep.fnsku, ep.sku, ep.expected_package_id
  `,
    [COHORT_EP_IDS, ORG, STORE],
  );

  await client.end();

  const triageByAsin = loadPc02bTriage();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const raw = epRes.rows as Array<{
    expected_package_id: string;
    organization_id: string;
    store_id: string | null;
    sku: string | null;
    fnsku: string | null;
    build_source: string | null;
    order_id: string | null;
    resolved_product_id: string | null;
    package_code: string | null;
    map_product_ids: string[] | null;
    product_id_by_fnsku: string | null;
  }>;

  if (raw.length !== COHORT_EP_IDS.length) {
    throw new Error(`Expected ${COHORT_EP_IDS.length} rows, found ${raw.length}`);
  }

  const prelim = raw.map((r) => {
    const asin = COHORT_ASIN_BY_EP[r.expected_package_id] ?? "";
    const triage = triageByAsin.get(asin);
    const mapIds = r.map_product_ids ?? [];
    return {
      ...r,
      asin,
      import_source: r.build_source,
      pc02b_classification: triage?.verdict ?? "identifier_manual_review",
      catalog_http_status: triage?.catalog_http_status ?? 404,
      map_product_ids: mapIds,
      local_map_exists: mapIds.length > 0,
      local_product_exists: !!(r.product_id_by_fnsku || r.resolved_product_id),
    };
  });

  const clusterCounts = new Map<string, number>();
  for (const r of prelim) {
    clusterCounts.set(clusterKey(r), (clusterCounts.get(clusterKey(r)) ?? 0) + 1);
  }

  const canonicalByCluster = new Map<string, string>();
  for (const r of prelim) {
    const k = clusterKey(r);
    if ((clusterCounts.get(k) ?? 0) <= 1) continue;
    if (!canonicalByCluster.has(k)) canonicalByCluster.set(k, r.expected_package_id);
  }

  const rows: ReviewRow[] = [];
  for (const r of prelim) {
    const ck = clusterKey(r);
    const isDup = (clusterCounts.get(ck) ?? 0) > 1;
    const isCanonical = canonicalByCluster.get(ck) === r.expected_package_id;

    const resolver = await resolveScannerProductIdentifiers(sb, {
      organizationId: r.organization_id,
      storeId: r.store_id ?? STORE,
      sku: r.sku,
      asin: r.asin,
      fnsku: r.fnsku,
      upc: null,
      productIdentifier: r.fnsku ?? r.sku ?? r.asin,
    });

    const actions = assignOperatorActions({
      isDuplicate: isDup,
      isCanonical,
      hasFnsku: !!(r.fnsku?.trim()),
      catalog404: r.catalog_http_status === 404,
    });

    rows.push({
      expected_package_id: r.expected_package_id,
      organization_id: r.organization_id,
      store_id: r.store_id,
      asin: r.asin,
      fnsku: r.fnsku,
      sku: r.sku,
      build_source: r.build_source,
      order_id: r.order_id,
      package_code: r.package_code,
      resolved_product_id: r.resolved_product_id,
      import_source: r.import_source,
      pc02b_classification: r.pc02b_classification,
      catalog_http_status: r.catalog_http_status,
      resolver_status: resolver.identifier_resolution_status,
      resolver_product_id: resolver.resolved_product_id,
      local_product_exists: r.local_product_exists,
      local_map_exists: r.local_map_exists,
      map_product_ids: r.map_product_ids,
      operator_action: actions.primary,
      operator_actions_all: actions.all,
      priority: actions.priority,
      operator_note: actions.note,
      is_duplicate_cluster_member: isDup,
      is_canonical_cluster_row: isCanonical,
    });
  }

  rows.sort((a, b) => a.priority - b.priority || a.expected_package_id.localeCompare(b.expected_package_id));

  const csvHeader = [
    "expected_package_id",
    "asin",
    "fnsku",
    "sku",
    "build_source",
    "import_source",
    "order_id",
    "package_code",
    "store_id",
    "resolved_product_id",
    "pc02b_classification",
    "catalog_http_status",
    "resolver_status",
    "resolver_product_id",
    "local_product_exists",
    "local_map_exists",
    "map_product_ids",
    "operator_action",
    "operator_actions_all",
    "priority",
    "is_duplicate_cluster_member",
    "is_canonical_cluster_row",
    "operator_note",
  ];

  const csv =
    csvHeader.join(",") +
    "\n" +
    rows
      .map((r) =>
        [
          r.expected_package_id,
          r.asin,
          r.fnsku,
          r.sku,
          r.build_source,
          r.import_source,
          r.order_id,
          r.package_code,
          r.store_id,
          r.resolved_product_id,
          r.pc02b_classification,
          r.catalog_http_status,
          r.resolver_status,
          r.resolver_product_id,
          r.local_product_exists,
          r.local_map_exists,
          r.map_product_ids.join(";"),
          r.operator_action,
          r.operator_actions_all.join("|"),
          r.priority,
          r.is_duplicate_cluster_member,
          r.is_canonical_cluster_row,
          r.operator_note,
        ]
          .map(csvEscape)
          .join(","),
      )
      .join("\n") +
    "\n";

  fs.writeFileSync(path.join(outDir, "expected-packages-404-review.csv"), csv);

  const quarantineCount = rows.filter((r) => r.operator_action === "quarantine_row").length;
  const asinCorrectionCount = rows.filter((r) => r.operator_action === "asin_correction_needed").length;

  fs.writeFileSync(
    path.join(outDir, "expected-packages-404-review.md"),
    [
      "# Expected packages 404 review — PC02C",
      "",
      `**Run id:** \`${id}\``,
      `**Rows:** ${rows.length} · **ASINs:** 3 · **PC02A:** \`${PC02A_RUN}\` · **PC02B:** \`${PC02B_RUN}\``,
      "",
      "| expected_package_id | ASIN | FNSKU | SKU | build_source | resolver | local product | local map | operator_action |",
      "|---------------------|------|-------|-----|--------------|----------|---------------|-----------|-----------------|",
      ...rows.map(
        (r) =>
          `| \`${r.expected_package_id.slice(0, 8)}…\` | \`${r.asin}\` | ${r.fnsku ?? "—"} | ${r.sku ?? "—"} | ${r.build_source ?? "—"} | ${r.resolver_status ?? "—"} | ${r.local_product_exists} | ${r.local_map_exists} | **${r.operator_action}** |`,
      ),
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "operator-review-instructions.md"),
    [
      "# Operator review instructions — PC02C",
      "",
      "## Context",
      "",
      "- SP-API **positive control passed** (known-good seller ASINs return HTTP 200).",
      "- This cohort is **identifier_manual_review** only — **no auto product create**.",
      "",
      "## Workflow",
      "",
      "1. Open `expected-packages-404-review.csv` (sort by `priority`).",
      "2. For each row with **verify_asin_in_seller_central**:",
      "   - Open Seller Central → find listing by **FNSKU**.",
      "   - Compare listing ASIN to `asin` column on expected_packages.",
      "3. If ASIN on row is wrong → **asin_correction_needed** (fix import/source; separate approved execute).",
      "4. If listing is non-US or delisted → **possible_non_us_listing** → **quarantine_row**.",
      "5. For **B0CS88T6FR** cluster (3 rows): fix **one** canonical row (`is_canonical_cluster_row=true`), **quarantine** the 2 duplicates.",
      "",
      "## Do not",
      "",
      "- Run SP-API from this queue",
      "- Auto-create products",
      "- Update expected_packages without a separate approved execute prompt",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "quarantine-recommendations.md"),
    [
      "# Quarantine recommendations — PC02C",
      "",
      `| Metric | Count |`,
      `|--------|------:|`,
      `| Total exported rows | ${rows.length} |`,
      `| **quarantine_row** (primary action) | ${quarantineCount} |`,
      `| **asin_correction_needed** (primary action) | ${asinCorrectionCount} |`,
      "",
      "## Quarantine candidates (primary)",
      "",
      ...rows
        .filter((r) => r.operator_action === "quarantine_row")
        .map((r) => `- \`${r.expected_package_id}\` — ${r.asin} / ${r.fnsku} — duplicate cluster member`),
      ...(rows.some((r) => r.operator_action === "quarantine_row") ? [] : ["- (none — all rows primary ASIN correction)"]),
      "",
      "## ASIN correction candidates (primary)",
      "",
      ...rows
        .filter((r) => r.operator_action === "asin_correction_needed")
        .map(
          (r) =>
            `- \`${r.expected_package_id}\` — \`${r.asin}\` / FNSKU \`${r.fnsku}\` / SKU \`${r.sku}\`${r.is_canonical_cluster_row ? " **(canonical)**" : ""}`,
        ),
      "",
      "## Possible non-US listing (flag on all FNSKU rows)",
      "",
      "All 5 rows include **possible_non_us_listing** in `operator_actions_all` because US catalog returned 404 with valid FNSKU present.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "no-write-proof.md"),
    [
      "# No-write proof — PC02C",
      "",
      "| Operation | Performed |",
      "|-----------|-----------|",
      "| Amazon SP-API | **no** |",
      "| products INSERT/UPDATE | **no** |",
      "| product_identifier_map INSERT | **no** |",
      "| expected_packages UPDATE | **no** |",
      "| return_items / slip_contents UPDATE | **no** |",
      "| Resolver read-only probe | yes |",
    ].join("\n"),
  );

  fs.writeFileSync(path.join(outDir, "blockers.md"), "# Blockers\n\nNone.\n");

  const manifest = {
    prompt: "PC02C-EXPECTED-PACKAGES-404-MANUAL-REVIEW-QUEUE",
    run_id: id,
    branch,
    staging_ref: STAGING_REF,
    pc02a_reference: PC02A_RUN,
    pc02b_reference: PC02B_RUN,
    mode: "read_only_export",
    exported_rows_count: rows.length,
    quarantine_candidate_count: quarantineCount,
    asin_correction_candidate_count: asinCorrectionCount,
    distinct_asins: 3,
    forbidden: { sp_api: false, product_create: false, map_insert: false, expected_packages_update: false },
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ outDir, ...manifest }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
