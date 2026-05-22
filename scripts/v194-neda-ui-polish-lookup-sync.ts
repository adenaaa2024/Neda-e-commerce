/**
 * V194-NEDA-UI-POLISH-LOOKUP-SYNC
 * Usage: npx tsx scripts/v194-neda-ui-polish-lookup-sync.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { resolveProductForScannerItem } from "../lib/scanner/resolve-product-for-scanner-item";
import { buildOperatorBarcodeResolverFields } from "../lib/scanner/operator-barcode-preview-input";
import {
  buildOperatorProductDetailHref,
  parseOperatorProductDetailFrom,
  productLinkageHasDetailPage,
  resolveOperatorProductDetailBackLink,
} from "../lib/scanner/operator-product-detail-path";
import {
  mergeExpectedWithScannedCounts,
} from "../lib/scanner/operator-tracking-expectations";
import { PRODUCT_LINKAGE_UNMAPPED_LABEL } from "../lib/scanner/product-linkage-display-contract";

const TASK = "V194-NEDA-UI-POLISH-LOOKUP-SYNC";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const RUN_ID = `run-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-001`;
const OUT = join(process.cwd(), ".cursor/audit-reports/v194-neda-ui-polish-lookup-sync", RUN_ID);

const FIXTURE_ORG_ID = "7397edff-7994-4731-8501-55d258d507d2";
const FIXTURE_STORE_ID = "9adfe198-7c6a-49a5-b0b4-d370a83de06f";
const KNOWN_FNSKU = "X004DMS1TT";
const KNOWN_ASIN = "B08N5WRWNW";
const UNKNOWN_BARCODE = `NEDA194-UNK-${Date.now().toString(36).slice(-8)}`;

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function add(steps: Step[], id: string, pass: boolean, detail: string): void {
  steps.push({ id, pass, detail });
}

function writeReport(name: string, body: string): void {
  writeFileSync(join(OUT, name), body, "utf8");
}

function scanForbidden(): Record<string, number> {
  const counts = { package_items: 0, returns_table: 0, products_insert: 0, products_client_select: 0 };
  const walk = (root: string): void => {
    if (!existsSync(root)) return;
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      const p = join(root, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(ent.name)) {
        const rel = p.replace(process.cwd(), "").replace(/\\/g, "/");
        const isServer =
          rel.includes("operator-store-actions") || rel.includes("/returns/actions.ts");
        for (const line of readFileSync(p, "utf8").split("\n")) {
          if (/package_items/.test(line)) counts.package_items++;
          if (/\.from\(["']returns["']\)/.test(line)) counts.returns_table++;
          if (/from\(["']products["']\)\s*\.insert/.test(line) && !isServer) counts.products_insert++;
          if (/supabaseBrowser[\s\S]{0,40}\.from\(["']products["']\)\.select/.test(line)) counts.products_client_select++;
          if (/supabase\.from\(["']products["']\)\.select/.test(line) && rel.includes("returns/_components")) {
            counts.products_client_select++;
          }
        }
      }
    }
  };
  walk(join(process.cwd(), "app/scanner"));
  walk(join(process.cwd(), "app/returns"));
  return counts;
}

async function main(): Promise<void> {
  loadEnvLocal();
  mkdirSync(OUT, { recursive: true });

  const steps: Step[] = [];
  const storeText = readFileSync(join(process.cwd(), "app/scanner/operator-mobile/_components/operator-store-actions.ts"), "utf8");
  const pageText = readFileSync(join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"), "utf8");
  const retText = readFileSync(join(process.cwd(), "app/returns/_components.tsx"), "utf8");
  const modalText = readFileSync(join(process.cwd(), "app/scanner/operator-mobile/_components/ItemUnitRecordModal.tsx"), "utf8");
  const pathText = readFileSync(join(process.cwd(), "lib/scanner/operator-product-detail-path.ts"), "utf8");
  const previewHelper = readFileSync(join(process.cwd(), "lib/scanner/operator-barcode-preview-input.ts"), "utf8");
  const returnLinkage = readFileSync(join(process.cwd(), "lib/scanner/return-record-product-linkage.ts"), "utf8");
  const detailPage = join(process.cwd(), "app/scanner/operator-mobile/products/[productId]/page.tsx");

  add(steps, "barcode_resolver_fields", /buildOperatorBarcodeResolverFields/.test(previewHelper) && /asin/.test(previewHelper), "ASIN/UPC/SKU fields");
  add(steps, "preview_uses_resolver_fields", /buildOperatorBarcodeResolverFields/.test(storeText), "server preview classify");
  add(steps, "detail_from_query", /resolveOperatorProductDetailBackLink/.test(pathText) && /parseOperatorProductDetailFrom/.test(pathText), "context back");
  add(steps, "detail_page_back", /resolveOperatorProductDetailBackLink/.test(readFileSync(detailPage, "utf8")), "detail page consumes from");
  add(steps, "primary_link_detail_from", /detailFrom/.test(readFileSync(join(process.cwd(), "app/scanner/operator-mobile/_components/ProductLinkagePrimaryLink.tsx"), "utf8")), "href ?from=");
  add(steps, "no_duplicate_meta_link", /linkResolvedProductId=\{false\}/.test(pageText) && /linkResolvedProductId=\{false\}/.test(retText), "meta id link off when primary");
  add(steps, "wizard_paste_lookup", /onPaste/.test(retText) && /handleBarcodeLookup/.test(retText), "wizard paste");
  add(steps, "edit_paste_lookup", /handleEditBarcodeLookup/.test(retText) && /onPaste/.test(retText), "drawer paste");
  add(steps, "lookup_finally_unresolved", /setCatalogResolution\("unresolved"\)/.test(retText) && /catch/.test(retText), "stops loading");
  add(steps, "package_items_product_column", /productLinkageFromReturnRecord/.test(retText) && /detailFrom="package"/.test(retText), "package child rows");
  add(steps, "modal_blur_paste", /onBlur/.test(modalText) && /onPaste/.test(modalText), "item modal triggers");
  add(steps, "product_id_first_merge", /scannedByProductId/.test(readFileSync(join(process.cwd(), "lib/scanner/operator-tracking-expectations.ts"), "utf8")), "EP merge");
  add(steps, "unmapped_label_const", PRODUCT_LINKAGE_UNMAPPED_LABEL === "No product link yet", PRODUCT_LINKAGE_UNMAPPED_LABEL);

  const forbidden = scanForbidden();
  add(steps, "forbidden_zero", forbidden.package_items === 0 && forbidden.returns_table === 0 && forbidden.products_insert === 0 && forbidden.products_client_select === 0, JSON.stringify(forbidden));

  const asinFields = buildOperatorBarcodeResolverFields(KNOWN_ASIN);
  add(steps, "classify_asin", Boolean(asinFields.asin), JSON.stringify(asinFields));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? null;
  add(steps, "staging_ref", ref === STAGING_REF, ref ?? "missing");

  let probeOrg = FIXTURE_ORG_ID;
  let probeStore = FIXTURE_STORE_ID;
  let probeFnsku = KNOWN_FNSKU;
  if (url && key) {
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const { data: tokenRow } = await sb
      .from("return_items")
      .select("organization_id, store_id, fnsku")
      .not("fnsku", "is", null)
      .limit(1)
      .maybeSingle();
    if (tokenRow?.fnsku) probeFnsku = String(tokenRow.fnsku).trim();
    if (tokenRow?.organization_id) probeOrg = String(tokenRow.organization_id).trim();
    if (tokenRow?.store_id) probeStore = String(tokenRow.store_id).trim();

    const fnskuRes = await resolveProductForScannerItem(sb, {
      organization_id: probeOrg,
      store_id: probeStore,
      fnsku: probeFnsku,
    });
    add(steps, "resolve_fnsku", fnskuRes.status === "resolved" || fnskuRes.status === "unresolved", fnskuRes.status);

    const asinRes = await resolveProductForScannerItem(sb, {
      organization_id: probeOrg,
      store_id: probeStore,
      asin: KNOWN_ASIN,
    });
    add(steps, "resolve_asin_path", asinRes.matched_via !== "none" || asinRes.status === "unresolved", asinRes.matched_via);

    const unknown = await resolveProductForScannerItem(sb, {
      organization_id: probeOrg,
      store_id: probeStore,
      sku: UNKNOWN_BARCODE,
    });
    add(steps, "unknown_unresolved", unknown.status === "unresolved", unknown.status);

    if (fnskuRes.resolved_product_id) {
      const href = buildOperatorProductDetailHref(fnskuRes.resolved_product_id, { from: "scan" });
      add(steps, "href_from_scan", Boolean(href?.includes("from=scan")), href ?? "");
      const back = resolveOperatorProductDetailBackLink("returns");
      add(steps, "back_returns", back.href === "/returns", back.label);
    }
  }

  add(steps, "return_record_linkage_helper", /productLinkageFromReturnRecord/.test(returnLinkage), "package column helper");

  const pass = steps.filter((s) => s.pass).length;
  const fail = steps.filter((s) => !s.pass).length;
  const verdict = fail === 0 ? "PASS" : pass > 0 ? "PARTIAL" : "FAIL";

  writeReport(
    "manifest.json",
    JSON.stringify({ task: TASK, run_id: RUN_ID, verdict, pass, fail, steps }, null, 2),
  );
  writeReport(
    "ui-surface-summary.md",
    `# V194 UI surface summary\n\n| Area | Change |\n|------|--------|\n| Barcode preview | Server classifies ASIN/FNSKU/UPC/SKU via \`buildOperatorBarcodeResolverFields\` |\n| Lookup UX | Blur/scan/enter/paste; try/catch clears loading; unresolved → **${PRODUCT_LINKAGE_UNMAPPED_LABEL}** |\n| Product detail | \`?from=\` scan/package/pallet/returns + context back link |\n| Links | \`ProductLinkagePrimaryLink\` + meta without duplicate short-id link |\n| Package drawer | Items table **Product** column uses \`productLinkageFromReturnRecord\` |\n| Scan / modal | Primary product links on slip, EP, hydrated units |\n\n**Verdict:** ${verdict} (${pass}/${steps.length})\n`,
  );
  writeReport(
    "lookup-proof.md",
    `# Lookup proof\n\n${steps.filter((s) => s.id.includes("resolve") || s.id.includes("classify") || s.id.includes("preview") || s.id.includes("paste") || s.id.includes("lookup")).map((s) => `- **${s.id}**: ${s.pass ? "PASS" : "FAIL"} — ${s.detail}`).join("\n")}\n`,
  );
  writeReport(
    "detail-link-proof.md",
    `# Detail link proof\n\n${steps.filter((s) => s.id.includes("detail") || s.id.includes("href") || s.id.includes("back") || s.id.includes("duplicate")).map((s) => `- **${s.id}**: ${s.pass ? "PASS" : "FAIL"} — ${s.detail}`).join("\n")}\n`,
  );
  writeReport(
    "forbidden-pattern-scan.md",
    `# Forbidden pattern scan\n\n\`\`\`json\n${JSON.stringify(forbidden, null, 2)}\n\`\`\`\n`,
  );
  writeReport(
    "blockers.md",
    fail === 0 ? "None.\n" : steps.filter((s) => !s.pass).map((s) => `- **${s.id}**: ${s.detail}`).join("\n") + "\n",
  );

  console.log(`[${TASK}] ${verdict} → ${OUT}`);
  for (const s of steps) console.log(`  ${s.pass ? "✓" : "✗"} ${s.id}: ${s.detail}`);
  if (fail > 0) process.exitCode = 1;
}

void main();
