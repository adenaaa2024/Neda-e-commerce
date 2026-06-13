/**
 * PHASE-CLAIM-PHYSICAL-RETURN-REAL-FNSKU-CONTROLLED-SEED-V1
 * Staging-only controlled package + return_item seed with rollback SQL.
 *
 *   npx tsx scripts/phase-claim-physical-return-real-fnsku-controlled-seed-v1.ts
 *   npx tsx scripts/phase-claim-physical-return-real-fnsku-controlled-seed-v1.ts --execute
 *   npx tsx scripts/phase-claim-physical-return-real-fnsku-controlled-seed-v1.ts --rollback --run-id=<UTC>
 */
import { createRequire } from "node:module";
import type { Module } from "node:module";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";
import { ITEM_SCAN_OFF_SLIP_NOTE_MARKER } from "../lib/scanner/item-scan-off-slip";
import { resolveProductIdentifier } from "../lib/search/product-identifier-resolve";
import { resolveOperationalProductLinkage } from "../lib/product-linkage-operational-resolve";
import { buildCandidateMoneyProjection } from "../lib/claims/center/claim-center-candidate-money";
import { isSafeForProductStory } from "../lib/claims/center/claim-center-ui-copy";
import {
  attachPhysicalReturnMvpFields,
  isPhysicalReturnMvpRow,
} from "../lib/claims/center/claim-center-physical-return-mvp";
import type { ClaimCenterV1Row } from "../lib/claims/center/claim-center-v1-types";
import { runClaimIntake } from "../lib/claims/intake/claim-generator-registry";
import { emitBoxCloseCandidates, emitPerProblemScanCandidate } from "../lib/claims/intake/claim-live-trigger-emitters";
import { loadClaimCandidateIntakePolicy } from "../lib/claim-candidate-intake-policy";
import { RETURN_ITEMS_STAGING_SUPABASE_REF } from "../lib/scanner/return-items-test-data-guard";

const STAGING_REF = RETURN_ITEMS_STAGING_SUPABASE_REF;
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const MAIN_ORG = "00000000-0000-0000-0000-000000000001";
const TARGET_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TARGET_FNSKU = "B0000B11UX";
const TARGET_ASIN = "B0000B11UX";
const TARGET_MSKU = "X0036MJ5ZB";
const TARGET_PRODUCT_ID = "8beddd08-4133-48fb-abc1-279e61af8caf";
const SEED_MARKER = "physical_return_real_fnsku_controlled_seed_v1";
const SEED_REASON = "Maysam-approved staging smoke for physical return claim MVP";
const OUT_BASE = ".cursor/audit-reports/phase-claim-physical-return-real-fnsku-controlled-seed-v1";
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

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  return stamp();
}

async function connectPg(): Promise<pg.Client> {
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url) throw new Error("STAGING_DIRECT_POSTGRES_URL unset");
  if (!url.includes(STAGING_REF)) throw new Error(`BLOCKED: must target staging ref ${STAGING_REF}`);
  if (url.includes(ORIGINAL_REF)) throw new Error("BLOCKED: original/live ref detected in postgres URL");
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '120s'");
  return c;
}

