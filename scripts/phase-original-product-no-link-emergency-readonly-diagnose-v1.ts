/**
 * PHASE-ORIGINAL-PRODUCT-NO-LINK-EMERGENCY-READONLY-DIAGNOSE-V1
 * Emergency read-only diagnosis — original vs staging product linkage.
 *
 *   npx tsx scripts/phase-original-product-no-link-emergency-readonly-diagnose-v1.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { mapRowToProductLinkageDisplayContract } from "../lib/product-linkage-display-contract";
import {
  PRODUCT_LINKAGE_LABEL_NO_LINK,
  productLinkageUserStatusLabel,
} from "../lib/product-linkage-display-ui";
import { bindProductionSupabaseEnv, productionPostgresUrl, PRODUCTION_REF } from "../lib/production-db-bind";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase-original-product-no-link-emergency-readonly-diagnose-v1";

const SAMPLES = [
  { label: "B0000B11UX", match: "asin_or_fnsku", value: "B0000B11UX" },
  { label: "X004LKS4VD", match: "fnsku", value: "X004LKS4VD" },
  { label: "X003VSWH37", match: "fnsku", value: "X003VSWH37" },
  { label: "staging_linked_control", match: "fnsku", value: "X004LKS4VD" },
  { label: "true_unlinked_control", match: "fnsku", value: "X000NOMAP99" },
];

type Row = Record<string, unknown>;

function runId(): string {
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

function sbClient(url: string, key: string): SupabaseClient {
  return createClient(url, key, { auth: { persistSession: false } });
}

async function sampleDbCensus(c: pg.Client, ref: string, sample: { label: string; value: string }): Promise<Row> {
  const upper = sample.value.trim().toUpperCase();
  const mapQ = await c.query(
    `SELECT m.*, p.id AS spine_product_id, p.product_name, p.asin AS p_asin, p.fnsku AS p_fnsku,
            p.sku AS p_sku, p.organization_id, p.store_id AS p_store_id, p.deleted_at AS p_deleted_at
     FROM product_identifier_map m
     JOIN products p ON p.id = m.product_id
     WHERE m.organization_id = $1::uuid AND m.deleted_at IS NULL AND p.deleted_at IS NULL
       AND (
         upper(btrim(coalesce(m.asin,''))) = $2
         OR upper(btrim(coalesce(m.fnsku,''))) = $2
         OR upper(btrim(coalesce(m.seller_sku,''))) = $2
         OR upper(btrim(coalesce(m.msku,''))) = $2
       )
     ORDER BY m.last_seen_at DESC NULLS LAST
     LIMIT 5`,
    [ORG, upper],
  );

  const productId = mapQ.rows[0]?.spine_product_id ?? mapQ.rows[0]?.product_id ?? null;
  let prices: Row[] = [];
  if (productId) {
    const pr = await c.query(
      `SELECT count(*)::int AS n, max(observed_at) AS latest
       FROM product_prices
       WHERE organization_id = $1::uuid AND product_id = $2::uuid`,
      [ORG, productId],
    );
    const prStore = await c.query(
      `SELECT count(*)::int AS n
       FROM product_prices
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND product_id = $3::uuid`,
      [ORG, STORE, productId],
    );
    prices = [{ ref, org_scoped: pr.rows[0], store_scoped: prStore.rows[0] }];
  }

  return {
    ref,
    identifier: sample.value,
    label: sample.label,
    map_row_count: mapQ.rowCount,
    map_rows: mapQ.rows.map((r: Row) => ({
      id: r.id,
      product_id: r.product_id,
      store_id: r.store_id,
      asin: r.asin,
      fnsku: r.fnsku,
      seller_sku: r.seller_sku,
      deleted_at: r.deleted_at,
      product_name: r.product_name,
      p_store_id: r.p_store_id,
      p_deleted_at: r.p_deleted_at,
    })),
    product_id: productId,
    price_summary: prices,
    store_id_on_product: mapQ.rows[0]?.p_store_id ?? null,
    store_id_matches_ui_store: mapQ.rows[0]?.p_store_id === STORE,
  };
}

async function simulateProductDetailApi(
  sb: SupabaseClient,
  productId: string,
  organizationId: string,
  storeId: string,
): Promise<Row> {
  const { data: product, error: pErr } = await sb
    .from("products")
    .select("id, organization_id, store_id, product_name, asin, fnsku, sku, deleted_at")
    .eq("id", productId)
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .is("deleted_at", null)
    .maybeSingle();

  const { data: maps, error: mErr } = await sb
    .from("product_identifier_map")
    .select("id, product_id, store_id, asin, fnsku, seller_sku")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("product_id", productId);

  const { data: prices, error: prErr } = await sb
    .from("product_prices")
    .select("id, product_id, amount, observed_at")
    .eq("organization_id", organizationId)
    .eq("store_id", storeId)
    .eq("product_id", productId)
    .limit(3);

  const linkageFromProductRow = product
    ? mapRowToProductLinkageDisplayContract({
        source_table: "products.detail",
        source_row_id: productId,
        row: {
          product_id: productId,
          resolved_product_id: productId,
          identifier_resolution_status: "resolved",
          asin: product.asin,
          fnsku: product.fnsku,
          sku: product.sku,
        },
        product: { id: productId, product_name: product.product_name },
      })
    : null;

  return {
    route: "GET /api/dashboard/products/[id]",
    query: { organization_id: organizationId, store_id: storeId, product_id: productId },
    product_found: !!product && !pErr,
    product_error: pErr?.message ?? null,
    map_rows_count: maps?.length ?? 0,
    map_error: mErr?.message ?? null,
    prices_count: prices?.length ?? 0,
    prices_error: prErr?.message ?? null,
    ui_would_show_empty_linked_identifiers: (maps?.length ?? 0) === 0,
    derived_linkage_contract: linkageFromProductRow
      ? {
          is_resolved: linkageFromProductRow.is_resolved,
          user_status_label: productLinkageUserStatusLabel(linkageFromProductRow),
          shows_no_link:
            productLinkageUserStatusLabel(linkageFromProductRow) === PRODUCT_LINKAGE_LABEL_NO_LINK,
        }
      : null,
  };
}

async function simulateLookupLinkage(
  sb: SupabaseClient,
  identifiers: { fnsku?: string; asin?: string },
): Promise<Row> {
  const resolved = await resolveScannerProductIdentifiers(sb, {
    organizationId: ORG,
    storeId: STORE,
    fnsku: identifiers.fnsku ?? null,
    asin: identifiers.asin ?? null,
  });
  const contract = mapRowToProductLinkageDisplayContract({
    source_table: "product_input_lookup_v193",
    source_row_id: identifiers.fnsku ?? identifiers.asin ?? "lookup",
    row: {
      fnsku: identifiers.fnsku,
      asin: identifiers.asin,
      resolved_product_id: resolved.resolved_product_id,
      identifier_resolution_status: resolved.identifier_resolution_status,
      identifier_resolution_confidence: resolved.identifier_resolution_confidence,
    },
  });
  if (resolved.resolved_product_id) {
    const { data: prod } = await sb
      .from("products")
      .select("id, product_name, name")
      .eq("id", resolved.resolved_product_id)
      .eq("organization_id", ORG)
      .maybeSingle();
    if (prod) {
      const enriched = mapRowToProductLinkageDisplayContract({
        source_table: "product_input_lookup_v193",
        source_row_id: identifiers.fnsku ?? identifiers.asin ?? "lookup",
        row: {
          fnsku: identifiers.fnsku,
          asin: identifiers.asin,
          resolved_product_id: resolved.resolved_product_id,
          identifier_resolution_status: "resolved",
        },
        product: {
          id: resolved.resolved_product_id,
          product_name: (prod as Row).product_name ?? (prod as Row).name,
        },
      });
      return {
        resolver: resolved,
        linkage: {
          is_resolved: enriched.is_resolved,
          user_status_label: productLinkageUserStatusLabel(enriched),
          shows_no_link: productLinkageUserStatusLabel(enriched) === PRODUCT_LINKAGE_LABEL_NO_LINK,
        },
      };
    }
  }
  return {
    resolver: resolved,
    linkage: {
      is_resolved: contract.is_resolved,
      user_status_label: productLinkageUserStatusLabel(contract),
      shows_no_link: productLinkageUserStatusLabel(contract) === PRODUCT_LINKAGE_LABEL_NO_LINK,
    },
  };
}

async function rlsSummary(c: pg.Client): Promise<Row> {
  const tables = ["product_identifier_map", "product_prices", "products"];
  const out: Row = {};
  for (const t of tables) {
    const r = await c.query(
      `SELECT polname, polcmd, polroles::regrole[] AS roles,
              pg_get_expr(polqual, polrelid) AS qual
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

async function testAnonRead(url: string, anonKey: string, productId: string): Promise<Row> {
  const anon = sbClient(url, anonKey);
  const map = await anon
    .from("product_identifier_map")
    .select("id")
    .eq("organization_id", ORG)
    .eq("store_id", STORE)
    .eq("product_id", productId)
    .limit(1);
  const prices = await anon
    .from("product_prices")
    .select("id")
    .eq("organization_id", ORG)
    .eq("store_id", STORE)
    .eq("product_id", productId)
    .limit(1);
  const products = await anon
    .from("products")
    .select("id")
    .eq("organization_id", ORG)
    .eq("id", productId)
    .limit(1);
  return {
    product_identifier_map: { error: map.error?.message ?? null, rows: map.data?.length ?? 0 },
    product_prices: { error: prices.error?.message ?? null, rows: prices.data?.length ?? 0 },
    products: { error: products.error?.message ?? null, rows: products.data?.length ?? 0 },
  };
}

function runtimeEnvSnapshot(): Row {
  const pubUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const pubKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  return {
    NEXT_PUBLIC_SUPABASE_URL_ref: refFromSupabaseUrl(pubUrl),
    ORIGINAL_SUPABASE_URL_ref: refFromSupabaseUrl(process.env.ORIGINAL_SUPABASE_URL?.trim() ?? ""),
    NEXT_PUBLIC_STORE_ID: process.env.NEXT_PUBLIC_STORE_ID?.trim() ?? null,
    runtime_points_at_original: refFromSupabaseUrl(pubUrl) === PRODUCTION_REF,
    runtime_points_at_staging: refFromSupabaseUrl(pubUrl) === STAGING_REF,
    deployed_local_head: safeGit("git rev-parse --short HEAD"),
    deployed_local_branch: safeGit("git branch --show-current"),
    mismatch_if_testing_original_ui:
      refFromSupabaseUrl(pubUrl) === STAGING_REF
        ? "CRITICAL: NEXT_PUBLIC_SUPABASE_URL is staging — original UI tests hit wrong DB unless env swapped at deploy/runtime"
        : null,
  };
}

function safeGit(cmd: string): string | null {
  try {
    return execSync(cmd, { cwd: process.cwd(), encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function recentLinkageFiles(): string[] {
  try {
    const out = execSync(
      `git log -20 --name-only --pretty=format: -- lib/product-linkage-display-contract.ts lib/product-linkage-display-enrich.ts lib/product-linkage-display-ui.ts lib/inventory-views-product-linkage.ts app/api/dashboard/products/ app/dashboard/products/pim/ProductDetailDrawer.tsx components/product-linkage/ app/returns/product-input-lookup-actions.ts app/returns/product-linkage-display-actions.ts components/returns/ReturnItemProductLinkage.tsx lib/supabase-server.ts`,
      { cwd: process.cwd(), encoding: "utf8" },
    );
    return [...new Set(out.split("\n").map((s) => s.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function rootCauseVerdict(payload: Row): Row {
  const env = payload.runtime_env as Row;
  const orig = payload.original_sample_db_results as Row[];
  const origApi = payload.product_page_endpoint_payload as Row;
  const intact =
    orig.filter((s) => s.label !== "true_unlinked_control").every((s) => Number(s.map_row_count) > 0);

  const causes: string[] = [];
  if (env.mismatch_if_testing_original_ui) causes.push("runtime_env_points_at_staging_not_original");
  if (!intact) causes.push("original_spine_data_missing");

  const wrongStore = orig.some((s) => s.product_id && s.store_id_matches_ui_store === false);
  if (wrongStore) causes.push("product_store_id_mismatch_with_ui_store_param");

  const origBound = origApi.original_bound as Row;
  if (origBound?.ui_would_show_empty_linked_identifiers && Number(origBound.map_rows_count) === 0) {
    const pf = origBound.product_found;
    if (pf) causes.push("api_empty_map_rows_despite_product_found");
    else causes.push("api_product_404_wrong_store_scope");
  }

  const stagingBound = origApi.staging_bound as Row;
  const origLookup = (payload.lookup_linkage_simulation as Row)?.original_bound as Row;
  if (origLookup?.linkage?.shows_no_link && intact) {
    causes.push("readmodel_shows_no_link_despite_spine");
  }

  let exact = "unknown";
  if (causes.includes("runtime_env_points_at_staging_not_original")) {
    exact = "runtime_env_mismatch_original_ui_hits_staging_or_wrong_ref";
  } else if (causes.includes("api_product_404_wrong_store_scope")) {
    exact = "wrong_org_store_scope_on_product_detail_api";
  } else if (causes.includes("readmodel_shows_no_link_despite_spine")) {
    exact = "ui_readmodel_regression_pre_fix_or_undeployed_fix";
  } else if (!intact) {
    exact = "data_missing_on_original";
  } else if (stagingBound?.map_rows_count > 0 && origBound?.map_rows_count === 0 && origBound?.product_found) {
    exact = "store_scoped_map_query_empty_on_original";
  }

  const rlsBlocks =
    (payload.rls_policy_summary as Row)?.product_identifier_map?.policies?.some(
      (p: Row) => String(p.roles).includes("anon") && String(p.qual) === "false",
    ) ?? false;

  return {
    exact_root_cause: exact,
    contributing_factors: causes,
    whether_data_is_intact: intact ? "yes" : "no",
    whether_RLS_blocks_linkage: rlsBlocks
      ? "service_role_no; anon_yes_by_design_for_map"
      : "no_for_service_role_paths",
    whether_UI_payload_mismatch:
      causes.some((c) => c.startsWith("api_") || c.includes("readmodel")) ? "yes" : "no",
    whether_cache_or_deploy_mismatch: env.mismatch_if_testing_original_ui ? "yes" : "conditional_verify_deploy",
    SAFE_TO_FIX_WITH_CODE_ONLY:
      exact === "runtime_env_mismatch_original_ui_hits_staging_or_wrong_ref" ||
      exact === "ui_readmodel_regression_pre_fix_or_undeployed_fix"
        ? "yes"
        : exact === "wrong_org_store_scope_on_product_detail_api"
          ? "yes"
          : "no",
  };
}

async function main() {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const runtime_env = runtimeEnvSnapshot();
  const recent_files = recentLinkageFiles();

  // Original DB
  const origPg = await connectPg(productionPostgresUrl(), PRODUCTION_REF);
  const original_sample_db_results: Row[] = [];
  for (const s of SAMPLES) {
    original_sample_db_results.push(await sampleDbCensus(origPg, PRODUCTION_REF, s));
  }
  const rls_policy_summary = await rlsSummary(origPg);
  await origPg.end();

  // Staging DB
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stPg = await connectPg(stagingUrl, STAGING_REF);
  const staging_sample_db_results: Row[] = [];
  for (const s of SAMPLES) {
    staging_sample_db_results.push(await sampleDbCensus(stPg, STAGING_REF, s));
  }
  await stPg.end();

  // API simulation — use X004LKS4VD product as primary product page probe
  const linkedProductId =
    (original_sample_db_results.find((s) => s.label === "X004LKS4VD")?.product_id as string) ??
    "7e5e05f7-c98a-41a7-85e8-62720ffdc8de";

  bindProductionSupabaseEnv();
  const origSb = sbClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const original_bound = await simulateProductDetailApi(origSb, linkedProductId, ORG, STORE);
  const original_wrong_store = await simulateProductDetailApi(
    origSb,
    linkedProductId,
    ORG,
    "00000000-0000-0000-0000-000000000099",
  );

  const stagingSb = sbClient(
    process.env.STAGING_SUPABASE_URL!,
    process.env.STAGING_SERVICE_ROLE_KEY!,
  );
  const stagingProductId =
    (staging_sample_db_results.find((s) => s.label === "X004LKS4VD")?.product_id as string) ??
    linkedProductId;
  const staging_bound = await simulateProductDetailApi(stagingSb, stagingProductId, ORG, STORE);

  const product_page_endpoint_payload = {
    endpoint: "GET /api/dashboard/products/[id]?organization_id=&store_id=",
    fields_ui_uses: [
      "product (404 if org+store mismatch)",
      "product_identifier_map[] — ProductDetailDrawer Linked identifiers section",
      "product_prices[]",
      "ProductLinkageDisplayBlock uses is_resolved / productLinkageUserStatusLabel — not on drawer directly",
    ],
    original_bound,
    original_wrong_store_simulation: original_wrong_store,
    staging_bound,
  };

  const lookup_linkage_simulation = {
    original_bound: await simulateLookupLinkage(origSb, { fnsku: "X004LKS4VD" }),
    staging_bound: await simulateLookupLinkage(stagingSb, { fnsku: "X004LKS4VD" }),
    unlinked_control_original: await simulateLookupLinkage(origSb, { fnsku: "X000NOMAP99" }),
  };

  const anon_original =
    process.env.ORIGINAL_ANON_KEY && process.env.ORIGINAL_SUPABASE_URL
      ? await testAnonRead(process.env.ORIGINAL_SUPABASE_URL, process.env.ORIGINAL_ANON_KEY, linkedProductId)
      : { skipped: true };

  const no_link_ui_condition = {
    exact_label: PRODUCT_LINKAGE_LABEL_NO_LINK,
    maysam_shorthand: "No Link ≈ No product link yet",
    primary_render_path: "components/product-linkage/ProductLinkageDisplayBlock.tsx → productLinkageUserStatusLabel(linkage)",
    condition_code: [
      "productLinkageUserStatusLabel: if linkage.is_resolved → Linked",
      "else if unresolved status or !status → PRODUCT_LINKAGE_LABEL_NO_LINK",
      "mapRowToProductLinkageDisplayContract.is_resolved requires effective resolved id + non-blocking status",
    ],
    product_detail_drawer_separate_copy:
      "ProductDetailDrawer shows 'No identifier map rows yet' when product_identifier_map.length===0 (not same string)",
    return_item_path:
      "ReturnItemProductLinkage → fetchProductLinkageDisplayContract → ProductLinkageDisplayBlock",
  };

  const payload: Row = {
    phase: "PHASE-ORIGINAL-PRODUCT-NO-LINK-EMERGENCY-READONLY-DIAGNOSE-V1",
    run_id: rid,
    original_sample_db_results,
    staging_sample_db_results,
    product_page_endpoint_payload,
    lookup_linkage_simulation,
    no_link_ui_condition,
    rls_policy_summary,
    anon_authenticated_read_test_original: anon_original,
    runtime_env,
    suspected_files: recent_files,
    NO_DATA_MUTATION_VERIFICATION: true,
  };

  const verdict = rootCauseVerdict(payload);
  Object.assign(payload, verdict);
  payload.minimal_fix_recommendation =
    verdict.exact_root_cause === "runtime_env_mismatch_original_ui_hits_staging_or_wrong_ref"
      ? [
          "Set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to ORIGINAL_* for original deploy/runtime",
          "Restart dev/prod server; verify network requests hit kxsvedvpjldygtdbylsy",
          "Deploy readmodel fix (effectiveResolvedProductId) if not on original bundle yet",
        ]
      : verdict.exact_root_cause === "wrong_org_store_scope_on_product_detail_api"
        ? [
            "Ensure ProductDetailDrawer passes product.store_id not stale NEXT_PUBLIC_STORE_ID when they differ",
            "Verify org_id/store_id on /api/dashboard/products/[id] match product row",
          ]
        : verdict.exact_root_cause === "ui_readmodel_regression_pre_fix_or_undeployed_fix"
          ? [
              "Deploy lib/product-linkage-display-contract.ts spine-aware is_resolved fix to original runtime",
              "Verify productLinkageUserStatusLabel shows Linked for samples after deploy",
            ]
          : ["Stop — data spine gap; no auto-create"];
  payload.NEXT_PROMPT =
    verdict.SAFE_TO_FIX_WITH_CODE_ONLY === "yes"
      ? "PHASE-ORIGINAL-RUNTIME-ENV-BIND-AND-LINKAGE-FIX-DEPLOY-VERIFY-V1"
      : "PHASE-PRODUCT-IDENTIFIER-MAP-GOVERNED-SEED-V1 — spine gap";

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ run_id: rid }, null, 2));
  fs.writeFileSync(path.join(outDir, "diagnose-result.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(
    path.join(outDir, "diagnose-summary.md"),
    `# Emergency No Link diagnosis

**Run:** ${rid}
**Root cause:** ${verdict.exact_root_cause}
**Data intact:** ${verdict.whether_data_is_intact}
**RLS blocks linkage:** ${verdict.whether_RLS_blocks_linkage}
**UI payload mismatch:** ${verdict.whether_UI_payload_mismatch}
**Cache/deploy mismatch:** ${verdict.whether_cache_or_deploy_mismatch}
**SAFE_TO_FIX_WITH_CODE_ONLY:** ${verdict.SAFE_TO_FIX_WITH_CODE_ONLY}

## Original samples
${original_sample_db_results
  .map(
    (s) =>
      `- **${s.label}** (${s.identifier}): map=${s.map_row_count} product_id=${s.product_id ?? "—"} store_match=${s.store_id_matches_ui_store}`,
  )
  .join("\n")}

## Product detail API (X004LKS4VD)
- Original: product_found=${original_bound.product_found} map_rows=${original_bound.map_rows_count}
- Staging: product_found=${staging_bound.product_found} map_rows=${staging_bound.map_rows_count}
- Wrong store sim: product_found=${original_wrong_store.product_found}

## Runtime env
${JSON.stringify(runtime_env, null, 2)}
`,
  );

  console.log(JSON.stringify({ run_id: rid, outDir, ...verdict }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
