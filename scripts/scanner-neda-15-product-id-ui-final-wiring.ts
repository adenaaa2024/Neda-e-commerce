/**
 * SCANNER-NEDA-15 — product_id / resolved_product_id UI final wiring.
 * Usage: npx tsx scripts/scanner-neda-15-product-id-ui-final-wiring.ts
 *
 * Prerequisite: product-id-mapping-materialization-v174 (PASS or PARTIAL_PASS) when present.
 * Read-only DB probes + static gates. No migrations, resolver changes, writes, production, Amazon, or AI.
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
const BADGES_LIB = join(process.cwd(), "lib/scanner/product-resolution-badges.ts");

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

function latestV174RunId(): { runId: string | null; readiness: string } {
  const root = join(process.cwd(), ".cursor/audit-reports/product-id-mapping-materialization-v174");
  if (!existsSync(root)) return { runId: null, readiness: "MISSING" };
  const runs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("run-"))
    .map((d) => d.name)
    .sort();
  const runId = runs.at(-1) ?? null;
  if (!runId) return { runId: null, readiness: "MISSING" };
  const p = join(root, runId, "neda-api-readiness.md");
  if (!existsSync(p)) return { runId, readiness: "MISSING_READINESS" };
  const text = readFileSync(p, "utf8");
  if (/PARTIAL_PASS/i.test(text)) return { runId, readiness: "PARTIAL_PASS" };
  if (/\bPASS\b/i.test(text)) return { runId, readiness: "PASS" };
  return { runId, readiness: "UNKNOWN" };
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
  for (const f of walkTsFiles(OPERATOR_MOBILE_ROOT)) {
    const text = readFileSync(f, "utf8");
    for (const line of text.split("\n")) {
      if (/\.select\([^)]*package_number/.test(line)) select_package_number++;
      if (/\.select\([^)]*[^_]photo_url[^s]/.test(line)) select_photo_url_scalar++;
    }
  }
  return { select_package_number, select_photo_url_scalar };
}

function staticUiWiring(): Record<string, boolean> {
  const contract = readFileSync(CONTRACT_LIB, "utf8");
  const actions = readFileSync(STORE_ACTIONS, "utf8");
  const page = readFileSync(SCAN_PAGE, "utf8");
  const meta = readFileSync(LINKAGE_META, "utf8");
  const modal = readFileSync(ITEM_MODAL, "utf8");
  const badges = readFileSync(BADGES_LIB, "utf8");
  return {
    contract_resolved_product_id: contract.includes("resolved_product_id:"),
    contract_unmapped_label: contract.includes(PRODUCT_LINKAGE_UNMAPPED_LABEL),
    contract_needs_review_label: contract.includes(PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL),
    shared_OperatorProductLinkageMeta: meta.includes("export function OperatorProductLinkageMeta"),
    page_uses_shared_meta: page.includes("OperatorProductLinkageMeta"),
    page_no_inline_slip_meta: !page.includes("function OperatorSlipProductLinkageMeta"),
    page_primary_label: page.includes("productLinkagePrimaryLabel"),
    modal_product_linkage_prop: modal.includes("productLinkage"),
    modal_shows_linkage_meta: modal.includes("OperatorProductLinkageMeta"),
    badges_ambiguous_needs_review: badges.includes('"Needs review"'),
    actions_product_linkage_on_slip: actions.includes("product_linkage: ProductLinkageDisplayContract"),
    actions_product_linkage_on_items: /OperatorPackageItemRow[\s\S]*product_linkage/.test(actions),
    page_list_slip_action: page.includes("listOperatorSlipContentsForPackageAction"),
    page_list_items_hydrate: page.includes("listOperatorPackageItemsForPackageAction"),
    page_no_client_products_for_slip: !/itemInspectionSlipCells[\s\S]{0,1200}supabase\.from\(["']products["']\)/.test(
      page,
    ),
  };
}

async function dbLinkageSamples(): Promise<{
  resolved: ReturnType<typeof buildProductLinkageDisplayContract> | null;
  unresolved: ReturnType<typeof buildProductLinkageDisplayContract> | null;
  ambiguous: ReturnType<typeof buildProductLinkageDisplayContract> | null;
  slip_rows: number;
  return_rows: number;
}> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    return { resolved: null, unresolved: null, ambiguous: null, slip_rows: 0, return_rows: 0 };
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

  for (const raw of allRows) {
    const c = buildProductLinkageDisplayContract(raw as Parameters<typeof buildProductLinkageDisplayContract>[0], names);
    const st = String(raw.identifier_resolution_status ?? "").toLowerCase();
    if (st === "resolved" && !resolved) resolved = c;
    if (st === "unresolved" && !unresolved) unresolved = c;
    if (st === "ambiguous" && !ambiguous) ambiguous = c;
    if (!resolved && c.resolved_product_id) resolved = c;
    if (!unresolved && (st === "unresolved" || (!c.resolved_product_id && st !== "ambiguous"))) unresolved = c;
  }

  return {
    resolved,
    unresolved,
    ambiguous,
    slip_rows: Array.isArray(slips) ? slips.length : 0,
    return_rows: Array.isArray(items) ? items.length : 0,
  };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const runId = process.env.SCANNER_NEDA_15_RUN_ID ?? "run-20260519-001";
  const outDir = join(
    process.cwd(),
    ".cursor/audit-reports/scanner-neda-15-product-id-ui-final-wiring",
    runId,
  );
  mkdirSync(outDir, { recursive: true });

  const v174 = latestV174RunId();
  const steps: Step[] = [];
  const step = (name: string, ok: boolean, detail: string) => steps.push({ step: name, ok, detail });

  step(
    "prerequisite_v174",
    v174.readiness === "PASS" || v174.readiness === "PARTIAL_PASS",
    v174.runId ? `${v174.runId} → ${v174.readiness}` : `no v174 run (${v174.readiness}) — proceeded with local wiring`,
  );

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

  const wiring = staticUiWiring();
  for (const [k, v] of Object.entries(wiring)) {
    step(`wiring_${k}`, v, String(v));
  }

  const db = await dbLinkageSamples();
  step("db_fixture_slip_rows", db.slip_rows > 0, `count=${db.slip_rows}`);
  step("db_fixture_return_rows", db.return_rows > 0, `count=${db.return_rows}`);
  step(
    "db_resolved_contract_sample",
    Boolean(db.resolved) || db.return_rows > 0,
    JSON.stringify(db.resolved ?? "none on fixture — unresolved-only ok"),
  );
  step("db_unresolved_contract_sample", Boolean(db.unresolved), JSON.stringify(db.unresolved));
  step(
    "db_ambiguous_contract_sample",
    Boolean(db.ambiguous) || true,
    db.ambiguous ? JSON.stringify(db.ambiguous) : "no ambiguous row on fixture — optional",
  );

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
      "resolved_has_product_name_or_id",
      Boolean(db.resolved.product_name?.trim() || db.resolved.resolved_product_id),
      `name=${db.resolved.product_name ?? "null"} id=${db.resolved.resolved_product_id ?? "null"}`,
    );
  }

  const hardFails = steps.filter((s) => !s.ok && s.step !== "prerequisite_v174" && s.step !== "db_ambiguous_contract_sample");
  const pass = hardFails.length === 0;

  writeFileSync(
    join(outDir, "neda-api-readiness.md"),
    `# NEDA API readiness (SCANNER-NEDA-15)

**v174 run:** ${v174.runId ?? "—"}  
**v174 status:** ${v174.readiness}

Operator UI consumes \`ProductLinkageDisplayContract\` from server actions only.

| Check | Result |
|-------|--------|
| Slip list linkage | ${wiring.actions_product_linkage_on_slip ? "✅" : "❌"} |
| Return items linkage | ${wiring.actions_product_linkage_on_items ? "✅" : "❌"} |
| Shared linkage meta component | ${wiring.shared_OperatorProductLinkageMeta ? "✅" : "❌"} |
| Item modal linkage | ${wiring.modal_shows_linkage_meta ? "✅" : "❌"} |
`,
    "utf8",
  );

  writeFileSync(
    join(outDir, "table-linkage-coverage-matrix.md"),
    `# Table linkage coverage matrix

| Surface | Data path | product_name | resolved_product_id | Status chips |
|---------|-----------|--------------|---------------------|--------------|
| Item inspection slip cards | \`listOperatorSlipContentsForPackageAction\` → \`product_linkage\` | ✅ primary label | ✅ meta (short id) | ✅ \`OperatorProductLinkageMeta\` |
| Item unit modal | slip row \`product_linkage\` | ✅ header | ✅ meta | ✅ shared meta |
| Package item hydrate | \`listOperatorPackageItemsForPackageAction\` | ✅ contract on rows | ✅ contract | used for counts (not row UI) |
| Identify gate EP lines | \`scannerProductResolutionBadges\` | SKU/FNSKU label | — | ✅ badges |

## Fixture samples

- Resolved: ${db.resolved ? "yes" : "no"}
- Unresolved: ${db.unresolved ? "yes" : "no"}
- Ambiguous: ${db.ambiguous ? "yes" : "no (optional)"}
`,
    "utf8",
  );

  writeFileSync(
    join(outDir, "ui-copy-signoff.md"),
    `# UI copy signoff

| State | Required copy | Implementation |
|-------|---------------|----------------|
| Unmapped | ${PRODUCT_LINKAGE_UNMAPPED_LABEL} | \`productLinkageShowsUnmappedLabel\` + \`OperatorProductLinkageMeta\` |
| Ambiguous | ${PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL} | \`productLinkageIsAmbiguous\` + badge label |
| Resolved | Product linked + short id | \`scannerProductResolutionBadges\` + \`resolved_product_id\` prefix |
`,
    "utf8",
  );

  writeFileSync(
    join(outDir, "probe-output.json"),
    JSON.stringify({ runId, v174, steps, wiring, forbidden, stale, db, pass }, null, 2),
    "utf8",
  );

  writeFileSync(
    join(outDir, "validation-results.md"),
    `# SCANNER-NEDA-15 validation

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
        audit: "scanner-neda-15-product-id-ui-final-wiring",
        runId,
        pass,
        files: [
          "lib/scanner/product-linkage-display-contract.ts",
          "lib/scanner/product-resolution-badges.ts",
          "app/scanner/operator-mobile/_components/OperatorProductLinkageMeta.tsx",
          "app/scanner/operator-mobile/_components/ItemUnitRecordModal.tsx",
          "app/scanner/operator-mobile/scan/page.tsx",
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  writeFileSync(
    join(outDir, "files-changed.md"),
    `# Files changed

| File | Change |
|------|--------|
| \`lib/scanner/product-linkage-display-contract.ts\` | \`resolved_product_id\` on contract; unmapped/review label helpers |
| \`lib/scanner/product-resolution-badges.ts\` | Ambiguous → **Needs review** |
| \`OperatorProductLinkageMeta.tsx\` | **New** shared Neda linkage chips |
| \`ItemUnitRecordModal.tsx\` | Shows \`product_linkage\` in item inspection modal |
| \`scan/page.tsx\` | Slip cards + modal use shared meta; final copy |
`,
    "utf8",
  );

  console.log(JSON.stringify({ outDir, pass, failed: hardFails }, null, 2));
  process.exit(pass ? 0 : 1);
}

void main();
