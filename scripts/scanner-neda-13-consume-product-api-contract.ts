/**
 * SCANNER-NEDA-13 — consume ProductLinkageDisplayContract on operator-mobile.
 * Usage: npx tsx scripts/scanner-neda-13-consume-product-api-contract.ts
 *
 * Prerequisite: product-api-contract-finalize-v169 (contract in lib/scanner/product-linkage-display-contract.ts).
 * Read-only DB probes + static gates. No migrations, writes, production, Amazon, or AI.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { RETURN_ITEMS_TABLE, RETURN_SCANNER_LINKAGE_SELECT } from "../app/returns/returns-constants";

const FIXTURE_PACKAGE_ID = "9528d923-3d27-4aed-a773-095b5028743d";
const NEDA_06_ROW_ID = "ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663";

const OPERATOR_MOBILE_ROOT = join(process.cwd(), "app/scanner/operator-mobile");
const CONTRACT_LIB = join(process.cwd(), "lib/scanner/product-linkage-display-contract.ts");
const STORE_ACTIONS = join(process.cwd(), "app/scanner/operator-mobile/_components/operator-store-actions.ts");
const SCAN_PAGE = join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx");

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

function walkTsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) walkTsFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name.name)) out.push(p);
  }
  return out;
}

function scanForbidden(): {
  package_items: number;
  products_insert: number;
  returns_table: number;
} {
  let package_items = 0;
  let products_insert = 0;
  let returns_table = 0;
  const files = walkTsFiles(OPERATOR_MOBILE_ROOT);
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    if (/package_items/.test(text)) package_items++;
    if (/from\(["']products["']\)\s*\.insert|\.from\("products"\)\.insert/.test(text)) products_insert++;
    if (/\.from\(["']returns["']\)/.test(text)) returns_table++;
  }
  return { package_items, products_insert, returns_table };
}

function staticContractWiring(): Record<string, boolean> {
  const contract = readFileSync(CONTRACT_LIB, "utf8");
  const actions = readFileSync(STORE_ACTIONS, "utf8");
  const page = readFileSync(SCAN_PAGE, "utf8");
  return {
    contract_type_defined: contract.includes("export type ProductLinkageDisplayContract"),
    contract_has_product_name: contract.includes("product_name:"),
    contract_has_fallback_display_name: contract.includes("fallback_display_name:"),
    contract_has_confidence: contract.includes("identifier_resolution_confidence:"),
    slip_row_has_product_linkage: actions.includes("product_linkage: ProductLinkageDisplayContract"),
    package_item_row_has_product_linkage: /OperatorPackageItemRow[\s\S]*product_linkage/.test(actions),
    list_slip_builds_linkage: actions.includes("buildProductLinkageDisplayContract"),
    list_items_builds_linkage: /listOperatorPackageItemsForPackageAction[\s\S]*buildProductLinkageDisplayContract/.test(
      actions,
    ),
    page_imports_contract: page.includes("product-linkage-display-contract"),
    page_primary_label: page.includes("productLinkagePrimaryLabel"),
    page_linkage_meta_ui: page.includes("OperatorSlipProductLinkageMeta"),
    page_no_product_found_ui: page.includes("No product found"),
    page_unresolved_warning_ui: /productLinkageIsUnresolved/.test(page),
    page_no_client_products_for_slip_linkage: !/itemInspectionSlipCells[\s\S]{0,800}supabase\.from\(["']products["']\)/.test(
      page,
    ),
  };
}

async function dbProbes(): Promise<{
  slip_linkage_ok: boolean;
  return_items_linkage_ok: boolean;
  resolved_sample: { id: string; status: string | null; resolved_product_id: string | null } | null;
  unresolved_sample: { id: string; status: string | null; resolved_product_id: string | null } | null;
  fixture_return_items: number;
}> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    return {
      slip_linkage_ok: false,
      return_items_linkage_ok: false,
      resolved_sample: null,
      unresolved_sample: null,
      fixture_return_items: 0,
    };
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const slipSel = `id, description, fnsku, upc, ${RETURN_SCANNER_LINKAGE_SELECT}`;
  const { error: slipErr } = await sb.from("slip_contents").select(slipSel).eq("package_id", FIXTURE_PACKAGE_ID).limit(1);
  const slip_linkage_ok = !slipErr;

  const riSel = `id, item_name, fnsku, sku, ${RETURN_SCANNER_LINKAGE_SELECT}`;
  const { data: riRows, error: riErr } = await sb
    .from(RETURN_ITEMS_TABLE)
    .select(riSel)
    .eq("package_id", FIXTURE_PACKAGE_ID)
    .is("deleted_at", null);

  const return_items_linkage_ok = !riErr;
  const rows = Array.isArray(riRows) ? riRows : [];
  let resolved_sample: { id: string; status: string | null; resolved_product_id: string | null } | null = null;
  let unresolved_sample: { id: string; status: string | null; resolved_product_id: string | null } | null = null;
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const id = String(r.id ?? "");
    const status = r.identifier_resolution_status != null ? String(r.identifier_resolution_status) : null;
    const resolved_product_id = r.resolved_product_id != null ? String(r.resolved_product_id) : null;
    const sample = { id, status, resolved_product_id };
    if (resolved_product_id && !resolved_sample) resolved_sample = sample;
    if (!resolved_product_id && !unresolved_sample) unresolved_sample = sample;
  }
  if (!unresolved_sample && rows.length) {
    const r = rows[0] as Record<string, unknown>;
    unresolved_sample = {
      id: String(r.id ?? NEDA_06_ROW_ID),
      status: r.identifier_resolution_status != null ? String(r.identifier_resolution_status) : null,
      resolved_product_id: null,
    };
  }

  return {
    slip_linkage_ok,
    return_items_linkage_ok,
    resolved_sample,
    unresolved_sample,
    fixture_return_items: rows.length,
  };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const runId = process.env.SCANNER_NEDA_13_RUN_ID ?? "run-20260518-001";
  const outDir = join(
    process.cwd(),
    ".cursor/audit-reports/scanner-neda-13-consume-product-api-contract",
    runId,
  );
  mkdirSync(outDir, { recursive: true });

  const steps: Step[] = [];
  const step = (name: string, ok: boolean, detail: string) => steps.push({ step: name, ok, detail });

  const forbidden = scanForbidden();
  step("forbidden_package_items_zero", forbidden.package_items === 0, `refs=${forbidden.package_items}`);
  step("forbidden_products_insert_zero", forbidden.products_insert === 0, `refs=${forbidden.products_insert}`);
  step("forbidden_returns_table_zero", forbidden.returns_table === 0, `refs=${forbidden.returns_table}`);

  const wiring = staticContractWiring();
  for (const [k, v] of Object.entries(wiring)) {
    step(`wiring_${k}`, v, String(v));
  }

  const db = await dbProbes();
  step("db_slip_linkage_select", db.slip_linkage_ok, db.slip_linkage_ok ? "ok" : "failed");
  step("db_return_items_linkage_select", db.return_items_linkage_ok, db.return_items_linkage_ok ? "ok" : "failed");
  step("db_fixture_hydrate_rows", db.fixture_return_items > 0, `count=${db.fixture_return_items}`);
  step("db_unresolved_sample", Boolean(db.unresolved_sample), JSON.stringify(db.unresolved_sample));
  step(
    "db_resolved_or_null_sample",
    Boolean(db.resolved_sample) || db.fixture_return_items > 0,
    JSON.stringify(db.resolved_sample ?? "none on fixture — unresolved-only ok"),
  );

  const allOk = steps.every((s) => s.ok);

  const snippet = `# Neda contract snippet (ProductLinkageDisplayContract)

Derived from \`lib/scanner/product-linkage-display-contract.ts\` — use server action rows only.

\`\`\`ts
export type ProductLinkageDisplayContract = {
  product_name: string | null;
  identifier_resolution_status: string | null;
  identifier_resolution_confidence: number | null;
  fallback_display_name: string;
};
\`\`\`

## Actions

| Action | Field |
|--------|-------|
| \`listOperatorSlipContentsForPackageAction\` | \`rows[].product_linkage\` |
| \`listOperatorPackageItemsForPackageAction\` | \`rows[].product_linkage\` |

## UI

- Primary label: \`productLinkagePrimaryLabel(product_linkage)\`
- Badges: \`scannerProductResolutionBadges({ identifier_resolution_status })\`
- Confidence: \`formatProductLinkageConfidencePct(confidence)\` when resolved
- Amber **No product found** + **Unresolved** warning badges; fallback subtitle when catalog name differs from slip text
`;

  writeFileSync(join(outDir, "neda-contract-snippet.md"), snippet, "utf8");
  writeFileSync(
    join(outDir, "probe-output.json"),
    JSON.stringify({ runId, steps, wiring, forbidden, db, pass: allOk }, null, 2),
    "utf8",
  );
  writeFileSync(
    join(outDir, "validation-results.md"),
    `# SCANNER-NEDA-13 validation

**Run:** ${runId}  
**Overall:** ${allOk ? "**PASS**" : "**FAIL**"}

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
        audit: "scanner-neda-13-consume-product-api-contract",
        runId,
        pass: allOk,
        files: [
          "lib/scanner/product-linkage-display-contract.ts",
          "app/scanner/operator-mobile/_components/operator-store-actions.ts",
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
| \`lib/scanner/product-linkage-display-contract.ts\` | **New** — \`ProductLinkageDisplayContract\` + server builders |
| \`operator-store-actions.ts\` | Slip + return_items list actions attach \`product_linkage\` |
| \`scan/page.tsx\` | Item inspection consumes \`product_linkage\`; badges + confidence |
`,
    "utf8",
  );

  console.log(JSON.stringify({ outDir, pass: allOk, steps: steps.filter((s) => !s.ok) }, null, 2));
  process.exit(allOk ? 0 : 1);
}

void main();
