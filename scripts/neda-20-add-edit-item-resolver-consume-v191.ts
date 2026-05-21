/**
 * NEDA-20-ADD-EDIT-ITEM-RESOLVER-CONSUME-V191
 * Usage: npx tsx scripts/neda-20-add-edit-item-resolver-consume-v191.ts
 *
 * Static + read-only staging probes. No migrations, writes, production, Amazon, or AI.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { RETURN_ITEMS_TABLE, RETURN_SCANNER_LINKAGE_SELECT } from "../app/returns/returns-constants";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const RUN_ID = `run-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-001`;
const OUT = join(process.cwd(), ".cursor/audit-reports/neda-20-add-edit-item-resolver-consume-v191", RUN_ID);

const STORE_ACTIONS = join(process.cwd(), "app/scanner/operator-mobile/_components/operator-store-actions.ts");
const SCAN_PAGE = join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx");
const ITEM_MODAL = join(process.cwd(), "app/scanner/operator-mobile/_components/ItemUnitRecordModal.tsx");
const RETURNS_ACTIONS = join(process.cwd(), "app/returns/actions.ts");
const RETURNS_COMPONENTS = join(process.cwd(), "app/returns/_components.tsx");
const HYDRATE_LIB = join(process.cwd(), "lib/scanner/hydrate-return-item-product-linkage.ts");
const ENRICH_LIB = join(process.cwd(), "lib/scanner/apply-return-item-product-enrichment.ts");

const FIXTURE_PACKAGE_ID = "9528d923-3d27-4aed-a773-095b5028743d";

type Step = { id: string; pass: boolean; detail: string };

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

function extractProjectRef(url: string): string | null {
  return url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? null;
}

function add(steps: Step[], id: string, pass: boolean, detail: string): void {
  steps.push({ id, pass, detail });
}

function writeReport(name: string, body: string): void {
  writeFileSync(join(OUT, name), body, "utf8");
}

async function main(): Promise<void> {
  loadEnvLocal();
  mkdirSync(OUT, { recursive: true });

  const steps: Step[] = [];
  const storeText = readFileSync(STORE_ACTIONS, "utf8");
  const pageText = readFileSync(SCAN_PAGE, "utf8");
  const modalText = readFileSync(ITEM_MODAL, "utf8");
  const retActText = readFileSync(RETURNS_ACTIONS, "utf8");
  const retCompText = readFileSync(RETURNS_COMPONENTS, "utf8");

  add(steps, "lib_hydrate", existsSync(HYDRATE_LIB), HYDRATE_LIB);
  add(
    steps,
    "preview_action",
    /export async function previewOperatorItemBarcodeLinkageAction/.test(storeText),
    "previewOperatorItemBarcodeLinkageAction",
  );
  add(
    steps,
    "insert_returns_linkage",
    /product_linkage:\s*ProductLinkageDisplayContract/.test(storeText) &&
      /hydrateReturnItemProductLinkage/.test(storeText),
    "insertOperatorPackageItemAction returns hydrated contract",
  );
  add(
    steps,
    "page_preview_wire",
    /previewOperatorItemBarcodeLinkageAction/.test(pageText) && /resolveItemUnitBarcodeLinkage/.test(pageText),
    "scan page resolver preview",
  );
  add(
    steps,
    "modal_resolve_prop",
    /resolveBarcodeLinkage/.test(modalText) && /liveLinkage/.test(modalText),
    "ItemUnitRecordModal consumes preview linkage",
  );
  add(
    steps,
    "page_no_products_select",
    !/supabase\.from\(["']products["']\)\.select/.test(pageText),
    "no client products select on scan page",
  );
  add(
    steps,
    "update_enrichment",
    /applyReturnItemProductEnrichmentAfterUpdate/.test(readFileSync(ENRICH_LIB, "utf8")) &&
      /applyReturnItemProductEnrichmentAfterUpdate/.test(retActText),
    "updateReturn re-runs resolver on identifier edits",
  );
  add(
    steps,
    "fetch_linkage_action",
    /fetchReturnItemProductLinkageAction/.test(retActText),
    "detail reload server linkage action",
  );
  add(
    steps,
    "drawer_linkage_meta",
    /OperatorProductLinkageMeta/.test(retCompText) && /fetchReturnItemProductLinkageAction/.test(retCompText),
    "ItemDrawer detail uses hydrated contract",
  );
  add(
    steps,
    "ep_row_operator_meta_only",
    /OperatorProductLinkageMeta linkage=\{linkage\}/.test(pageText) &&
      !/useScannerProductResolutionBadges/.test(pageText),
    "ExpectedInventoryLineRow — OperatorProductLinkageMeta only",
  );

  let forbidden = 0;
  for (const line of pageText.split("\n")) {
    if (/package_items/.test(line)) forbidden++;
    if (/\.from\(["']returns["']\)/.test(line)) forbidden++;
    if (/from\(["']products["']\)\s*\.insert/.test(line)) forbidden++;
  }
  add(steps, "forbidden_scan_refs", forbidden === 0, `forbidden refs on scan page: ${forbidden}`);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const ref = extractProjectRef(url);
  add(steps, "staging_ref", ref === STAGING_REF, `project ref ${ref ?? "missing"}`);

  let probeDetail = "skipped — no service role";
  if (url && key) {
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const sel = `id, ${RETURN_SCANNER_LINKAGE_SELECT}`;
    const { data, error } = await sb
      .from(RETURN_ITEMS_TABLE)
      .select(sel)
      .eq("package_id", FIXTURE_PACKAGE_ID)
      .is("deleted_at", null)
      .limit(3);
    probeDetail = error
      ? `return_items probe error: ${error.message}`
      : `rows=${(data ?? []).length} linkage_cols_ok=${!error}`;
    add(steps, "fixture_return_items_probe", !error, probeDetail);
  } else {
    add(steps, "fixture_return_items_probe", false, probeDetail);
  }

  const v191MainPresent =
    existsSync(
      join(
        process.cwd(),
        ".cursor/audit-reports/operator-item-add-edit-resolver-standard-v191",
      ),
    ) ||
    existsSync(
      join(
        process.cwd(),
        ".cursor/audit-reports/inventory-expected-return-product-id-view-alignment-v191",
      ),
    );

  const pass = steps.every((s) => s.pass);
  const blockers = steps.filter((s) => !s.pass);

  writeReport(
    "manifest.json",
    JSON.stringify(
      {
        task: "NEDA-20-ADD-EDIT-ITEM-RESOLVER-CONSUME-V191",
        run_id: RUN_ID,
        staging_ref: STAGING_REF,
        v191_main_audit_present: v191MainPresent,
        verdict: pass ? "PASS" : "FAIL",
        steps,
      },
      null,
      2,
    ),
  );

  writeReport(
    "validation-results.md",
    `# Validation — NEDA-20

**Verdict:** ${pass ? "**PASS**" : "**FAIL**"}
**Run:** \`${RUN_ID}\`

| Step | Result | Detail |
|------|--------|--------|
${steps.map((s) => `| ${s.id} | ${s.pass ? "PASS" : "FAIL"} | ${s.detail} |`).join("\n")}
`,
  );

  writeReport(
    "blockers.md",
    blockers.length
      ? `# Blockers\n\n${blockers.map((b) => `- **${b.id}:** ${b.detail}`).join("\n")}\n`
      : "# Blockers\n\nNone.\n",
  );

  writeReport(
    "resolver-consume-summary.md",
    `# Resolver-on-save consume — NEDA-20

## V191 Main audits
- operator-item-add-edit-resolver-standard-v191: ${existsSync(join(process.cwd(), ".cursor/audit-reports/operator-item-add-edit-resolver-standard-v191")) ? "present" : "**not in repo**"}
- inventory-expected-return-product-id-view-alignment-v191: ${existsSync(join(process.cwd(), ".cursor/audit-reports/inventory-expected-return-product-id-view-alignment-v191")) ? "present" : "**not in repo**"}

## Implemented surfaces
| Surface | Mechanism |
|---------|-----------|
| Add item (operator modal) | \`previewOperatorItemBarcodeLinkageAction\` on barcode edit; \`insertOperatorPackageItemAction\` returns \`product_linkage\` post-save |
| Save | Server actions only — \`insertReturn\` + enrichment; no browser \`return_items\` writes |
| Edit (returns drawer) | \`updateReturn\` + \`applyReturnItemProductEnrichmentAfterUpdate\`; edit barcode uses preview action |
| Detail | \`fetchReturnItemProductLinkageAction\` + \`OperatorProductLinkageMeta\` |
| Package/pallet child rows | Existing \`listOperatorPackageItemsForPackageAction\` / slip list \`product_linkage\` |
| Expected vs scanned | Quantity variance via \`formatScanVarianceLabel\`; product-id comparison deferred (V191 Main absent) |
`,
  );

  writeReport(
    "stale-ref-scan.md",
    `# Stale ref scan — operator-mobile scan page

| Pattern | Count |
|---------|-------|
| package_items | ${(pageText.match(/package_items/g) ?? []).length} |
| .from("returns") | ${(pageText.match(/\.from\(["']returns["']\)/g) ?? []).length} |
| products.insert | ${(pageText.match(/from\(["']products["']\)\s*\.insert/g) ?? []).length} |
| products.select (client) | ${(pageText.match(/supabase\.from\(["']products["']\)\.select/g) ?? []).length} |
`,
  );

  console.log(`\nNEDA-20 report → ${OUT}`);
  console.log(`Verdict: ${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