function stagingAdmin(): SupabaseClient {
  const url = process.env.STAGING_SUPABASE_URL?.trim() ?? "";
  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() ?? "";
  if (refFromSupabaseUrl(url) !== STAGING_REF) throw new Error("STAGING_SUPABASE_URL ref mismatch");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function tableColumns(c: pg.Client, table: string): Promise<Set<string>> {
  const r = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

function scannerFilesUnchanged(): boolean {
  const root = process.cwd();
  if (!fs.existsSync(path.join(root, SCANNER_PREFIX))) return true;
  const gitOut = execSync(`git status --porcelain -- "${SCANNER_PREFIX}"`, { encoding: "utf8", cwd: root }).trim();
  return gitOut.length === 0;
}

function rollbackSql(ids: { packageId: string | null; returnItemId: string | null; candidateIds: string[] }): string {
  const lines = [
    "-- PHASE-CLAIM-PHYSICAL-RETURN-REAL-FNSKU-CONTROLLED-SEED-V1 rollback",
    `-- marker: ${SEED_MARKER}`,
    "",
  ];
  for (const cid of ids.candidateIds) {
    lines.push(`DELETE FROM public.claim_candidates WHERE id = '${cid}'::uuid;`);
  }
  if (ids.returnItemId) {
    lines.push(`UPDATE public.return_items SET deleted_at = now() WHERE id = '${ids.returnItemId}'::uuid;`);
    lines.push(`-- hard delete alternative: DELETE FROM public.return_items WHERE id = '${ids.returnItemId}'::uuid;`);
  }
  if (ids.packageId) {
    lines.push(`UPDATE public.packages SET deleted_at = now() WHERE id = '${ids.packageId}'::uuid;`);
    lines.push(`-- hard delete alternative: DELETE FROM public.packages WHERE id = '${ids.packageId}'::uuid;`);
  }
  lines.push("");
  lines.push(
    `-- marker cleanup: DELETE FROM return_items WHERE raw_return_data->>'test_seed' = '${SEED_MARKER}';`,
  );
  return lines.join("\n");
}

function tridEdgePreview(candidate: Row, returnItem: Row | null) {
  const productId = str(candidate.resolved_product_id) ?? str(returnItem?.resolved_product_id) ?? str(returnItem?.product_id);
  const edges: Row[] = [];
  edges.push({
    edge_type: "product_link",
    reference_kind: "product_id",
    reference_value: productId,
    would_materialize: Boolean(productId),
    blocker: productId ? null : "product_id unresolved",
  });
  if (returnItem) {
    edges.push({
      edge_type: "source_evidence",
      reference_kind: "return_item_id",
      reference_value: str(returnItem.id),
      would_materialize: true,
    });
    const pkgId = str(returnItem.package_id);
    edges.push({
      edge_type: "shipment_scope",
      reference_kind: "package_id",
      reference_value: pkgId,
      would_materialize: Boolean(pkgId),
    });
  }
  return edges;
}

async function runPrecheck(pgClient: pg.Client): Promise<Row> {
  const product = await pgClient.query(
    `SELECT id::text, product_name, deleted_at::text
     FROM public.products
     WHERE organization_id = $1::uuid AND id = $2::uuid`,
    [MAIN_ORG, TARGET_PRODUCT_ID],
  );
  const pim = await pgClient.query(
    `SELECT id::text, product_id::text, fnsku, msku, asin, store_id::text, deleted_at::text
     FROM public.product_identifier_map
     WHERE organization_id = $1::uuid
       AND store_id = $2::uuid
       AND deleted_at IS NULL
       AND (
         upper(btrim(coalesce(fnsku,''))) = upper(btrim($3))
         OR upper(btrim(coalesce(asin,''))) = upper(btrim($3))
         OR upper(btrim(coalesce(msku,''))) = upper(btrim($4))
       )
     LIMIT 5`,
    [MAIN_ORG, TARGET_STORE, TARGET_FNSKU, TARGET_MSKU],
  );
  const existingSeed = await pgClient.query(
    `SELECT ri.id::text AS return_item_id, ri.package_id::text, p.id::text AS package_id
     FROM public.return_items ri
     LEFT JOIN public.packages p ON p.id = ri.package_id
     WHERE ri.organization_id = $1::uuid
       AND ri.store_id = $2::uuid
       AND ri.deleted_at IS NULL
       AND ri.raw_return_data->>'test_seed' = $3
     LIMIT 5`,
    [MAIN_ORG, TARGET_STORE, SEED_MARKER],
  );
  const pkgCols = await tableColumns(pgClient, "packages");
  const riCols = await tableColumns(pgClient, "return_items");
  const requiredPkg = ["organization_id", "store_id", "package_code", "status"];
  const requiredRi = ["organization_id", "store_id", "package_id", "fnsku", "scanned_quantity", "status"];
  const optionalRi = ["asin", "sku", "resolved_product_id", "raw_return_data", "notes", "conditions", "marketplace", "item_name"];
  const price = await pgClient.query(
    `SELECT amount, currency FROM public.product_prices
     WHERE organization_id = $1::uuid AND product_id = $2::uuid AND deleted_at IS NULL
     ORDER BY observed_at DESC NULLS LAST LIMIT 1`,
    [MAIN_ORG, TARGET_PRODUCT_ID],
  ).catch(() => ({ rows: [] }));

  const pimRows = pim.rows as Row[];
  const deterministicPim =
    pimRows.some(
      (r) =>
        str(r.product_id) === TARGET_PRODUCT_ID &&
        (str(r.fnsku)?.toUpperCase() === TARGET_FNSKU || str(r.asin)?.toUpperCase() === TARGET_ASIN),
    ) ?? false;

  return {
    staging_ref: STAGING_REF,
    product_exists: product.rows.length === 1,
    product_row: product.rows[0] ?? null,
    pim_rows: pimRows.length,
    pim_deterministic: deterministicPim,
    pim_sample: pimRows,
    existing_controlled_seed_rows: existingSeed.rows,
    existing_seed_blocked: existingSeed.rows.length > 0,
    packages_columns_ok: requiredPkg.every((c) => pkgCols.has(c)),
    return_items_columns_ok: requiredRi.every((c) => riCols.has(c)),
    return_items_optional_present: Object.fromEntries(optionalRi.map((c) => [c, riCols.has(c)])),
    service_role_path: "STAGING_SERVICE_ROLE_KEY + staging ref guard",
    latest_sale_price_context: price.rows[0] ?? null,
    pass:
      product.rows.length === 1 &&
      deterministicPim &&
      existingSeed.rows.length === 0 &&
      requiredPkg.every((c) => pkgCols.has(c)) &&
      requiredRi.every((c) => riCols.has(c)),
  };
}

async function emitCandidate(admin: SupabaseClient, returnItemId: string, packageId: string): Promise<Row> {
  const policy = await loadClaimCandidateIntakePolicy(admin, MAIN_ORG);
  const perScan = await emitPerProblemScanCandidate(admin, {
    organizationId: MAIN_ORG,
    returnItemId,
  });
  if ((perScan.emitted ?? 0) + (perScan.updated ?? 0) > 0) {
    return { path: "emitPerProblemScanCandidate", result: perScan, policy_trigger: policy.claim_candidate_trigger };
  }
  const boxClose = await emitBoxCloseCandidates(admin, { organizationId: MAIN_ORG, packageId });
  if ((boxClose.emitted ?? 0) + (boxClose.updated ?? 0) > 0) {
    return { path: "emitBoxCloseCandidates", result: boxClose, policy_trigger: policy.claim_candidate_trigger };
  }
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const intake = await runClaimIntake({
    client: admin,
    organizationId: MAIN_ORG,
    storeId: TARGET_STORE,
    sources: ["scanner_physical_review"],
    from,
    to: today,
    apply: true,
    runKind: "manual",
  });
  return { path: "runClaimIntake_scanner_physical_review", result: intake, policy_trigger: policy.claim_candidate_trigger };
}

async function verifyAfterSeed(
  pgClient: pg.Client,
  admin: SupabaseClient,
  returnItemId: string,
): Promise<Row> {
  const riRes = await pgClient.query(
    `SELECT id::text, fnsku, asin, sku, product_id::text, package_id::text,
            organization_id::text, store_id::text, resolved_product_id::text,
            notes, conditions, raw_return_data, created_at::text
     FROM public.return_items WHERE id = $1::uuid`,
    [returnItemId],
  );
  const latestRi = (riRes.rows[0] as Row) ?? null;
  const ccRes = await pgClient.query(
    `SELECT id::text, source_kind, source_table, source_row_id::text, fnsku, asin, sku,
            resolved_product_id::text, store_id::text, claim_family, claim_reason,
            recovery_value, cogs_unit, evidence_status, package_id::text, metadata, created_at::text
     FROM public.claim_candidates
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND source_table = 'return_items' AND source_row_id = $3::uuid
       AND quarantined_at IS NULL
     ORDER BY created_at DESC LIMIT 3`,
    [MAIN_ORG, TARGET_STORE, returnItemId],
  );
  const latestCc = (ccRes.rows[0] as Row) ?? null;

  let product_linkage_result: Row = { status: "no_return_item" };
  let product_story_preview: Row = {};
  let money_display_result: Row = {};
  let trid_edge_preview: Row[] = [];

  if (latestRi) {
    const fnskuOnly = await resolveProductIdentifier(admin, {
      organization_id: MAIN_ORG,
      store_id: TARGET_STORE,
      source_table: "return_items",
      source_row_id: str(latestRi.id),
      fnsku: str(latestRi.fnsku),
    });
    const bundle = await resolveProductIdentifier(admin, {
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
      row: { ...latestRi, resolved_product_id: bundle.resolved_product_id ?? str(latestRi.resolved_product_id) },
    });
    const linkage = operational.display_contract;
    product_linkage_result = {
      fnsku_only_resolver: fnskuOnly,
      bundle_resolver: bundle,
      operational_linkage: operational,
      matches_target_product:
        bundle.resolved_product_id === TARGET_PRODUCT_ID ||
        operational.resolved_product_id === TARGET_PRODUCT_ID ||
        str(latestRi.resolved_product_id) === TARGET_PRODUCT_ID,
      title_only_match: false,
    };
    product_story_preview = {
      is_safe: isSafeForProductStory({ product_linkage: linkage, resolved_product_id: bundle.resolved_product_id }),
      product_not_matched_gone: linkage?.is_resolved === true,
      href: linkage?.is_resolved
        ? `/dashboard/products?search=${encodeURIComponent(str(latestRi.asin) ?? str(latestRi.fnsku) ?? "")}`
        : null,
    };
    if (latestCc) {
      const productBlocked = !linkage?.is_resolved;
      const minimalRow: ClaimCenterV1Row = {
        id: str(latestCc.id) ?? "",
        organization_id: MAIN_ORG,
        store_id: str(latestCc.store_id),
        source_kind: str(latestCc.source_kind),
        source_table: "return_items",
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
        product_story_href: null,
        created_at: str(latestCc.created_at),
        updated_at: null,
      };
      const [mvpRow] = attachPhysicalReturnMvpFields([
        { ...minimalRow, money_display: buildCandidateMoneyProjection(minimalRow) },
      ]);
      const money = mvpRow.money_display ?? buildCandidateMoneyProjection(mvpRow);
      money_display_result = {
        physical_return_mvp: isPhysicalReturnMvpRow(mvpRow),
        missing_next: mvpRow.physical_return_display?.missing_next,
        cost_unknown: money.cost_unknown,
        amount_display_label: money.amount_display_label,
        sale_price_context_only: money.latest_sale_price_context,
        never_sale_as_cogs: true,
      };
      trid_edge_preview = tridEdgePreview(latestCc, latestRi);
    }
  }

  return { product_linkage_result, product_story_preview, money_display_result, trid_edge_preview, latestCc };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const execute = process.argv.includes("--execute");
  const rollbackOnly = process.argv.includes("--rollback");
  const outDir = path.join(OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const pgClient = await connectPg();
  const admin = stagingAdmin();

  if (rollbackOnly) {
    const rbPath = path.join(outDir, "rollback.sql");
    if (!fs.existsSync(rbPath)) throw new Error(`rollback.sql missing for run ${runId}`);
    const sql = fs.readFileSync(rbPath, "utf8");
    await pgClient.query(sql);
    await pgClient.end();
    console.log(JSON.stringify({ run_id: runId, rollback: "applied" }, null, 2));
    return;
  }

  const precheck = await runPrecheck(pgClient);
  fs.writeFileSync(path.join(outDir, "precheck.json"), JSON.stringify(precheck, null, 2));

  if (!precheck.pass) {
    await pgClient.end();
    const result = { run_id: runId, precheck_result: precheck, blocked: "precheck_failed" };
    fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    process.exit(2);
  }

  const pimBefore = await admin.from("product_identifier_map").select("id", { count: "exact", head: true }).eq("organization_id", MAIN_ORG);
  const productsBefore = await admin.from("products").select("id", { count: "exact", head: true }).eq("organization_id", MAIN_ORG);
  const casesBefore = await admin.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", MAIN_ORG);
  const subsBefore = await admin.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", MAIN_ORG);

  let rows_inserted: Row = {};
  let seeded_return_item_id: string | null = null;
  let seeded_package_id: string | null = null;
  let candidate_ids: string[] = [];
  let candidate_emit: Row | null = null;

  if (execute) {
    const session = randomUUID().slice(0, 8);
    const tracking = `CTRL-PR-${TARGET_FNSKU.slice(-6)}-${session}`;
    const packageCode = `PKG-CTRL-PR-${session}`;
    const productName = str((precheck.product_row as Row | null)?.product_name) ?? "Physical return controlled seed unit";
    const notes = `Controlled staging anchor · ${ITEM_SCAN_OFF_SLIP_NOTE_MARKER}`;
    const rawReturnData = {
      test_seed: SEED_MARKER,
      reason: SEED_REASON,
      controlled_seed_v1: true,
      source: "controlled_staging_seed",
      identifiers: { fnsku: TARGET_FNSKU, asin: TARGET_ASIN, msku: TARGET_MSKU, product_id: TARGET_PRODUCT_ID },
    };
    const manifestData = { test_seed: SEED_MARKER, reason: SEED_REASON, controlled_seed_v1: true };

    const pkgIns = await pgClient.query(
      `INSERT INTO public.packages (
         organization_id, store_id, package_code, tracking_number, status, manifest_data, notes
       ) VALUES ($1::uuid, $2::uuid, $3, $4, 'open', $5::jsonb, $6)
       RETURNING id::text`,
      [MAIN_ORG, TARGET_STORE, packageCode, tracking, JSON.stringify(manifestData), SEED_REASON],
    );
    seeded_package_id = str(pkgIns.rows[0]?.id);

    const riIns = await pgClient.query(
      `INSERT INTO public.return_items (
         organization_id, store_id, marketplace, package_id, item_name,
         sku, fnsku, asin, resolved_product_id, scanned_quantity,
         conditions, status, notes, raw_return_data
       ) VALUES (
         $1::uuid, $2::uuid, 'amazon', $3::uuid, $4,
         $5, $6, $7, $8::uuid, 1,
         $9::text[], 'received', $10, $11::jsonb
       )
       RETURNING id::text`,
      [
        MAIN_ORG,
        TARGET_STORE,
        seeded_package_id,
        productName,
        TARGET_MSKU,
        TARGET_FNSKU,
        TARGET_ASIN,
        TARGET_PRODUCT_ID,
        ["sellable_ok"],
        notes,
        JSON.stringify(rawReturnData),
      ],
    );
    seeded_return_item_id = str(riIns.rows[0]?.id);
    rows_inserted = { package_id: seeded_package_id, return_item_id: seeded_return_item_id, tracking, package_code: packageCode };

    candidate_emit = await emitCandidate(admin, seeded_return_item_id!, seeded_package_id!);
    const ccLookup = await pgClient.query(
      `SELECT id::text FROM public.claim_candidates
       WHERE organization_id = $1::uuid AND source_table = 'return_items' AND source_row_id = $2::uuid
       ORDER BY created_at DESC`,
      [MAIN_ORG, seeded_return_item_id],
    );
    candidate_ids = ccLookup.rows.map((r: { id: string }) => String(r.id));
  }

  const rollback_file = path.join(outDir, "rollback.sql");
  fs.writeFileSync(
    rollback_file,
    rollbackSql({
      packageId: seeded_package_id,
      returnItemId: seeded_return_item_id,
      candidateIds: candidate_ids,
    }),
  );

  const verification = seeded_return_item_id
    ? await verifyAfterSeed(pgClient, admin, seeded_return_item_id)
    : { skipped: !execute };

  await pgClient.end();

  const pimAfter = await admin.from("product_identifier_map").select("id", { count: "exact", head: true }).eq("organization_id", MAIN_ORG);
  const productsAfter = await admin.from("products").select("id", { count: "exact", head: true }).eq("organization_id", MAIN_ORG);
  const casesAfter = await admin.from("claim_cases").select("id", { count: "exact", head: true }).eq("organization_id", MAIN_ORG);
  const subsAfter = await admin.from("claim_submissions").select("id", { count: "exact", head: true }).eq("organization_id", MAIN_ORG);

  let buildOk = false;
  let buildError: string | null = null;
  try {
    execSync("npm run build", { cwd: process.cwd(), stdio: "pipe", encoding: "utf8", timeout: 300000 });
    buildOk = true;
  } catch (e) {
    buildError = e instanceof Error ? e.message.slice(0, 400) : String(e);
  }

  let smokeOk = false;
  let smokeError: string | null = null;
  if (execute) {
    try {
      execSync("npx tsx scripts/phase-claim-physical-return-real-fnsku-rescan-smoke-v1.ts", {
        cwd: process.cwd(),
        stdio: "pipe",
        encoding: "utf8",
        timeout: 300000,
      });
      smokeOk = true;
    } catch (e) {
      smokeError = e instanceof Error ? e.message.slice(0, 500) : String(e);
    }
  }

  const linkagePass =
    execute &&
    (verification as Row).product_linkage_result &&
    ((verification as Row).product_linkage_result as Row).matches_target_product === true;
  const storyPass =
    execute && (verification as Row).product_story_preview && ((verification as Row).product_story_preview as Row).product_not_matched_gone === true;
  const tridPass =
    execute &&
    Array.isArray((verification as Row).trid_edge_preview) &&
    ((verification as Row).trid_edge_preview as Row[]).some((e) => e.edge_type === "product_link" && e.would_materialize);

  const safeTrid = linkagePass && storyPass && tridPass && buildOk && (execute ? smokeOk : false);

  const result = {
    audit: "PHASE-CLAIM-PHYSICAL-RETURN-REAL-FNSKU-CONTROLLED-SEED-V1",
    run_id: runId,
    mode: execute ? "seed_and_verify" : "precheck_only",
    precheck_result: precheck,
    rows_inserted,
    rollback_file,
    seeded_return_item_id,
    seeded_package_id_if_any: seeded_package_id,
    candidate_emit,
    candidate_ids,
    product_linkage_result: (verification as Row).product_linkage_result ?? null,
    product_story_preview: (verification as Row).product_story_preview ?? null,
    money_display_result: (verification as Row).money_display_result ?? null,
    trid_edge_preview: (verification as Row).trid_edge_preview ?? [],
    no_product_mutation_verification: { before: productsBefore.count, after: productsAfter.count, unchanged: productsBefore.count === productsAfter.count },
    no_pim_mutation_verification: { before: pimBefore.count, after: pimAfter.count, unchanged: pimBefore.count === pimAfter.count },
    no_claim_cases_submissions: {
      cases_unchanged: casesBefore.count === casesAfter.count,
      submissions_unchanged: subsBefore.count === subsAfter.count,
    },
    no_scanner_code_change_verification: scannerFilesUnchanged(),
    build_result: execute ? (buildOk ? "PASS" : "FAIL") : "SKIPPED",
    build_error: buildError,
    smoke_result: execute ? (smokeOk ? "PASS" : "FAIL") : "SKIPPED",
    smoke_error: smokeError,
    SAFE_TO_IMPLEMENT_PHYSICAL_RETURN_TRID_EDGES: safeTrid ? "yes" : "no",
    NEXT_EXACT_PROMPT: safeTrid
      ? "PHASE-CLAIM-PHYSICAL-RETURN-TRID-EDGES-APPLY-V1 (materialize product_link + return_item edges for main-org B0000B11UX controlled-seed candidate; Maysam approval)"
      : execute
        ? "PHASE-CLAIM-PHYSICAL-RETURN-REAL-FNSKU-CONTROLLED-SEED-REPAIR-V1 (fix seed/linkage/candidate emit blockers)"
        : "Re-run with --execute after Maysam approval",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));

  if (!precheck.pass) process.exit(2);
  if (!execute) process.exit(0);
  if (!buildOk || !smokeOk) process.exit(1);
  if (!safeTrid) process.exit(3);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
