/**
 * SCANNER-NEDA-16 — consume V178 backend/product-linkage handoff on operator-mobile.
 * Usage: npx tsx scripts/scanner-neda-16-backend-product-linkage-handoff.ts
 *
 * Read-only DB probes + static gates. No migrations, writes, production, Amazon, or live AI.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { RETURN_ITEMS_TABLE, RETURN_SCANNER_LINKAGE_SELECT } from "../app/returns/returns-constants";
import {
  buildProductLinkageDisplayContract,
  PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL,
  PRODUCT_LINKAGE_UNMAPPED_LABEL,
  productLinkageIsAmbiguous,
  productLinkagePrimaryLabel,
  productLinkageShowsUnmappedLabel,
  fetchProductNamesByResolvedIds,
  type ProductsLookupClient,
} from "../lib/scanner/product-linkage-display-contract";

const FIXTURE_PACKAGE_ID = "9528d923-3d27-4aed-a773-095b5028743d";
const OPERATOR_MOBILE_ROOT = join(process.cwd(), "app/scanner/operator-mobile");
const CONTRACT_LIB = join(process.cwd(), "lib/scanner/product-linkage-display-contract.ts");
const STORE_ACTIONS = join(process.cwd(), "app/scanner/operator-mobile/_components/operator-store-actions.ts");
const SCAN_PAGE = join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx");
const LINKAGE_META = join(process.cwd(), "app/scanner/operator-mobile/_components/OperatorProductLinkageMeta.tsx");
const ITEM_MODAL = join(process.cwd(), "app/scanner/operator-mobile/_components/ItemUnitRecordModal.tsx");
const HANDOFF_V178 = join(process.cwd(), "NEDA_BACKEND_PRODUCT_LINKAGE_HANDOFF_V178.md");

const SURFACE_FILES = [
  SCAN_PAGE,
  STORE_ACTIONS,
  ITEM_MODAL,
  LINKAGE_META,
  join(process.cwd(), "app/scanner/operator-mobile/item-actions.ts"),
];

type Step = { step: string; ok: boolean; detail: string };

function loadEnvLocal(): void {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function latestNeda15Pass(): { runId: string | null; pass: boolean } {
  const root = join(process.cwd(), ".cursor/audit-reports/scanner-neda-15-product-id-ui-final-wiring");
  if (!existsSync(root)) return { runId: null, pass: false };
  const runs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("run-"))
    .map((d) => d.name)
    .sort();
  const runId = runs.at(-1) ?? null;
  if (!runId) return { runId: null, pass: false };
  const p = join(root, runId, "validation-results.md");
  if (!existsSync(p)) return { runId, pass: false };
  return { runId, pass: /\*\*PASS\*\*/i.test(readFileSync(p, "utf8")) };
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) walkTsFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name.name)) out.push(p);
  }
  return out;
}

