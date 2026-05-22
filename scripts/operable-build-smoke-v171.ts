/**
 * OPERABLE-BUILD-SMOKE-V171 — read-only staging/local operable build matrix.
 * Usage: npx tsx scripts/operable-build-smoke-v171.ts --run-id=20260519T120000Z
 */

import { createRequire, type Module } from "node:module";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { buildClaimFilingPacketPreview } from "../lib/claim-filing-packet-preview";
import { buildClaimEvidenceGraphResponse, fetchDraftRow } from "../lib/claim-evidence-preview";
import { buildReferenceCandidatesResponseForDraftId } from "../lib/claim-reference-candidates";
import { mapRowToProductLinkageDisplayContract } from "../lib/product-linkage-display-contract";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const DRAFT_ID = "003db7ff-23f5-4d28-b13e-e13198ea38d8";
const TARGET_PRODUCT_COUNT = 17_001;
const MISSING_STORAGE_PATHS = 8;

type Row = { id: string; pass: boolean; detail: string };

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function prodBlank(keys: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of keys) {
    const v = process.env[k]?.trim() ?? "";
    out[k] = v === "";
  }
  return out;
}

function routeExists(rel: string): boolean {
  return fs.existsSync(path.join(process.cwd(), rel));
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.resolve(
    process.cwd(),
    ".cursor/audit-reports/operable-build-smoke-v171",
    id,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const ref = refFromSupabaseUrl(url);
  const stagingRef = getStagingProjectRef({ loadEnv: false });
  const prodKeys = [
    "PRODUCTION_SUPABASE_URL",
    "PRODUCTION_PROJECT_REF",
    "PRODUCTION_SERVICE_ROLE_KEY",
    "PRODUCTION_DIRECT_POSTGRES_URL",
    "PRODUCTION_SUPABASE_ANON_KEY",
  ];
  const prodBlankMap = prodBlank(prodKeys);

  const matrix: Row[] = [];

  matrix.push({
    id: "env_staging_ref",
    pass: ref === STAGING_REF && stagingRef === STAGING_REF,
    detail: `NEXT_PUBLIC ref=${ref ?? "?"} STAGING_PROJECT_REF=${stagingRef}`,
  });
  matrix.push({
    id: "env_production_blank",
    pass: Object.values(prodBlankMap).every(Boolean),
    detail: prodKeys.map((k) => `${k}_blank=${prodBlankMap[k]}`).join(", "),
  });

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key || ref !== STAGING_REF) {
    fs.writeFileSync(path.join(outDir, "matrix.json"), JSON.stringify({ run_id: id, matrix, status: "FAIL" }, null, 2));
    console.error("BLOCKED: staging env");
    process.exit(2);
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });

  const { count: orgProducts, error: orgPErr } = await sb
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG);
  const { count: storeProducts, error: storePErr } = await sb
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG)
    .eq("store_id", STORE);
  const productCount = storeProducts ?? orgProducts ?? 0;
  const productErr = storePErr?.message ?? orgPErr?.message;
  matrix.push({
    id: "pim_product_count_sam_store",
    pass: !productErr && productCount === TARGET_PRODUCT_COUNT,
    detail: productErr
      ? productErr
      : `store ${STORE.slice(0, 8)}… products=${productCount} (target ${TARGET_PRODUCT_COUNT}); org_total=${orgProducts ?? "?"}`,
  });

  const { error: pkgErr } = await sb.from("package_items").select("id").limit(1);
  const noPackageItems =
    !!pkgErr &&
    (pkgErr.code === "42P01" ||
      pkgErr.code === "PGRST205" ||
      /does not exist|schema cache/i.test(pkgErr.message));
  matrix.push({
    id: "scanner_no_package_items",
    pass: noPackageItems,
    detail: noPackageItems ? "package_items absent (expected)" : "package_items table queryable — unexpected",
  });

  const returnRoute = routeExists("app/returns/page.tsx") || routeExists("app/(admin)/returns/page.tsx");
  const scannerRoute = routeExists("app/scanner/page.tsx") || routeExists("app/(admin)/scanner/page.tsx");
  matrix.push({
    id: "scanner_routes_present",
    pass: returnRoute && scannerRoute,
    detail: `returns=${returnRoute} scanner=${scannerRoute}`,
  });

  const { data: returnRow, error: rErr } = await sb
    .from("return_items")
    .select("id")
    .eq("organization_id", ORG)
    .limit(1);
  const { data: slipRow, error: sErr } = await sb
    .from("slip_contents")
    .select("id")
    .eq("organization_id", ORG)
    .limit(1);
  matrix.push({
    id: "return_items_slip_contents_readable",
    pass: !rErr && !sErr && (returnRow?.length ?? 0) > 0,
    detail: `return_items=${returnRow?.length ?? 0} slip_contents=${slipRow?.length ?? 0} err=${rErr?.message ?? sErr?.message ?? "none"}`,
  });

  const contractModule = path.join(process.cwd(), "lib/product-linkage-display-contract.ts");
  matrix.push({
    id: "product_linkage_display_contract",
    pass: fs.existsSync(contractModule),
    detail: fs.existsSync(contractModule) ? "lib/product-linkage-display-contract.ts" : "missing",
  });

  const draft = await fetchDraftRow(sb, ORG, DRAFT_ID);
  matrix.push({
    id: "claim_pilot_draft_exists",
    pass: !!draft,
    detail: draft ? `draft ${DRAFT_ID}` : "draft not found",
  });

  if (draft) {
    const graph = await buildClaimEvidenceGraphResponse(sb, draft, {
      includePersistedEdgeList: true,
    });
    const enrichment = graph.graph_preview?.enrichment;
    matrix.push({
      id: "claim_evidence_edges_visible",
      pass: (enrichment?.persisted_edge_count ?? 0) >= 1,
      detail: `persisted_edges=${enrichment?.persisted_edge_count ?? 0} generation=${enrichment?.latest_generation_id ?? "?"}`,
    });

    const refCands = await buildReferenceCandidatesResponseForDraftId(sb, ORG, DRAFT_ID);
    matrix.push({
      id: "claim_trid_candidates_visible",
      pass: (refCands?.candidate_count_returned ?? 0) > 0 && refCands?.does_not_submit === true,
      detail: `candidates=${refCands?.candidate_count_returned ?? 0} outcome=${refCands?.outcome ?? "?"}`,
    });

    const packet = await buildClaimFilingPacketPreview(sb, draft);
    matrix.push({
      id: "claim_packet_no_submit_gate",
      pass: packet.does_not_submit === true,
      detail: `does_not_submit=${packet.does_not_submit} filing_ready=${packet.filing_readiness.ready}`,
    });

    const linkage = mapRowToProductLinkageDisplayContract({
      source_table: draft.source_table,
      source_row_id: draft.source_row_id,
      row: {
        id: draft.source_row_id,
        sku: draft.sku,
        resolved_product_id: null,
        identifier_resolution_status: "unresolved",
      },
    });
    matrix.push({
      id: "api_product_linkage_contract",
      pass: linkage != null && "identifier_resolution_status" in linkage,
      detail: linkage
        ? `status=${linkage.identifier_resolution_status} resolved=${linkage.is_resolved}`
        : "no linkage contract",
    });
  }

  matrix.push({
    id: "api_reference_candidates_route_file",
    pass: routeExists("app/api/claims/drafts/[draftId]/reference-candidates/route.ts"),
    detail: "/api/claims/drafts/[draftId]/reference-candidates",
  });

  matrix.push({
    id: "api_product_linkage_route_file",
    pass: routeExists("app/api/claims/drafts/[draftId]/product-linkage/route.ts"),
    detail: "/api/claims/drafts/[draftId]/product-linkage",
  });

  const { data: rawListData, error: rawListErr } = await sb.storage
    .from("raw-reports")
    .list(ORG, { limit: 1 });
  const storageListOk = !rawListErr && rawListData != null;
  matrix.push({
    id: "storage_partial_clone_nonblocker",
    pass: storageListOk && noPackageItems,
    detail: `raw-reports list ok=${storageListOk}; ${MISSING_STORAGE_PATHS} large objects may be absent — product/scanner/claim DB paths do not require them`,
  });

  const status = matrix.every((r) => r.pass) ? "PASS" : "FAIL";
  const payload = {
    run_id: id,
    prompt: "OPERABLE-BUILD-SMOKE-V171",
    staging_project_ref: STAGING_REF,
    organization_id: ORG,
    store_id: STORE,
    draft_id: DRAFT_ID,
    target_product_count: TARGET_PRODUCT_COUNT,
    status,
    matrix,
    env: { active_ref: ref, staging_project_ref: stagingRef, production_keys_blank: prodBlankMap },
  };
  fs.writeFileSync(path.join(outDir, "matrix.json"), JSON.stringify(payload, null, 2));
  console.log(JSON.stringify(payload, null, 2));
  process.exit(status === "PASS" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
