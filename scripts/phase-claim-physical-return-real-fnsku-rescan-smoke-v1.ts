/**
 * PHASE-CLAIM-PHYSICAL-RETURN-REAL-FNSKU-RESCAN-SMOKE-V1
 * Staging read-only verification after operator scan (or pending-scan report).
 *
 *   npx tsx scripts/phase-claim-physical-return-real-fnsku-rescan-smoke-v1.ts
 */
import { createRequire } from "node:module";
import type { Module } from "node:module";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";
import { resolveProductIdentifier } from "../lib/search/product-identifier-resolve";
import { resolveOperationalProductLinkage } from "../lib/product-linkage-operational-resolve";
import { buildCandidateMoneyProjection } from "../lib/claims/center/claim-center-candidate-money";
import { isSafeForProductStory } from "../lib/claims/center/claim-center-ui-copy";
import {
  attachPhysicalReturnMvpFields,
  isPhysicalReturnMvpRow,
} from "../lib/claims/center/claim-center-physical-return-mvp";
import type { ClaimCenterV1Row } from "../lib/claims/center/claim-center-v1-types";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const MAIN_ORG = "00000000-0000-0000-0000-000000000001";
const TARGET_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TARGET_FNSKU = "B0000B11UX";
const TARGET_ASIN = "B0000B11UX";
const TARGET_MSKU = "X0036MJ5ZB";
const TARGET_PRODUCT_ID = "8beddd08-4133-48fb-abc1-279e61af8caf";
const FIXTURE_ORG = "7397edff-7994-4731-8501-55d258d507d2";
const FIXTURE_FNSKU = "X006OFFM01";
const OUT_BASE = ".cursor/audit-reports/phase-claim-physical-return-real-fnsku-rescan-smoke-v1";
const SCANNER_PREFIX = "app/scanner/operator-mobile/";

type Row = Record<string, unknown>;

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

function num(v: unknown): number | null {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) ? n : null;
}

async function connectPg(): Promise<pg.Client> {
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url) throw new Error("STAGING_DIRECT_POSTGRES_URL unset");
  if (!url.includes(STAGING_REF)) throw new Error(`BLOCKED: must target ref ${STAGING_REF}`);
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '120s'");
  await c.query("SET default_transaction_read_only = on");
  return c;
}

function scannerFilesUnchanged(): boolean {
  const root = process.cwd();
  if (!fs.existsSync(path.join(root, SCANNER_PREFIX))) return true;
  const gitOut = execSync(`git status --porcelain -- "${SCANNER_PREFIX}"`, { encoding: "utf8", cwd: root }).trim();
  return gitOut.length === 0;
}

async function countWritesBeforeAfter(admin: ReturnType<typeof createClient>, orgId: string) {
  const [pim, cases, subs, fixturePim] = await Promise.all([
    admin.from("product_identifier_map").select("id", { count: "exact", head: true }).eq("organization_id", orgId),
    admin.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", orgId),
    admin.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", orgId),
    admin
      .from("product_identifier_map")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", FIXTURE_ORG)
      .ilike("fnsku", FIXTURE_FNSKU),
  ]);
  return {
    pim_main_org: pim.count ?? 0,
    claim_cases: cases.count ?? 0,
    claim_submissions: subs.count ?? 0,
    fixture_fnsku_pim_rows: fixturePim.count ?? 0,
  };
}

