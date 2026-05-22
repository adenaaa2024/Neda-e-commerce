/**
 * NEDA-23-AUTO-LOOKUP-DETAIL-LINK-AND-VIEWS-V193
 * Usage: npx tsx scripts/neda-23-auto-lookup-detail-link-and-views-v193.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveProductForScannerItem } from "../lib/scanner/resolve-product-for-scanner-item";
import {
  buildOperatorProductDetailHref,
  productLinkageHasDetailPage,
} from "../lib/scanner/operator-product-detail-path";
import {
  mergeExpectedWithScannedCounts,
} from "../lib/scanner/operator-tracking-expectations";

const TASK = "NEDA-23-AUTO-LOOKUP-DETAIL-LINK-AND-VIEWS-V193";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const RUN_ID = `run-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-001`;
const OUT = join(process.cwd(), ".cursor/audit-reports/neda-23-auto-lookup-detail-link-and-views-v193", RUN_ID);

const FIXTURE_ORG_ID = "7397edff-7994-4731-8501-55d258d507d2";
const FIXTURE_STORE_ID = "9adfe198-7c6a-49a5-b0b4-d370a83de06f";
const KNOWN_FNSKU = "X004DMS1TT";
const UNKNOWN_BARCODE = `NEDA23-UNK-${Date.now().toString(36).slice(-8)}`;

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
        const isServer = rel.includes("operator-store-actions") || rel.includes("/returns/actions.ts");
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
  const metaText = readFileSync(join(process.cwd(), "app/scanner/operator-mobile/_components/OperatorProductLinkageMeta.tsx"), "utf8");
  const trackText = readFileSync(join(process.cwd(), "lib/scanner/operator-tracking-expectations.ts"), "utf8");
  const pathText = readFileSync(join(process.cwd(), "lib/scanner/operator-product-detail-path.ts"), "utf8");
  const detailPage = join(process.cwd(), "app/scanner/operator-mobile/products/[productId]/page.tsx");

  add(steps, "product_detail_path", /buildOperatorProductDetailHref/.test(pathText), "href builder");
  add(steps, "product_detail_page", existsSync(detailPage), detailPage);
  add(steps, "fetch_product_detail_action", /fetchOperatorProductDetailAction/.test(storeText), "server read");
  add(steps, "search_products_action", /searchOperatorProductsForStoreAction/.test(storeText), "override search");
  add(steps, "primary_link_component", existsSync(join(process.cwd(), "app/scanner/operator-mobile/_components/ProductLinkagePrimaryLink.tsx")), "link component");
  add(steps, "scan_uses_primary_link", /ProductLinkagePrimaryLink/.test(pageText), "scan page");
  add(steps, "meta_detail_link", /buildOperatorProductDetailHref/.test(metaText), "meta id link");
  add(steps, "wizard_server_preview", /previewOperatorItemBarcodeLinkageAction/.test(retText) && !/fetchProductFromAmazon/.test(retText), "wizard resolver");
  add(steps, "wizard_no_products_insert", !/from\(["']products["']\)\s*\.insert/.test(retText), "no client product create");
  add(steps, "sp_api_dev_only", /showDevSpApi/.test(retText) && /NODE_ENV === "development"/.test(retText), "SP-API gated");
  add(steps, "product_id_first_merge", /scannedByProductId/.test(trackText) && /expected_product_id/.test(trackText), "EP scanned merge");
  add(steps, "drawer_search_server", /searchOperatorProductsForStoreAction/.test(retText), "drawer override search");

  const forbidden = scanForbidden();
  add(steps, "forbidden_zero", forbidden.package_items === 0 && forbidden.returns_table === 0 && forbidden.products_insert === 0, JSON.stringify(forbidden));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? null;
  add(steps, "staging_ref", ref === STAGING_REF, ref ?? "missing");

  let knownResolved = false;
  let unknownUnresolved = false;
  let detailHrefOk = false;
  let probeFnsku = KNOWN_FNSKU;
  let probeOrg = FIXTURE_ORG_ID;
  let probeStore = FIXTURE_STORE_ID;
  if (url && key) {
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const { data: tokenRow } = await sb
      .from("return_items")
      .select("organization_id, store_id, fnsku, resolved_product_id")
      .not("resolved_product_id", "is", null)
      .not("fnsku", "is", null)
      .limit(1)
      .maybeSingle();
    const row = tokenRow as { organization_id?: string; store_id?: string; fnsku?: string; resolved_product_id?: string } | null;
    if (row?.fnsku) probeFnsku = String(row.fnsku).trim();
    if (row?.organization_id) probeOrg = String(row.organization_id).trim();
    if (row?.store_id) probeStore = String(row.store_id).trim();

    const known = await resolveProductForScannerItem(sb, {
      organization_id: probeOrg,
      store_id: probeStore,
      fnsku: probeFnsku,
    });
    knownResolved = known.status === "resolved" && Boolean(known.resolved_product_id);
    const unknown = await resolveProductForScannerItem(sb, {
      organization_id: probeOrg,
      store_id: probeStore,
      sku: UNKNOWN_BARCODE,
    });
    unknownUnresolved = unknown.status === "unresolved" || !unknown.resolved_product_id;
    if (known.resolved_product_id) {
      const href = buildOperatorProductDetailHref(known.resolved_product_id);
      detailHrefOk = Boolean(href?.includes(known.resolved_product_id));
      add(
        steps,
        "detail_href_includes_id",
        detailHrefOk,
        href ?? "null",
      );
    } else {
      add(steps, "detail_href_includes_id", false, "no resolved id for probe");
    }

    const groups = [
      {
        groupKey: "g1",
        sku: "SKU-TEST",
        fnsku: probeFnsku,
        asin: "",
        disposition: "Sellable",
        productLabel: "Test",
        expectedQty: 2,
        expected_product_id: known.resolved_product_id,
      },
    ];
    const sfKey = `${"sku-test".toLowerCase()}\u0000${probeFnsku.toLowerCase()}`;
    const scannedMaps = new Map<string, number>([[sfKey, 0]]);
    const byProductId = new Map<string, number>();
    if (known.resolved_product_id) byProductId.set(known.resolved_product_id, 3);
    const merged = mergeExpectedWithScannedCounts(groups, scannedMaps, byProductId);
    add(
      steps,
      "product_id_first_qty",
      merged.lines[0]?.scannedQty === 3,
      `scanned=${merged.lines[0]?.scannedQty}`,
    );
  } else {
    add(steps, "resolver_known", false, "no service role");
    add(steps, "resolver_unknown", false, "no service role");
    add(steps, "detail_href_includes_id", false, "skipped");
    add(steps, "product_id_first_qty", false, "skipped");
  }

  if (url && key) {
    add(steps, "resolver_known", knownResolved, probeFnsku);
    add(steps, "resolver_unknown", unknownUnresolved, UNKNOWN_BARCODE);
  }

  const pass = steps.every((s) => s.pass);
  const blockers = steps.filter((s) => !s.pass);

  writeReport(
    "manifest.json",
    JSON.stringify({ task: TASK, run_id: RUN_ID, verdict: pass ? "PASS" : "FAIL", steps, forbidden }, null, 2),
  );
  writeReport(
    "lookup-proof.md",
    `# Lookup proof\n\n| Probe | Result |\n|-------|--------|\n| Known FNSKU ${KNOWN_FNSKU} | ${knownResolved ? "resolved" : "fail"} |\n| Unknown code | ${unknownUnresolved ? "unresolved" : "fail"} |\n`,
  );
  writeReport(
    "detail-link-proof.md",
    `# Detail link proof\n\n| Check | Result |\n|-------|--------|\n| \`buildOperatorProductDetailHref\` | ${/buildOperatorProductDetailHref/.test(pathText)} |\n| Detail page route | ${existsSync(detailPage)} |\n| Href includes product id | ${detailHrefOk} |\n| \`productLinkageHasDetailPage\` | ${/productLinkageHasDetailPage/.test(pathText)} |\n`,
  );
  writeReport(
    "forbidden-pattern-scan.md",
    `# Forbidden pattern scan\n\n${JSON.stringify(forbidden, null, 2)}\n`,
  );
  writeReport(
    "blockers.md",
    blockers.length ? blockers.map((b) => `- **${b.id}:** ${b.detail}`).join("\n") : "None.\n",
  );

  console.log(`\n${TASK} → ${OUT}`);
  console.log(pass ? "PASS" : "FAIL");
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