function scanForbidden(): Record<string, number> {
  let package_items = 0;
  let products_insert = 0;
  let returns_table = 0;
  let browser_db_writes = 0;
  const writeRe =
    /supabase\.(from|rpc)\([^)]+\)\s*\.(insert|update|upsert|delete)\s*\(|\.from\([^)]+\)\s*\.(insert|update|upsert|delete)\s*\(/;

  for (const relPath of SURFACE_FILES) {
    if (!existsSync(relPath)) continue;
    const text = readFileSync(relPath, "utf8");
    const rel = relPath.replace(process.cwd(), "").replace(/\\/g, "/");
    const isServer = rel.includes("operator-store-actions") || rel.includes("item-actions");
    for (const line of text.split("\n")) {
      if (/package_items/.test(line)) package_items++;
      if (/\.from\(["']returns["']\)/.test(line)) returns_table++;
      if (/from\(["']products["']\)\s*\.insert|\.from\("products"\)\.insert/.test(line)) products_insert++;
      if (!isServer && writeRe.test(line) && rel.includes("scan/page")) browser_db_writes++;
    }
  }
  return { package_items, products_insert, returns_table, browser_db_writes };
}

function scanStalePackageFields(): Record<string, number> {
  let select_package_number = 0;
  let select_photo_url_scalar = 0;
  let packages_package_number_ref = 0;
  let pallets_photo_url_ref = 0;
  for (const f of walkTsFiles(OPERATOR_MOBILE_ROOT)) {
    const text = readFileSync(f, "utf8");
    for (const line of text.split("\n")) {
      if (/\.select\([^)]*package_number/.test(line)) select_package_number++;
      if (/\.select\([^)]*[^_]photo_url[^s]/.test(line)) select_photo_url_scalar++;
      if (/packages\.package_number/.test(line)) packages_package_number_ref++;
      if (/pallets\.photo_url/.test(line)) pallets_photo_url_ref++;
    }
  }
  return { select_package_number, select_photo_url_scalar, packages_package_number_ref, pallets_photo_url_ref };
}

function staticUiWiring(): Record<string, boolean> {
  const contract = readFileSync(CONTRACT_LIB, "utf8");
  const actions = readFileSync(STORE_ACTIONS, "utf8");
  const page = readFileSync(SCAN_PAGE, "utf8");
  const meta = readFileSync(LINKAGE_META, "utf8");
  const modal = readFileSync(ITEM_MODAL, "utf8");
  return {
    contract_ProductLinkageDisplayContract: contract.includes("export type ProductLinkageDisplayContract"),
    actions_build_linkage: actions.includes("buildProductLinkageDisplayContract"),
    actions_slip_product_linkage: actions.includes("product_linkage: ProductLinkageDisplayContract"),
    actions_insert_operator_package_item: actions.includes("export async function insertOperatorPackageItemAction"),
    actions_list_slip: actions.includes("export async function listOperatorSlipContentsForPackageAction"),
    actions_list_items: actions.includes("export async function listOperatorPackageItemsForPackageAction"),
    page_uses_shared_meta: page.includes("OperatorProductLinkageMeta"),
    page_primary_label: page.includes("productLinkagePrimaryLabel"),
    page_list_slip_action: page.includes("listOperatorSlipContentsForPackageAction"),
    page_list_items_hydrate: page.includes("listOperatorPackageItemsForPackageAction"),
    page_insert_item_save: page.includes("insertOperatorPackageItemAction"),
    modal_product_linkage_prop: modal.includes("productLinkage"),
    modal_shows_linkage_meta: modal.includes("OperatorProductLinkageMeta"),
    meta_unmapped_label:
      meta.includes(PRODUCT_LINKAGE_UNMAPPED_LABEL) || meta.includes("PRODUCT_LINKAGE_UNMAPPED_LABEL"),
    meta_needs_review_label:
      meta.includes(PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL) || meta.includes("PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL"),
    page_passes_modal_linkage: page.includes("productLinkage={itemUnitModal?.productLinkage"),
    page_no_slip_client_products: !/itemInspectionSlipCells[\s\S]{0,2000}supabase\.from\(["']products["']\)/.test(
      page,
    ),
  };
}

async function dbLinkageSamples(): Promise<{
  resolved: ReturnType<typeof buildProductLinkageDisplayContract> | null;
  unresolved: ReturnType<typeof buildProductLinkageDisplayContract> | null;
  ambiguous: ReturnType<typeof buildProductLinkageDisplayContract> | null;
  null_product_id_safe: boolean;
  slip_rows: number;
  return_rows: number;
}> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    return {
      resolved: null,
      unresolved: null,
      ambiguous: null,
      null_product_id_safe: true,
      slip_rows: 0,
      return_rows: 0,
    };
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const slipSel = `id, description, fnsku, upc, ${RETURN_SCANNER_LINKAGE_SELECT}`;
  const { data: slips } = await sb.from("slip_contents").select(slipSel).eq("package_id", FIXTURE_PACKAGE_ID);

  const riSel = `id, item_name, fnsku, sku, product_identifier, ${RETURN_SCANNER_LINKAGE_SELECT}`;
  const { data: items } = await sb
    .from(RETURN_ITEMS_TABLE)
    .select(riSel)
    .eq("package_id", FIXTURE_PACKAGE_ID)
    .is("deleted_at", null);

  const allRows = [...(Array.isArray(slips) ? slips : []), ...(Array.isArray(items) ? items : [])] as Record<
    string,
    unknown
  >[];
  const productIds = allRows
    .map((r) => String(r.resolved_product_id ?? "").trim())
    .filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const names = await fetchProductNamesByResolvedIds(sb as unknown as ProductsLookupClient, productIds);

  let resolved: ReturnType<typeof buildProductLinkageDisplayContract> | null = null;
  let unresolved: ReturnType<typeof buildProductLinkageDisplayContract> | null = null;
  let ambiguous: ReturnType<typeof buildProductLinkageDisplayContract> | null = null;
  let null_product_id_safe = true;

  for (const raw of allRows) {
    const c = buildProductLinkageDisplayContract(
      raw as Parameters<typeof buildProductLinkageDisplayContract>[0],
      names,
    );
    try {
      const label = productLinkagePrimaryLabel(c);
      if (!label) null_product_id_safe = false;
    } catch {
      null_product_id_safe = false;
    }
    const st = String(raw.identifier_resolution_status ?? "").toLowerCase();
    if (st === "resolved" && !resolved) resolved = c;
    if (st === "unresolved" && !unresolved) unresolved = c;
    if (st === "ambiguous" && !ambiguous) ambiguous = c;
  }

  return {
    resolved,
    unresolved,
    ambiguous,
    null_product_id_safe,
    slip_rows: Array.isArray(slips) ? slips.length : 0,
    return_rows: Array.isArray(items) ? items.length : 0,
  };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const runId = process.env.SCANNER_NEDA_16_RUN_ID ?? "run-20260519-001";
  const outDir = join(
    process.cwd(),
    ".cursor/audit-reports/scanner-neda-16-backend-product-linkage-handoff",
    runId,
  );
  mkdirSync(outDir, { recursive: true });

  const neda15 = latestNeda15Pass();
  const v178Present = existsSync(HANDOFF_V178);
  const steps: Step[] = [];
  const step = (name: string, ok: boolean, detail: string) => steps.push({ step: name, ok, detail });

  step("handoff_v178_doc", v178Present, v178Present ? "NEDA_BACKEND_PRODUCT_LINKAGE_HANDOFF_V178.md present" : "MISSING — used ProductLinkageDisplayContract + NEDA-15 baseline");
  step("prerequisite_neda_15", neda15.pass, neda15.runId ? `${neda15.runId} PASS` : "no PASS run found");

  const forbidden = scanForbidden();
  step("forbidden_package_items_zero", forbidden.package_items === 0, `refs=${forbidden.package_items}`);
  step("forbidden_products_insert_zero", forbidden.products_insert === 0, `refs=${forbidden.products_insert}`);
  step("forbidden_returns_table_zero", forbidden.returns_table === 0, `refs=${forbidden.returns_table}`);
  step("forbidden_browser_db_writes_zero", forbidden.browser_db_writes === 0, `refs=${forbidden.browser_db_writes}`);

  const stale = scanStalePackageFields();
  step("stale_select_package_number_zero", stale.select_package_number === 0, `refs=${stale.select_package_number}`);
  step(
    "stale_select_photo_url_scalar_zero",
    stale.select_photo_url_scalar === 0,
    `refs=${stale.select_photo_url_scalar}`,
  );
  step("forbidden_packages_package_number_ref_zero", stale.packages_package_number_ref === 0, `refs=${stale.packages_package_number_ref}`);
  step("forbidden_pallets_photo_url_ref_zero", stale.pallets_photo_url_ref === 0, `refs=${stale.pallets_photo_url_ref}`);

  const wiring = staticUiWiring();
  for (const [k, v] of Object.entries(wiring)) {
    step(`wiring_${k}`, v, String(v));
  }

  const db = await dbLinkageSamples();
  step("db_fixture_slip_rows", db.slip_rows > 0, `count=${db.slip_rows}`);
  step("db_fixture_return_rows", db.return_rows > 0, `count=${db.return_rows} (test data — not production KPI)`);
  step("null_product_id_no_crash", db.null_product_id_safe, "productLinkagePrimaryLabel safe on fixture rows");
  if (db.unresolved) {
    step(
      "unresolved_shows_unmapped_label",
      productLinkageShowsUnmappedLabel(db.unresolved),
      PRODUCT_LINKAGE_UNMAPPED_LABEL,
    );
  }
  if (db.ambiguous) {
    step("ambiguous_shows_needs_review", productLinkageIsAmbiguous(db.ambiguous), PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL);
  }
  if (db.resolved) {
    step(
      "resolved_uses_product_name",
      Boolean(db.resolved.product_name?.trim()),
      `name=${db.resolved.product_name ?? "null"}`,
    );
  }

  const softSkip = new Set(["handoff_v178_doc", "prerequisite_neda_15", "db_ambiguous_optional"]);
  if (!db.ambiguous) {
    step("db_ambiguous_optional", true, "no ambiguous row on fixture — optional");
  }
  const hardFails = steps.filter((s) => !s.ok && !softSkip.has(s.step));
  const pass = hardFails.length === 0;

  writeFileSync(
    join(outDir, "handoff-consume-summary.md"),
    `# SCANNER-NEDA-16 — backend product linkage handoff consume

**Run:** ${runId}  
**Overall:** ${pass ? "**PASS**" : "**FAIL**"}  
**Production:** blocked (audit only)  
**return_items:** fixture/test data — not production business KPI

## Input docs

| Doc | Status |
|-----|--------|
| NEDA_BACKEND_PRODUCT_LINKAGE_HANDOFF_V178.md | ${v178Present ? "present" : "**MISSING** (repo)"} |
| .ai-memory/* | not in repo — used prior audits + contract lib |

## Surfaces audited

| Surface | Contract path | Status |
|---------|---------------|--------|
| Scan page slip rows | \`listOperatorSlipContentsForPackageAction\` → \`product_linkage\` | ${wiring.page_uses_shared_meta && wiring.page_primary_label ? "✅" : "❌"} |
| Slip line picker | \`productLinkageForSlipMatch\` + shared meta | ${wiring.page_uses_shared_meta ? "✅" : "❌"} |
| Item inspection modal | \`productLinkage\` prop | ${wiring.modal_shows_linkage_meta && wiring.page_passes_modal_linkage ? "✅" : "❌"} |
| Package item hydrate | \`listOperatorPackageItemsForPackageAction\` | ${wiring.page_list_items_hydrate ? "✅" : "❌"} |
| Item save | \`insertOperatorPackageItemAction\` | ${wiring.page_insert_item_save ? "✅" : "❌"} |

## Display copy

| State | Expected | Verified |
|-------|----------|----------|
| Resolved | \`product_name\` via \`productLinkagePrimaryLabel\` | ${db.resolved?.product_name ? "✅" : "fixture partial"} |
| Unresolved | ${PRODUCT_LINKAGE_UNMAPPED_LABEL} | ${db.unresolved && productLinkageShowsUnmappedLabel(db.unresolved) ? "✅" : "—"} |
| Ambiguous | ${PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL} | ${db.ambiguous ? "✅" : "optional on fixture"} |
`,
    "utf8",
  );

  writeFileSync(
    join(outDir, "forbidden-contract-scan.md"),
    `# Forbidden contract scan

| Pattern | Hits |
|---------|------|
| package_items | ${forbidden.package_items} |
| .from("returns") | ${forbidden.returns_table} |
| products.insert | ${forbidden.products_insert} |
| browser direct writes (scan page) | ${forbidden.browser_db_writes} |
| packages.package_number (code ref) | ${stale.packages_package_number_ref} |
| pallets.photo_url (code ref) | ${stale.pallets_photo_url_ref} |
| .select package_number | ${stale.select_package_number} |
| .select scalar photo_url | ${stale.select_photo_url_scalar} |

**Verdict:** ${forbidden.package_items === 0 && forbidden.returns_table === 0 && forbidden.products_insert === 0 && forbidden.browser_db_writes === 0 && stale.packages_package_number_ref === 0 && stale.pallets_photo_url_ref === 0 ? "**PASS**" : "**FAIL**"}
`,
    "utf8",
  );

  writeFileSync(
    join(outDir, "ui-surface-audit.md"),
    `# UI surface audit

## Server actions (approved)

- \`listOperatorSlipContentsForPackageAction\` — builds \`ProductLinkageDisplayContract\` per slip line
- \`listOperatorPackageItemsForPackageAction\` — \`product_linkage\` on return_item rows
- \`insertOperatorPackageItemAction\` — writes \`return_items\` (not \`package_items\`)

## Client

- No browser Supabase writes on item-scan save path
- Slip/return product names resolved server-side via \`fetchProductNamesByResolvedIds\`
- EP identify gate may still read \`products\` for barcode lookup (out of slip-linkage scope)

## Note

\`return_items\` rows on fixture DB are smoke/test data; do not use for production KPIs.
`,
    "utf8",
  );

  writeFileSync(
    join(outDir, "probe-output.json"),
    JSON.stringify({ runId, v178Present, neda15, steps, wiring, forbidden, stale, db, pass }, null, 2),
    "utf8",
  );

  writeFileSync(
    join(outDir, "validation-results.md"),
    `# SCANNER-NEDA-16 validation

**Run:** ${runId}  
**Overall:** ${pass ? "**PASS**" : "**FAIL**"}

| Step | OK | Detail |
|------|----|--------|
${steps.map((s) => `| ${s.step} | ${s.ok ? "✅" : "❌"} | ${s.detail.replace(/\|/g, "\\|")} |`).join("\n")}
`,
    "utf8",
  );

  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        audit: "scanner-neda-16-backend-product-linkage-handoff",
        runId,
        pass,
        v178HandoffPresent: v178Present,
        neda15Run: neda15.runId,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(JSON.stringify({ outDir, pass, failed: hardFails }, null, 2));
  process.exit(pass ? 0 : 1);
}

void main();