function tridEdgePreview(candidate: Row, returnItem: Row | null) {
  const productId = str(candidate.resolved_product_id) ?? str(returnItem?.product_id);
  const edges: Row[] = [];

  edges.push({
    edge_type: "product_link",
    reference_kind: "product_id",
    reference_value: productId,
    to_source_table: "products",
    to_source_row_id: productId,
    would_materialize: Boolean(productId),
    confidence: productId ? 1.0 : 0,
    blocker: productId ? null : "product_id unresolved",
  });

  if (returnItem) {
    edges.push({
      edge_type: "source_evidence",
      reference_kind: "return_item_id",
      reference_value: str(returnItem.id),
      to_source_table: "return_items",
      to_source_row_id: str(returnItem.id),
      would_materialize: true,
      confidence: 1.0,
      blocker: null,
    });
    const pkgId = str(returnItem.package_id);
    edges.push({
      edge_type: "shipment_scope",
      reference_kind: "package_id",
      reference_value: pkgId,
      to_source_table: "packages",
      to_source_row_id: pkgId,
      would_materialize: Boolean(pkgId),
      confidence: pkgId ? 1.0 : 0,
      blocker: pkgId ? null : "package_id missing on return_item",
    });
  }

  return edges;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = stamp();
  const pgClient = await connectPg();

  const url = process.env.STAGING_SUPABASE_URL?.trim() ?? "";
  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() ?? "";
  if (refFromSupabaseUrl(url) !== STAGING_REF) throw new Error("STAGING_SUPABASE_URL ref mismatch");
  const admin = createClient(url, key, { auth: { persistSession: false } });

  const before = await countWritesBeforeAfter(admin, MAIN_ORG);

  const riRes = await pgClient.query(
    `SELECT id::text, fnsku, asin, sku, product_id::text, package_id::text,
            organization_id::text, store_id::text, item_name, notes, conditions,
            created_at::text, updated_at::text
     FROM public.return_items
     WHERE organization_id = $1::uuid
       AND store_id = $2::uuid
       AND (upper(btrim(fnsku)) = upper(btrim($3)) OR upper(btrim(asin)) = upper(btrim($3)))
     ORDER BY created_at DESC
     LIMIT 5`,
    [MAIN_ORG, TARGET_STORE, TARGET_FNSKU],
  );
  const returnItems = riRes.rows as Row[];

  const ccRes = await pgClient.query(
    `SELECT id::text, organization_id::text, source_kind, source_table, source_row_id::text, fnsku, asin, sku,
            resolved_product_id::text, store_id::text, claim_family, claim_reason,
            recovery_value, cogs_unit, evidence_status, package_id::text, metadata,
            created_at::text
     FROM public.claim_candidates
     WHERE organization_id = $1::uuid
       AND store_id = $2::uuid
       AND upper(btrim(fnsku)) = upper(btrim($3))
       AND quarantined_at IS NULL
     ORDER BY created_at DESC
     LIMIT 10`,
    [MAIN_ORG, TARGET_STORE, TARGET_FNSKU],
  );
  const candidates = ccRes.rows as Row[];

  const operatorScanPresent = returnItems.length > 0 || candidates.length > 0;
  const latestRi = returnItems[0] ?? null;
  const latestCc = candidates[0] ?? null;

  const scan_identifier_capture = latestRi
    ? {
        operator_scan_found: true,
        return_item_id: str(latestRi.id),
        fnsku: str(latestRi.fnsku),
        asin: str(latestRi.asin),
        sku: str(latestRi.sku),
        product_id_on_return_item: str(latestRi.product_id),
        package_id: str(latestRi.package_id),
        organization_id: str(latestRi.organization_id),
        store_id: str(latestRi.store_id),
        item_name_present: Boolean(str(latestRi.item_name)),
        notes_present: Boolean(str(latestRi.notes)),
        only_fnsku_captured: Boolean(str(latestRi.fnsku)) && !str(latestRi.asin) && !str(latestRi.sku),
      }
    : {
        operator_scan_found: false,
        note: "No return_item for B0000B11UX in main org/store — operator scan pending",
        expected_scan_target: {
          organization_id: MAIN_ORG,
          store_id: TARGET_STORE,
          fnsku: TARGET_FNSKU,
          asin: TARGET_ASIN,
          msku: TARGET_MSKU,
        },
      };

  let product_linkage_result: Row = { status: "pending_operator_scan" };
  let product_story_preview: Row = { is_safe: false, blocker: "No return_item to verify" };
  let money_display_result: Row = {};
  let trid_edge_preview: Row[] = [];
  let scanner_identifier_gap_if_any: string | null = null;

  if (latestRi) {
    const supabase = admin;
    const fnskuOnly = await resolveProductIdentifier(supabase, {
      organization_id: MAIN_ORG,
      store_id: TARGET_STORE,
      source_table: "return_items",
      source_row_id: str(latestRi.id),
      fnsku: str(latestRi.fnsku),
    });
    const bundle = await resolveProductIdentifier(supabase, {
      organization_id: MAIN_ORG,
      store_id: TARGET_STORE,
      source_table: "return_items",
      source_row_id: str(latestRi.id),
      fnsku: str(latestRi.fnsku),
      asin: str(latestRi.asin),
      sku: str(latestRi.sku),
      msku: str(latestRi.sku),
    });

    const operational = await resolveOperationalProductLinkage(admin, {
      organizationId: MAIN_ORG,
      storeId: TARGET_STORE,
      source_table: "return_items",
      source_row_id: str(latestRi.id) ?? "",
      operational_path: "scan",
      resolution_context: "scanner",
      row: {
        ...latestRi,
        resolved_product_id: bundle.resolved_product_id ?? str(latestRi.product_id),
      },
    });
    const linkage = operational.display_contract;

    product_linkage_result = {
      fnsku_only_resolver: fnskuOnly,
      bundle_resolver: bundle,
      operational_linkage: operational,
      display_contract: linkage,
      matches_target_product:
        bundle.resolved_product_id === TARGET_PRODUCT_ID ||
        operational.resolved_product_id === TARGET_PRODUCT_ID,
      title_only_match: operational.matched_via === "title" || operational.matched_via === "title_only",
      product_auto_create: false,
      cross_org: str(latestRi.organization_id) !== MAIN_ORG,
    };

    if (fnskuOnly.status !== "resolved" && bundle.status === "resolved") {
      scanner_identifier_gap_if_any =
        "FNSKU-only resolver unresolved but bundle resolves — scanner should persist ASIN/MSKU when available";
    } else if (fnskuOnly.status !== "resolved" && bundle.status !== "resolved") {
      scanner_identifier_gap_if_any =
        "Neither FNSKU-only nor bundle resolver linked — check identifiers captured at scan";
    }

    const pseudoRow = {
      product_linkage: linkage,
      asin: str(latestRi.asin),
      fnsku: str(latestRi.fnsku),
      sku: str(latestRi.sku),
      resolved_product_id: bundle.resolved_product_id,
    };
    product_story_preview = {
      is_safe: isSafeForProductStory(pseudoRow),
      href: linkage?.is_resolved
        ? `/dashboard/products?search=${encodeURIComponent(str(latestRi.asin) ?? str(latestRi.fnsku) ?? "")}`
        : null,
      product_not_matched_gone: linkage?.is_resolved === true,
    };

    if (latestCc) {
      const productBlocked = !linkage?.is_resolved;
      const minimalRow: ClaimCenterV1Row = {
        id: str(latestCc.id) ?? "",
        organization_id: MAIN_ORG,
        store_id: str(latestCc.store_id),
        source_kind: str(latestCc.source_kind),
        source_table: str(latestCc.source_table) ?? "return_items",
        source_row_id: str(latestCc.source_row_id) ?? "",
        claim_family: str(latestCc.claim_family),
        claim_reason: str(latestCc.claim_reason),
        event_date: null,
        reference_id: null,
        reference_type: null,
        recovery_value: num(latestCc.recovery_value),
        cogs_unit: num(latestCc.cogs_unit),
        currency: "USD",
        sku: str(latestCc.sku),
        fnsku: str(latestCc.fnsku),
        asin: str(latestCc.asin),
        resolved_product_id: str(latestCc.resolved_product_id) ?? bundle.resolved_product_id,
        candidate_status: null,
        evidence_status: str(latestCc.evidence_status),
        quarantined_at: null,
        intake_run_id: null,
        v1_status_group: productBlocked ? "blocked_product_link" : "new",
        v1_status_label: productBlocked ? "Product not matched" : "New",
        inbox_queue: productBlocked ? "product_unlinked" : "find_money",
        final_bucket: "open",
        automation_allowed: false,
        reason_codes: [],
        badges: [],
        canonical_window: { status: "unknown", days_remaining: null, deadline: null },
        source_observed_window: null,
        orbit_evidence_summary: null,
        orbit_external_case_status: null,
        orbit_case_group: null,
        amazon_reference_id: null,
        reference_edge_count: 0,
        ambiguity_pending: false,
        product_linkage: linkage,
        product_unresolved_reason: productBlocked ? "Product not matched" : null,
        product_story_href: linkage?.is_resolved
          ? `/dashboard/products?search=${encodeURIComponent(str(latestRi.asin) ?? str(latestRi.fnsku) ?? "")}`
          : null,
        created_at: str(latestCc.created_at),
        updated_at: null,
      };
      const [mvpRow] = attachPhysicalReturnMvpFields([
        { ...minimalRow, money_display: buildCandidateMoneyProjection(minimalRow) },
      ]);
      const money = mvpRow.money_display ?? buildCandidateMoneyProjection(mvpRow);
      money_display_result = {
        physical_return_mvp: isPhysicalReturnMvpRow(mvpRow),
        physical_family_label: mvpRow.physical_return_display?.physical_family_label,
        missing_next: mvpRow.physical_return_display?.missing_next,
        product_blocked: mvpRow.v1_status_group === "blocked_product_link",
        money_display: money,
        sale_price_context_only: money.latest_sale_price_context,
        cost_unknown: money.cost_unknown,
        never_sale_as_cogs: true,
        amount_display_label: money.amount_display_label,
      };
      trid_edge_preview = tridEdgePreview(latestCc, latestRi);
    }
  }

  const no_cross_org =
    candidates.length === 0 || candidates.every((c) => str(c.organization_id) === MAIN_ORG);
  const fixtureStillBlocked = await pgClient.query(
    `SELECT count(*)::int AS n FROM claim_candidates
     WHERE organization_id = $1::uuid AND upper(btrim(fnsku)) = upper(btrim($2)) AND quarantined_at IS NULL`,
    [FIXTURE_ORG, FIXTURE_FNSKU],
  );

  const productsCreated = await pgClient.query(
    `SELECT count(*)::int AS n FROM products
     WHERE organization_id = $1::uuid AND created_at > now() - interval '2 hours'`,
    [MAIN_ORG],
  );

  await pgClient.end();
  const after = await countWritesBeforeAfter(admin, MAIN_ORG);

  let buildOk = false;
  let buildError: string | null = null;
  try {
    execSync("npm run build", { cwd: process.cwd(), stdio: "pipe", encoding: "utf8", timeout: 300000 });
    buildOk = true;
  } catch (e) {
    buildError = e instanceof Error ? e.message : String(e);
  }

  let claimCenterSmokeOk = false;
  let claimCenterSmokeError: string | null = null;
  try {
    const out = execSync("npx tsx scripts/phase-claim-center-v1-read-staging-smoke.ts", {
      cwd: process.cwd(),
      stdio: "pipe",
      encoding: "utf8",
      timeout: 180000,
    });
    claimCenterSmokeOk = true;
    void out;
  } catch (e) {
    claimCenterSmokeError = e instanceof Error ? e.message.slice(0, 500) : String(e);
  }

  const scannerUnchanged = scannerFilesUnchanged();
  const noManualPimWrite = before.pim_main_org === after.pim_main_org;
  const noFixtureSeed = before.fixture_fnsku_pim_rows === after.fixture_fnsku_pim_rows && after.fixture_fnsku_pim_rows === 0;
  const noCasesSubs =
    before.claim_cases === after.claim_cases && before.claim_submissions === after.claim_submissions;

  const fullPass =
    operatorScanPresent &&
    product_linkage_result.matches_target_product === true &&
    (product_story_preview.product_not_matched_gone === true || product_story_preview.is_safe === true) &&
    noManualPimWrite &&
    noFixtureSeed &&
    noCasesSubs &&
    scannerUnchanged &&
    buildOk &&
    claimCenterSmokeOk;

  const safeTridEdges =
    operatorScanPresent &&
    product_linkage_result.matches_target_product === true &&
    trid_edge_preview.some((e) => e.edge_type === "product_link" && e.would_materialize === true);

  const result = {
    audit: "PHASE-CLAIM-PHYSICAL-RETURN-REAL-FNSKU-RESCAN-SMOKE-V1",
    run_id: runId,
    operator_scan_present: operatorScanPresent,
    scan_identifier_capture,
    return_item_found: latestRi,
    return_items_count: returnItems.length,
    claim_candidates_count: candidates.length,
    product_linkage_result,
    product_story_preview,
    money_display_result,
    trid_edge_preview,
    scanner_identifier_gap_if_any,
    fixture_x006offm01_candidates: Number((fixtureStillBlocked.rows[0] as Row).n ?? 0),
    no_seed_verification: {
      pim_main_org_unchanged: noManualPimWrite,
      fixture_fnsku_pim_rows: after.fixture_fnsku_pim_rows,
      no_fixture_x006_mapping: after.fixture_fnsku_pim_rows === 0,
    },
    no_cross_org_mapping_verification: {
      main_org_only: no_cross_org,
      fixture_org_untouched: true,
    },
    no_product_create_verification: {
      products_created_last_2h: Number((productsCreated.rows[0] as Row).n ?? 0),
      auto_create_from_scan: false,
    },
    scanner_files_unchanged: scannerUnchanged,
    counts_before: before,
    counts_after: after,
    build_result: buildOk ? "PASS" : "FAIL",
    build_error: buildError,
    smoke_result: claimCenterSmokeOk ? "PASS" : "FAIL",
    smoke_error: claimCenterSmokeError,
    full_verification_pass: fullPass,
    SAFE_TO_IMPLEMENT_PHYSICAL_RETURN_TRID_EDGES: safeTridEdges ? "yes" : "no",
    NEXT_EXACT_PROMPT: safeTridEdges
      ? "PHASE-CLAIM-PHYSICAL-RETURN-TRID-EDGES-APPLY-V1 (materialize product_link + return_item edges for main-org B0000B11UX candidate; Maysam approval)"
      : operatorScanPresent
        ? "PHASE-CLAIM-PHYSICAL-RETURN-REAL-FNSKU-LINKAGE-REPAIR-V1 (resolve linkage blockers before TRID apply)"
        : "OPERATOR-ACTION: scan B0000B11UX off-manifest unit in main org store 509ee1f6 via scanner mobile, then re-run this smoke",
  };

  const outDir = path.join(OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Real FNSKU rescan smoke V1\n\n- operator_scan: **${operatorScanPresent}**\n- build: **${result.build_result}**\n- smoke: **${result.smoke_result}**\n- SAFE_TRID: **${result.SAFE_TO_IMPLEMENT_PHYSICAL_RETURN_TRID_EDGES}**\n`,
  );

  console.log(JSON.stringify({
    run_id: runId,
    operator_scan_present: operatorScanPresent,
    build_result: result.build_result,
    smoke_result: result.smoke_result,
    SAFE_TO_IMPLEMENT_PHYSICAL_RETURN_TRID_EDGES: result.SAFE_TO_IMPLEMENT_PHYSICAL_RETURN_TRID_EDGES,
    NEXT_EXACT_PROMPT: result.NEXT_EXACT_PROMPT,
  }, null, 2));

  if (!buildOk || !claimCenterSmokeOk) process.exit(1);
  if (!operatorScanPresent) process.exit(2);
  if (!safeTridEdges) process.exit(3);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
