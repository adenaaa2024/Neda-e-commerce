/**
 * PHASE-ORIGINAL-PRODUCT-LINK-NO-LINK-REGRESSION-AUDIT-V1
 * Read-only regression audit — original DB + current branch readmodel/UI contract.
 *
 *   npx tsx scripts/phase-original-product-link-no-link-regression-audit-v1-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { mapRowToProductLinkageDisplayContract } from "../lib/product-linkage-display-contract";
import {
  PRODUCT_LINKAGE_LABEL_NO_LINK,
  productLinkageUserStatusLabel,
} from "../lib/product-linkage-display-ui";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import {
  buildInventoryViewProductLinkage,
  buildExpectedPackageProductLinkage,
} from "../lib/scanner/expected-packages-read-contract";
import {
  buildProductLinkageDisplayContract,
  PRODUCT_LINKAGE_UNMAPPED_LABEL,
  productLinkageOperatorPrimaryDisplayLabel,
} from "../lib/scanner/product-linkage-display-contract";
import type { VInventoryStatusRow } from "../lib/scanner/v-inventory-status";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-original-product-link-no-link-regression-audit-v1";

const SAMPLES = [
  { label: "spine_asin", value: "B0000B11UX", kinds: ["asin", "fnsku"] as const },
  { label: "removal_fnsku", value: "X004LKS4VD", kinds: ["fnsku"] as const },
  { label: "reimb_heavy_fnsku", value: "X003VSWH37", kinds: ["fnsku"] as const },
];

type Row = Record<string, unknown>;

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function connectPg(url: string, ref: string): Promise<pg.Client> {
  if (!url.includes(ref)) throw new Error(`BLOCKED: URL must target ref ${ref}`);
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '180s'");
  await c.query("SET default_transaction_read_only = ON");
  return c;
}

async function spineCounts(c: pg.Client, orgId: string): Promise<Row> {
  const products = await c.query(
    `SELECT count(*)::int AS n FROM products WHERE organization_id = $1::uuid AND deleted_at IS NULL`,
    [orgId],
  );
  const map = await c.query(
    `SELECT count(*)::int AS n FROM product_identifier_map WHERE organization_id = $1::uuid AND deleted_at IS NULL`,
    [orgId],
  );
  const prices = await c.query(
    `SELECT count(*)::int AS n FROM product_prices pp
     JOIN products p ON p.id = pp.product_id
     WHERE p.organization_id = $1::uuid AND p.deleted_at IS NULL`,
    [orgId],
  );
  return {
    products: products.rows[0]?.n ?? 0,
    product_identifier_map: map.rows[0]?.n ?? 0,
    product_prices: prices.rows[0]?.n ?? 0,
  };
}

async function sampleByIdentifier(c: pg.Client, orgId: string, storeId: string, value: string): Promise<Row> {
  const upper = value.trim().toUpperCase();
  const mapRows = await c.query(
    `SELECT m.*, p.product_name, p.asin AS product_asin, p.sku AS product_sku
     FROM product_identifier_map m
     JOIN products p ON p.id = m.product_id AND p.deleted_at IS NULL
     WHERE m.organization_id = $1::uuid AND m.deleted_at IS NULL
       AND (
         upper(btrim(coalesce(m.asin,''))) = $2
         OR upper(btrim(coalesce(m.fnsku,''))) = $2
         OR upper(btrim(coalesce(m.seller_sku,''))) = $2
         OR upper(btrim(coalesce(m.msku,''))) = $2
         OR btrim(coalesce(m.upc_code,'')) = $3
       )
     ORDER BY m.last_seen_at DESC NULLS LAST
     LIMIT 10`,
    [orgId, upper, value.trim()],
  );

  const productIds = [...new Set(mapRows.rows.map((r: Row) => String(r.product_id)))];
  let prices: Row[] = [];
  if (productIds.length) {
    const pr = await c.query(
      `SELECT product_id, count(*)::int AS n, max(observed_at) AS latest
       FROM product_prices
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND product_id = ANY($3::uuid[])
       GROUP BY product_id`,
      [orgId, storeId, productIds],
    );
    prices = pr.rows as Row[];
  }

  let ep: Row[] = [];
  const epCols = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='expected_packages'`,
  );
  const epColSet = new Set(epCols.rows.map((x: { column_name: string }) => x.column_name));
  const epSelect = [
    "id",
    "resolved_product_id",
    "product_id",
    "identifier_resolution_status",
    "product_linkage_status",
    "sku",
    "fnsku",
    "asin",
    "store_id",
  ].filter((col) => epColSet.has(col));
  if (epSelect.length) {
    const idPredicates: string[] = [];
    if (epColSet.has("fnsku")) idPredicates.push("upper(btrim(coalesce(fnsku,''))) = $2");
    if (epColSet.has("asin")) idPredicates.push("upper(btrim(coalesce(asin,''))) = $2");
    if (epColSet.has("sku")) idPredicates.push("upper(btrim(coalesce(sku,''))) = $2");
    if (idPredicates.length) {
      const epWhere = epColSet.has("deleted_at")
        ? "organization_id = $1::uuid AND deleted_at IS NULL"
        : "organization_id = $1::uuid";
      const epOrder = epColSet.has("updated_at") ? "updated_at DESC NULLS LAST" : "id DESC";
      const epQ = await c.query(
        `SELECT ${epSelect.join(", ")}
         FROM expected_packages
         WHERE ${epWhere}
           AND (${idPredicates.join(" OR ")})
         ORDER BY ${epOrder}
         LIMIT 5`,
        [orgId, upper],
      );
      ep = epQ.rows as Row[];
    }
  }

  let inv: Row[] = [];
  const invExists = await c.query(
    `SELECT 1 FROM information_schema.views WHERE table_schema='public' AND table_name='v_inventory_item_status'`,
  );
  if (invExists.rowCount) {
    const cols = await c.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='v_inventory_item_status'`,
    );
    const colSet = new Set(cols.rows.map((x: { column_name: string }) => x.column_name));
    const selectCols = [
      "expected_package_id",
      "organization_id",
      "store_id",
      "resolved_product_id",
      "product_id",
      "product_linkage_status",
      "identifier_resolution_status",
      "product_name",
      "product_display_name",
      "fnsku",
      "asin",
      "sku",
    ].filter((c) => colSet.has(c));
    if (selectCols.length) {
      const invQ = await c.query(
        `SELECT ${selectCols.join(", ")}
         FROM v_inventory_item_status
         WHERE organization_id = $1::uuid
           AND (upper(btrim(coalesce(fnsku,''))) = $2 OR upper(btrim(coalesce(asin,''))) = $2)
         LIMIT 5`,
        [orgId, upper],
      );
      inv = invQ.rows as Row[];
    }
  }

  const reimb = await c.query(
    `SELECT count(*)::int AS n FROM amazon_reimbursements
     WHERE organization_id = $1::uuid AND upper(btrim(coalesce(fnsku,''))) = $2`,
    [orgId, upper],
  );

  return {
    identifier: value,
    map_rows: mapRows.rows,
    map_row_count: mapRows.rowCount,
    price_summary: prices,
    expected_packages_sample: ep,
    v_inventory_item_status_sample: inv,
    amazon_reimbursements_count: reimb.rows[0]?.n ?? 0,
  };
}

function runtimeEnvSnapshot(): Row {
  const pubUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const pubKeyRef = refFromSupabaseUrl(pubUrl);
  const origUrl = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  const origRef = refFromSupabaseUrl(origUrl);
  const directRef = refFromSupabaseUrl(process.env.DIRECT_POSTGRES_URL?.trim() ?? "");
  const origDirectRef = refFromSupabaseUrl(process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "");
  return {
    NEXT_PUBLIC_SUPABASE_URL_ref: pubKeyRef,
    ORIGINAL_SUPABASE_URL_ref: origRef,
    DIRECT_POSTGRES_URL_ref: directRef,
    ORIGINAL_DIRECT_POSTGRES_URL_ref: origDirectRef,
    NEXT_PUBLIC_STORE_ID: process.env.NEXT_PUBLIC_STORE_ID?.trim() ?? null,
    runtime_points_at_original: pubKeyRef === PRODUCTION_REF,
    runtime_env_mismatch:
      pubKeyRef !== PRODUCTION_REF && origRef === PRODUCTION_REF
        ? "NEXT_PUBLIC_SUPABASE_URL is staging but ORIGINAL_SUPABASE_URL is original — supabaseServer hits staging"
        : null,
  };
}

async function viewLinkageColumns(c: pg.Client): Promise<Row> {
  const views = ["v_inventory_item_status", "v_inventory_status"];
  const out: Row = {};
  for (const v of views) {
    const r = await c.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name = $1 ORDER BY ordinal_position`,
      [v],
    );
    const cols = r.rows.map((x: { column_name: string }) => x.column_name);
    out[v] = {
      present: cols.length > 0,
      columns: cols,
      has_resolved_product_id: cols.includes("resolved_product_id"),
      has_product_linkage_status: cols.includes("product_linkage_status"),
      has_product_name: cols.includes("product_name") || cols.includes("product_display_name"),
      has_expected_package_id: cols.includes("expected_package_id"),
    };
  }
  return out;
}

function uiLabelsFromRow(row: Row, productName?: string | null): Row {
  const contract = mapRowToProductLinkageDisplayContract({
    source_table: String(row.source_table ?? "audit"),
    source_row_id: String(row.source_row_id ?? "row"),
    row,
    product: productName ? { product_name: productName } : null,
  });
  const scannerSource = {
    resolved_product_id: row.resolved_product_id as string | null,
    product_id: row.product_id as string | null,
    identifier_resolution_status: row.identifier_resolution_status as string | null,
    identifier_resolution_confidence: row.identifier_resolution_confidence as number | null,
    product_name: productName ?? (row.product_name as string | null),
    fnsku: row.fnsku as string | null,
    sku: row.sku as string | null,
  };
  const nameMap = new Map<string, string>();
  const rid = String(row.resolved_product_id ?? row.product_id ?? "").trim();
  if (rid && productName) nameMap.set(rid, productName);
  const scannerLinkage = buildProductLinkageDisplayContract(scannerSource, nameMap);
  return {
    dashboard_contract: {
      is_resolved: contract.is_resolved,
      resolved_product_id: contract.resolved_product_id,
      identifier_resolution_status: contract.identifier_resolution_status,
      product_name: contract.product_name,
      user_status_label: productLinkageUserStatusLabel(contract),
      shows_no_link: productLinkageUserStatusLabel(contract) === PRODUCT_LINKAGE_LABEL_NO_LINK,
    },
    scanner_contract: {
      resolved_product_id: scannerLinkage.resolved_product_id,
      identifier_resolution_status: scannerLinkage.identifier_resolution_status,
      product_name: scannerLinkage.product_name,
      operator_primary_label: productLinkageOperatorPrimaryDisplayLabel(scannerLinkage),
      shows_no_link:
        productLinkageOperatorPrimaryDisplayLabel(scannerLinkage) === PRODUCT_LINKAGE_UNMAPPED_LABEL,
    },
  };
}

async function simulateResolver(
  sb: SupabaseClient,
  orgId: string,
  storeId: string | null,
  ids: { sku?: string; asin?: string; fnsku?: string; upc?: string },
): Promise<Row> {
  const withStore = await resolveScannerProductIdentifiers(sb, {
    organizationId: orgId,
    storeId,
    ...ids,
  });
  const noStore = await resolveScannerProductIdentifiers(sb, {
    organizationId: orgId,
    storeId: null,
    ...ids,
  });
  return { with_store: withStore, without_store: noStore };
}

async function rlsPolicySummary(c: pg.Client): Promise<Row> {
  const tables = ["product_identifier_map", "product_prices", "products"];
  const out: Row = {};
  for (const t of tables) {
    const r = await c.query(
      `SELECT polname, polcmd, polroles::regrole[] AS roles, pg_get_expr(polqual, polrelid) AS qual
       FROM pg_policy
       JOIN pg_class ON pg_class.oid = polrelid
       JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
       WHERE nspname = 'public' AND relname = $1`,
      [t],
    );
    out[t] = { policy_count: r.rowCount, policies: r.rows };
  }
  return out;
}

function rootCauseVerdict(payload: Row): Row {
  const counts = payload.original_product_spine_counts as Row;
  const env = payload.runtime_env as Row;
  const samples = payload.sample_product_link_results as Row[];
  const causes: string[] = [];

  if ((counts.products as number) === 0 || (counts.product_identifier_map as number) === 0) {
    causes.push("data_missing_spine");
  }

  if (env.runtime_env_mismatch) {
    causes.push("runtime_env_mismatch_staging_vs_original");
  }

  for (const s of samples) {
    const mapCount = (s.map_row_count as number) ?? 0;
    if (mapCount > 0) {
      const ui = s.ui_simulation as Row;
      const dash = ui?.dashboard_contract as Row;
      const scan = ui?.scanner_contract as Row;
      if (dash?.shows_no_link && scan?.shows_no_link) {
        const resolver = s.resolver_simulation as Row;
        const withStore = resolver?.with_store as Row;
        const epSample = (s.expected_packages_sample as Row[])?.[0];
        if (withStore?.identifier_resolution_status === "resolved" && withStore?.resolved_product_id) {
          if (!epSample?.resolved_product_id && epSample) {
            causes.push("operational_row_missing_resolved_product_id_despite_map");
          }
          if (!dash?.product_name && !scan?.product_name) {
            causes.push("readmodel_missing_product_name_hydration");
          }
        }
        if ((resolver?.without_store as Row)?.identifier_resolution_status === "unresolved") {
          causes.push("resolver_requires_store_id");
        }
        if (
          epSample?.product_linkage_status === "matched" &&
          !epSample?.resolved_product_id &&
          mapCount > 0
        ) {
          causes.push("view_status_matched_without_resolved_product_id");
        }
      }
    }
  }

  const unique = [...new Set(causes)];
  let root = "unknown";
  if (unique.includes("runtime_env_mismatch_staging_vs_original")) {
    root = "runtime_env_mismatch";
  } else if (unique.includes("data_missing_spine")) {
    root = "data_missing";
  } else if (unique.includes("operational_row_missing_resolved_product_id_despite_map")) {
    root = "resolver_join_regression_operational_unlinked";
  } else if (unique.includes("readmodel_missing_product_name_hydration")) {
    root = "ui_readmodel_product_name_hydration_regression";
  } else if (unique.includes("resolver_requires_store_id")) {
    root = "wrong_org_store_scope";
  } else if (unique.length) {
    root = unique[0]!;
  } else if ((counts.product_identifier_map as number) > 0) {
    root = "ui_readmodel_regression_likely";
  }

  const safe =
    root !== "data_missing" &&
    !unique.includes("runtime_env_mismatch_staging_vs_original") &&
    (counts.product_identifier_map as number) > 0;

  return {
    root_cause: root,
    contributing_factors: unique,
    SAFE_TO_FIX_NO_LINK: safe ? "yes" : "no",
  };
}

async function main() {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const runtimeEnv = runtimeEnvSnapshot();
  const pgUrl = productionPostgresUrl();
  const pgClient = await connectPg(pgUrl, PRODUCTION_REF);

  bindProductionSupabaseEnv();
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const spine = await spineCounts(pgClient, ORG);
  const viewCols = await viewLinkageColumns(pgClient);
  const rls = await rlsPolicySummary(pgClient);

  const sampleResults: Row[] = [];
  for (const sample of SAMPLES) {
    const data = await sampleByIdentifier(pgClient, ORG, STORE, sample.value);
    const map0 = (data.map_rows as Row[])?.[0];
    const productName = map0 ? String(map0.product_name ?? "") : null;
    const productId = map0 ? String(map0.product_id ?? "") : null;

    const ep0 = (data.expected_packages_sample as Row[])?.[0];
    const inv0 = (data.v_inventory_item_status_sample as Row[])?.[0];

    const resolver = await simulateResolver(sb, ORG, STORE, {
      fnsku: sample.kinds.includes("fnsku") ? sample.value : undefined,
      asin: sample.kinds.includes("asin") ? sample.value : undefined,
    });

    const uiFromEp = ep0
      ? uiLabelsFromRow(
          {
            ...ep0,
            source_table: "expected_packages",
            source_row_id: String(ep0.id),
          },
          productName,
        )
      : null;

    const uiFromInv = inv0
      ? uiLabelsFromRow(
          {
            ...inv0,
            source_table: "v_inventory_item_status",
            source_row_id: String(inv0.expected_package_id ?? "inv"),
          },
          productName,
        )
      : null;

    let invViewLinkage: Row | null = null;
    if (inv0) {
      const invRow = inv0 as unknown as VInventoryStatusRow;
      const nameMap = new Map<string, string>();
      if (productId && productName) nameMap.set(productId, productName);
      const linkage = buildInventoryViewProductLinkage(invRow, ep0 ?? null, nameMap);
      invViewLinkage = {
        operator_primary_label: productLinkageOperatorPrimaryDisplayLabel(linkage),
        resolved_product_id: linkage.resolved_product_id,
        product_name: linkage.product_name,
        identifier_resolution_status: linkage.identifier_resolution_status,
        shows_no_link:
          productLinkageOperatorPrimaryDisplayLabel(linkage) === PRODUCT_LINKAGE_UNMAPPED_LABEL,
      };
    }

    sampleResults.push({
      ...data,
      product_id_from_map: productId,
      product_name_from_map: productName,
      resolver_simulation: resolver,
      ui_simulation: {
        from_expected_package: uiFromEp,
        from_inventory_view: uiFromInv,
        buildInventoryViewProductLinkage: invViewLinkage,
      },
    });
  }

  const apiSimulation: Row = {
    note: "Product detail API requires organization_id + store_id; map/prices scoped to store",
    store_id_used: STORE,
    org_id_used: ORG,
    product_detail_would_404_if_wrong_store:
      "If UI passes wrong store_id, identifier_map and prices arrays empty while products row may still load",
  };

  const payload: Row = {
    phase: "PHASE-ORIGINAL-PRODUCT-LINK-NO-LINK-REGRESSION-AUDIT-V1",
    run_id: rid,
    target_ref: PRODUCTION_REF,
    org_id: ORG,
    store_id: STORE,
    no_data_mutation_verification: true,
    no_scanner_change_verification: true,
    original_product_spine_counts: spine,
    runtime_env: runtimeEnv,
    view_linkage_columns: viewCols,
    rls_policy_summary: rls,
    sample_product_link_results: sampleResults,
    api_payload_comparison: apiSimulation,
    no_link_label_source: {
      exact_strings: {
        dashboard: PRODUCT_LINKAGE_LABEL_NO_LINK,
        scanner: PRODUCT_LINKAGE_UNMAPPED_LABEL,
      },
      user_query_shorthand: "Maysam 'No Link' likely maps to 'No product link yet'",
      dashboard_render: "components/product-linkage/ProductLinkageDisplayBlock.tsx → productLinkageUserStatusLabel(linkage)",
      scanner_render:
        "lib/scanner/product-linkage-display-contract.ts → productLinkageOperatorPrimaryDisplayLabel(linkage)",
      is_resolved_rule:
        "lib/product-linkage-display-contract.ts: is_resolved = resolved_product_id && status==='resolved' (matched normalizes to resolved)",
      no_link_when:
        "unresolved status OR (!is_resolved && !status) OR scanner path: no resolved_product_id OR resolved_id without product_name",
      fields_read: [
        "resolved_product_id",
        "product_id (legacy fallback in scanner contract only)",
        "identifier_resolution_status / product_linkage_status",
        "product_name (from products join or view snapshot)",
        "product_identifier_map (via resolveScannerProductIdentifiers when row unlinked)",
      ],
    },
    files_suspected: [
      "lib/product-linkage-display-contract.ts",
      "lib/product-linkage-display-enrich.ts",
      "lib/scanner/product-linkage-display-contract.ts",
      "lib/scanner/expected-packages-read-contract.ts",
      "lib/inventory-views-product-linkage.ts",
      "lib/scanner-product-resolve.ts",
      "components/product-linkage/ProductLinkageDisplayBlock.tsx",
      "lib/supabase-server.ts",
      ".env.local (NEXT_PUBLIC_SUPABASE_URL vs ORIGINAL_SUPABASE_URL)",
    ],
  };

  const verdict = rootCauseVerdict(payload);
  payload.root_cause = verdict.root_cause;
  payload.contributing_factors = verdict.contributing_factors;
  payload.SAFE_TO_FIX_NO_LINK = verdict.SAFE_TO_FIX_NO_LINK;
  payload.minimal_fix_plan =
    verdict.root_cause === "runtime_env_mismatch"
      ? [
          "Bind runtime to original when testing original: set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to ORIGINAL_* before dev server start, OR use approved production bind helper in server bootstrap.",
          "Verify Maysam dev .env.local — current repo default points NEXT_PUBLIC at staging (eiqfaapyumhixxoeltgu) while ORIGINAL_* is separate.",
        ]
      : verdict.root_cause === "resolver_join_regression_operational_unlinked"
        ? [
            "Operational rows (expected_packages / views) lack resolved_product_id; readmodel shows No Link despite map — governed backfill is separate phase.",
            "Short-term UI fix: in buildInventoryViewProductLinkage / resolveInventoryViewProductLinkage, call resolveScannerProductIdentifiers when map exists but row.resolved_product_id null (already partially implemented in inventory-views-product-linkage.ts).",
          ]
        : verdict.root_cause === "ui_readmodel_product_name_hydration_regression"
          ? [
              "When resolved_product_id set but products fetch empty, fall back to view product_name / product_display_name before labeling No Link.",
              "Patch productLinkageOperatorPrimaryDisplayLabel: treat matched+resolved_product_id+view name as linked.",
            ]
          : [
              "Re-run audit after env bind confirmed; if spine intact, patch readmodel hydration per scripts/neda-vs-main-product-resolution-parity-census-readonly.ts smallest_fix #2.",
            ];
  payload.NEXT_PROMPT =
    verdict.SAFE_TO_FIX_NO_LINK === "yes"
      ? "PHASE-ORIGINAL-PRODUCT-LINK-NO-LINK-MINIMAL-FIX-V1 — patch readmodel/env per minimal_fix_plan; staging smoke then original approval."
      : verdict.root_cause === "data_missing"
        ? "STOP — report spine gap on original; no auto-create."
        : "PHASE-ORIGINAL-RUNTIME-ENV-BIND-VERIFY-V1 — confirm Maysam runtime hits kxsvedvpjldygtdbylsy before code fix.";

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ run_id: rid, ref: PRODUCTION_REF }, null, 2));
  fs.writeFileSync(path.join(outDir, "audit-result.json"), JSON.stringify(payload, null, 2));

  const md = `# Original product link No Link regression audit

**Run:** ${rid}  
**Ref:** ${PRODUCTION_REF}  
**Root cause:** ${payload.root_cause}  
**SAFE_TO_FIX_NO_LINK:** ${payload.SAFE_TO_FIX_NO_LINK}

## Spine counts (original)
- products: ${spine.products}
- product_identifier_map: ${spine.product_identifier_map}
- product_prices: ${spine.product_prices}

## Runtime env
${JSON.stringify(runtimeEnv, null, 2)}

## No Link label
Dashboard: \`${PRODUCT_LINKAGE_LABEL_NO_LINK}\` via ProductLinkageDisplayBlock  
Scanner: \`${PRODUCT_LINKAGE_UNMAPPED_LABEL}\` via productLinkageOperatorPrimaryDisplayLabel

## Samples
${sampleResults
  .map(
    (s) =>
      `### ${s.identifier}
- map rows: ${s.map_row_count}
- product_id: ${s.product_id_from_map ?? "—"}
- resolver (with store): ${JSON.stringify((s.resolver_simulation as Row)?.with_store)}
- EP ui shows_no_link: ${(s.ui_simulation as Row)?.from_expected_package ? ((s.ui_simulation as Row).from_expected_package as Row).shows_no_link : "n/a"}
- inv view linkage shows_no_link: ${(s.ui_simulation as Row)?.buildInventoryViewProductLinkage ? ((s.ui_simulation as Row).buildInventoryViewProductLinkage as Row).shows_no_link : "n/a"}`,
  )
  .join("\n\n")}

## Minimal fix
${(payload.minimal_fix_plan as string[]).map((x) => `- ${x}`).join("\n")}

## Next
${payload.NEXT_PROMPT}
`;
  fs.writeFileSync(path.join(outDir, "audit-summary.md"), md);

  console.log(JSON.stringify({ run_id: rid, outDir, root_cause: payload.root_cause, SAFE: payload.SAFE_TO_FIX_NO_LINK }, null, 2));
  await pgClient.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
