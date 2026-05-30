/**
 * NEDA-VS-MAIN-PRODUCT-RESOLUTION-PARITY-CENSUS (read-only)
 *
 *   npx tsx scripts/neda-vs-main-product-resolution-parity-census-readonly.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const OUT_BASE = ".cursor/audit-reports/neda-vs-main-product-resolution-parity-census";

const TRACKING = "1552698729";
const FNSKU = "X003SRBCH";
const SKU = "B0112V2AQM-VEN";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function viewColumns(client: pg.Client, viewName: string): Promise<string[]> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [viewName],
  );
  return r.rows.map((x: { column_name: string }) => x.column_name);
}

async function tableColumns(client: pg.Client, tableName: string): Promise<string[]> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [tableName],
  );
  return r.rows.map((x: { column_name: string }) => x.column_name);
}

function pickCols(available: string[], wanted: string[]): string {
  return wanted.filter((c) => available.includes(c)).join(", ") || "id";
}

async function censusRef(
  label: string,
  ref: string,
  connUrl: string,
): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: connUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const itemCols = await viewColumns(client, "v_inventory_item_status");
    const scannedCols = await viewColumns(client, "v_scanned_items_counted");

    const epCols = await tableColumns(client, "expected_packages");
    const epSelect = pickCols(epCols, [
      "id",
      "organization_id",
      "store_id",
      "tracking_number",
      "sku",
      "fnsku",
      "expected_scan_quantity",
      "resolved_product_id",
      "resolved_catalog_product_id",
      "identifier_resolution_status",
      "identifier_resolution_confidence",
      "expected_product_id",
    ]);

    const epByTracking = await client.query(
      `SELECT ${epSelect}
       FROM public.expected_packages
       WHERE tracking_number ILIKE $1 OR tracking_number ILIKE $2
       ORDER BY expected_scan_quantity DESC NULLS LAST
       LIMIT 50`,
      [`%${TRACKING}%`, TRACKING],
    );

    const epByFnsku = await client.query(
      `SELECT ${epSelect}
       FROM public.expected_packages
       WHERE upper(trim(fnsku)) = upper($1)
       LIMIT 20`,
      [FNSKU],
    );

    const epBySku = await client.query(
      `SELECT ${epSelect}
       FROM public.expected_packages
       WHERE upper(trim(sku)) = upper($1)
       LIMIT 20`,
      [SKU],
    );

    const epQty216 = await client.query(
      `SELECT ${epSelect}
       FROM public.expected_packages
       WHERE expected_scan_quantity = 216
         AND (upper(trim(fnsku)) = upper($1) OR upper(trim(sku)) = upper($2) OR tracking_number ILIKE $3)
       LIMIT 20`,
      [FNSKU, SKU, `%${TRACKING}%`],
    );

    const mapByFnsku = await client.query(
      `SELECT id, organization_id, store_id, product_id, fnsku, seller_sku, match_source, deleted_at
       FROM public.product_identifier_map
       WHERE upper(trim(fnsku)) = upper($1) AND deleted_at IS NULL
       LIMIT 30`,
      [FNSKU],
    );

    const mapBySku = await client.query(
      `SELECT id, organization_id, store_id, product_id, fnsku, seller_sku, match_source, deleted_at
       FROM public.product_identifier_map
       WHERE upper(trim(seller_sku)) = upper($1) AND deleted_at IS NULL
       LIMIT 30`,
      [SKU],
    );

    let viewByTracking: pg.QueryResult | null = null;
    let viewByFnsku: pg.QueryResult | null = null;
    let viewErr: string | null = null;
    try {
      if (itemCols.includes("tracking_number")) {
        viewByTracking = await client.query(
          `SELECT * FROM public.v_inventory_item_status
           WHERE tracking_number ILIKE $1 OR tracking_number ILIKE $2
           LIMIT 30`,
          [`%${TRACKING}%`, TRACKING],
        );
      }
      if (itemCols.includes("fnsku")) {
        viewByFnsku = await client.query(
          `SELECT * FROM public.v_inventory_item_status WHERE upper(trim(fnsku)) = upper($1) LIMIT 20`,
          [FNSKU],
        );
      }
    } catch (e) {
      viewErr = e instanceof Error ? e.message : String(e);
    }

    const productsForResolved = await client.query(
      `SELECT DISTINCT p.id, p.organization_id, p.store_id, p.product_name, p.sku, p.fnsku
       FROM public.products p
       WHERE p.id IN (
         SELECT resolved_product_id FROM public.expected_packages
         WHERE upper(trim(fnsku)) = upper($1) OR upper(trim(sku)) = upper($2)
           AND resolved_product_id IS NOT NULL
       )
       OR p.id IN (
         SELECT product_id FROM public.product_identifier_map
         WHERE (upper(trim(fnsku)) = upper($1) OR upper(trim(seller_sku)) = upper($2))
           AND deleted_at IS NULL
       )
       LIMIT 20`,
      [FNSKU, SKU],
    );

    return {
      label,
      ref,
      view_columns: {
        v_inventory_item_status: itemCols,
        v_scanned_items_counted: scannedCols,
      },
      linkage_columns_present: {
        expected_package_id: itemCols.includes("expected_package_id"),
        resolved_product_id: itemCols.includes("resolved_product_id"),
        product_name: itemCols.includes("product_name"),
        product_display_name: itemCols.includes("product_display_name"),
        product_linkage_status: itemCols.includes("product_linkage_status"),
        identifier_resolution_status: itemCols.includes("identifier_resolution_status"),
      },
      expected_packages: {
        by_tracking_count: epByTracking.rowCount,
        by_tracking_sample: epByTracking.rows.slice(0, 5),
        by_fnsku_count: epByFnsku.rowCount,
        by_fnsku_sample: epByFnsku.rows.slice(0, 5),
        by_sku_count: epBySku.rowCount,
        by_sku_sample: epBySku.rows.slice(0, 5),
        qty_216_match: epQty216.rows,
      },
      product_identifier_map: {
        by_fnsku_count: mapByFnsku.rowCount,
        by_fnsku_sample: mapByFnsku.rows.slice(0, 10),
        by_sku_count: mapBySku.rowCount,
        by_sku_sample: mapBySku.rows.slice(0, 10),
        scoped_by_org_store: {
          fnsku_distinct_org_store: [
            ...new Set(
              mapByFnsku.rows.map(
                (r: { organization_id: string; store_id: string }) =>
                  `${r.organization_id}:${r.store_id}`,
              ),
            ),
          ],
          sku_distinct_org_store: [
            ...new Set(
              mapBySku.rows.map(
                (r: { organization_id: string; store_id: string }) =>
                  `${r.organization_id}:${r.store_id}`,
              ),
            ),
          ],
        },
      },
      v_inventory_item_status: {
        query_error: viewErr,
        by_tracking_count: viewByTracking?.rowCount ?? 0,
        by_tracking_sample: viewByTracking?.rows?.slice(0, 5) ?? [],
        by_fnsku_count: viewByFnsku?.rowCount ?? 0,
        by_fnsku_sample: viewByFnsku?.rows?.slice(0, 5) ?? [],
      },
      products_join: productsForResolved.rows,
    };
  } finally {
    await client.end();
  }
}

function envSnapshot(): Record<string, unknown> {
  return {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
    NEXT_PUBLIC_STORE_ID: process.env.NEXT_PUBLIC_STORE_ID ?? null,
    STAGING_PROJECT_REF: process.env.STAGING_PROJECT_REF ?? null,
    ORIGINAL_PROJECT_REF: process.env.ORIGINAL_PROJECT_REF ?? null,
    inferred_main_local_ref: (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF)
      ? STAGING_REF
      : (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(ORIGINAL_REF)
        ? ORIGINAL_REF
        : "unknown",
    neda_handoff_staging_ref: STAGING_REF,
    neda_handoff_production_app_db: ORIGINAL_REF,
    note: "Neda local dev scripts default to port 3001; ref follows whichever Supabase URL the dev process loads from .env.local",
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";

  const blockers: string[] = [];
  if (!stagingUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL missing");
  if (!originalUrl) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL missing");

  const env = envSnapshot();
  let staging: Record<string, unknown> | null = null;
  let original: Record<string, unknown> | null = null;

  if (stagingUrl) staging = await censusRef("staging", STAGING_REF, stagingUrl);
  if (originalUrl) original = await censusRef("original", ORIGINAL_REF, originalUrl);

  const colDiff: Record<string, { staging_only: string[]; original_only: string[]; shared: string[] }> = {};
  if (staging && original) {
    const sCols = (staging.view_columns as { v_inventory_item_status: string[] }).v_inventory_item_status;
    const oCols = (original.view_columns as { v_inventory_item_status: string[] }).v_inventory_item_status;
    colDiff.v_inventory_item_status = {
      staging_only: sCols.filter((c) => !oCols.includes(c)),
      original_only: oCols.filter((c) => !sCols.includes(c)),
      shared: sCols.filter((c) => oCols.includes(c)),
    };
  }

  fs.writeFileSync(path.join(outDir, "census.json"), JSON.stringify({ env, staging, original, colDiff }, null, 2));

  const report = buildReport(env, staging, original, colDiff, blockers);
  fs.writeFileSync(path.join(outDir, "report.md"), report);
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "NEDA-VS-MAIN-PRODUCT-RESOLUTION-PARITY-CENSUS",
        run_id: runId,
        mode: "read_only",
        test_case: { tracking: TRACKING, fnsku: FNSKU, sku: SKU, qty: 216 },
        refs: { staging: STAGING_REF, original: ORIGINAL_REF },
        main_local_inferred_ref: env.inferred_main_local_ref,
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ run_id: runId, outDir, blockers }, null, 2));
}

function buildReport(
  env: Record<string, unknown>,
  staging: Record<string, unknown> | null,
  original: Record<string, unknown> | null,
  colDiff: Record<string, unknown>,
  blockers: string[],
): string {
  const s = staging as Record<string, any> | null;
  const o = original as Record<string, any> | null;
  const lines: string[] = [
    "# NEDA vs Main product resolution parity census",
    "",
    "**Mode:** read-only · **No DB writes**",
    "",
    "## Env / ref answers",
    "",
    "| Question | Answer |",
    "|----------|--------|",
    `| 1. Which ref is Neda using? | Handoff: staging/preview **${STAGING_REF}**; production app DB **${ORIGINAL_REF}**. Local Neda dev uses whatever \`.env.local\` loads (currently **${env.inferred_main_local_ref}** on this machine). |`,
    `| 2. Which ref is Main local using? | \`NEXT_PUBLIC_SUPABASE_URL\` → **${env.inferred_main_local_ref}** (\`${env.NEXT_PUBLIC_SUPABASE_URL}\`) |`,
    `| Main \`NEXT_PUBLIC_STORE_ID\` | \`${env.NEXT_PUBLIC_STORE_ID ?? "(not set)"}\` |`,
    "",
    "## Test case",
    "",
    `- Tracking: \`${TRACKING}\``,
    `- FNSKU: \`${FNSKU}\``,
    `- SKU: \`${SKU}\``,
    `- Expected qty: **216**`,
    "",
  ];

  if (blockers.length) {
    lines.push("## Blockers", "", ...blockers.map((b) => `- ${b}`), "");
  }

  for (const [label, data] of [
    ["Staging", s],
    ["Original", o],
  ] as const) {
    if (!data) continue;
    lines.push(`## ${label} (\`${data.ref}\`)`, "");
    lines.push("### View linkage columns", "");
    lines.push("```json");
    lines.push(JSON.stringify(data.linkage_columns_present, null, 2));
    lines.push("```", "");
    lines.push("### expected_packages", "");
    lines.push(`- By tracking: **${data.expected_packages.by_tracking_count}** rows`);
    lines.push(`- By FNSKU: **${data.expected_packages.by_fnsku_count}** rows`);
    lines.push(`- By SKU: **${data.expected_packages.by_sku_count}** rows`);
    lines.push(`- Qty=216 intersection: **${data.expected_packages.qty_216_match?.length ?? 0}** rows`);
    if (data.expected_packages.qty_216_match?.length) {
      lines.push("", "```json");
      lines.push(JSON.stringify(data.expected_packages.qty_216_match, null, 2));
      lines.push("```");
    }
    lines.push("", "### product_identifier_map (scoped org+store)", "");
    lines.push(`- FNSKU rows: **${data.product_identifier_map.by_fnsku_count}**`);
    lines.push(`- SKU/seller_sku rows: **${data.product_identifier_map.by_sku_count}**`);
    lines.push(
      `- Distinct org:store (FNSKU): ${JSON.stringify(data.product_identifier_map.scoped_by_org_store.fnsku_distinct_org_store)}`,
    );
    lines.push(
      `- Distinct org:store (SKU): ${JSON.stringify(data.product_identifier_map.scoped_by_org_store.sku_distinct_org_store)}`,
    );
    if (data.product_identifier_map.by_fnsku_sample?.length) {
      lines.push("", "FNSKU map sample:", "```json");
      lines.push(JSON.stringify(data.product_identifier_map.by_fnsku_sample, null, 2));
      lines.push("```");
    }
    lines.push("", "### v_inventory_item_status", "");
    if (data.v_inventory_item_status.query_error) {
      lines.push(`- Query error: \`${data.v_inventory_item_status.query_error}\``);
    }
    lines.push(`- By tracking: **${data.v_inventory_item_status.by_tracking_count}**`);
    lines.push(`- By FNSKU: **${data.v_inventory_item_status.by_fnsku_count}**`);
    if (data.v_inventory_item_status.by_fnsku_sample?.length) {
      lines.push("", "```json");
      lines.push(JSON.stringify(data.v_inventory_item_status.by_fnsku_sample, null, 2));
      lines.push("```");
    }
    lines.push("");
  }

  lines.push("## View column diff (staging vs original)", "", "```json");
  lines.push(JSON.stringify(colDiff, null, 2));
  lines.push("```", "");

  lines.push("## Root cause classification", "");
  lines.push(classifyRootCause(s, o, env));
  lines.push("", "## Smallest safe fix", "");
  lines.push(smallestFix(s, o, env));

  return lines.join("\n");
}

function classifyRootCause(
  s: Record<string, any> | null,
  o: Record<string, any> | null,
  env: Record<string, unknown>,
): string {
  const parts: string[] = [];
  if (env.inferred_main_local_ref === STAGING_REF) {
    parts.push(
      "- **Env:** Main local `.env.local` points at **staging** (`eiqfaapyumhixxoeltgu`), same ref Neda handoff documents for preview — not an ref mismatch between Neda/Main on this machine.",
    );
  } else if (env.inferred_main_local_ref === ORIGINAL_REF) {
    parts.push("- **Env:** Main local points at **original** ref.");
  }

  const sMap = s?.product_identifier_map?.by_fnsku_count ?? 0;
  const oMap = o?.product_identifier_map?.by_fnsku_count ?? 0;
  const sEpResolved =
    (s?.expected_packages?.by_fnsku_sample as Array<{ resolved_product_id?: string }>)?.some(
      (r) => r.resolved_product_id,
    ) ?? false;
  const sViewName = (s?.v_inventory_item_status?.by_fnsku_sample as Array<{ product_name?: string }>)?.[0]
    ?.product_name;

  if (s && !s.linkage_columns_present?.expected_package_id) {
    parts.push(
      "- **View gap:** `v_inventory_item_status` lacks `expected_package_id` — UI cannot join inventory line → `expected_packages` for EP-resolved name.",
    );
  }
  if (s && s.linkage_columns_present?.resolved_product_id && !sViewName && sEpResolved) {
    parts.push(
      "- **View gap:** `resolved_product_id` on EP but view `product_name` NULL — display snapshot not projected from `products.product_name`.",
    );
  }
  if (sMap === 0 && oMap > 0) {
    parts.push("- **Data gap:** map row exists on original but not staging (or vice versa).");
  }
  parts.push(
    "- **App mapper:** `productLinkageOperatorPrimaryDisplayLabel` treats status `matched` (and view `product_name` in fallback only) as **\"No product link yet\"** when `product_name` map lookup empty — see `lib/scanner/product-linkage-display-contract.ts`.",
  );
  if (!env.NEXT_PUBLIC_STORE_ID) {
    parts.push(
      "- **Store scope:** `NEXT_PUBLIC_STORE_ID` unset — operator must pick store; wrong/missing store breaks org+store scoped map/EP joins.",
    );
  }
  return parts.join("\n");
}

function smallestFix(
  s: Record<string, any> | null,
  o: Record<string, any> | null,
  env: Record<string, unknown>,
): string {
  const fixes: string[] = [];
  if (s && !s.linkage_columns_present?.expected_package_id) {
    fixes.push(
      "1. **View DDL (read-only plan first):** Add `expected_package_id`, `resolved_product_id`, `product_display_name` (= `products.product_name` join), `product_linkage_status` to `v_inventory_item_status` — mirror db-parity linkage SQL; apply staging then original with approval.",
    );
  }
  fixes.push(
    "2. **UI mapper (code):** Treat `matched` + `resolved_product_id` + view `product_name`/`product_display_name` as display-resolved; prefer view snapshot before extra `products` fetch (`pickInventoryViewHints`, `buildInventoryViewProductLinkage`, `productLinkageOperatorPrimaryDisplayLabel`).",
  );
  if (!env.NEXT_PUBLIC_STORE_ID) {
    fixes.push(
      "3. **Env:** Set `NEXT_PUBLIC_STORE_ID` to the store_id on the EP/map rows for this shipment (kiosk) or ensure operator selects the same store Neda uses.",
    );
  }
  const sEp = s?.expected_packages?.qty_216_match?.[0];
  if (sEp && !sEp.resolved_product_id && (s?.product_identifier_map?.by_fnsku_count ?? 0) > 0) {
    fixes.push(
      "4. **Data (governed, separate prompt):** Backfill `expected_packages.resolved_product_id` from scoped map — **not** in this census; requires operator approval.",
    );
  }
  return fixes.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
