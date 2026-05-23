/**
 * V195-NEDA-HANDOFF-FILE-SYNC-AND-USAGE
 * Usage: npx tsx scripts/neda-handoff-file-sync-and-usage-v195.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanStaleRefs } from "./lib/neda-read-model-smoke-v181";

const TASK = "V195-NEDA-HANDOFF-FILE-SYNC-AND-USAGE";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const RUN_ID = `run-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-001`;
const OUT = join(process.cwd(), ".cursor/audit-reports/v195-neda-handoff-file-sync-and-usage", RUN_ID);

const REQUIRED_FILES = [
  "NEDA_FINAL_BACKEND_HANDOFF_V193.md",
  ".ai-memory/NEDA_HANDOFF.md",
  ".ai-memory/DATABASE_CONTRACT.md",
  ".ai-memory/PRODUCT_ID_MAPPING_STATUS.md",
  ".ai-memory/CURRENT_STATE.md",
  ".ai-memory/NEXT_ACTIONS.md",
  "NEDA_BACKEND_PRODUCT_LINKAGE_HANDOFF_V178.md",
  "NEDA_EXPECTED_PACKAGES_INVENTORY_VIEWS_HANDOFF_V179.md",
];

const V194_MANIFEST = join(
  process.cwd(),
  ".cursor/audit-reports/v194-neda-ui-polish-lookup-sync/run-20260521-001/manifest.json",
);

type Step = { id: string; pass: boolean; detail: string };

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

function main(): void {
  loadEnvLocal();
  mkdirSync(OUT, { recursive: true });

  const steps: Step[] = [];
  const fileRows: string[] = [];

  for (const f of REQUIRED_FILES) {
    const ok = existsSync(join(process.cwd(), f));
    add(steps, `file_${f.replace(/[^a-z0-9]+/gi, "_")}`, ok, ok ? "present" : "MISSING");
    fileRows.push(`| \`${f}\` | ${ok ? "**PRESENT**" : "**MISSING**"} |`);
  }

  const handoffV193 = readFileSync(join(process.cwd(), "NEDA_FINAL_BACKEND_HANDOFF_V193.md"), "utf8");
  add(steps, "handoff_lists_12_rules", /Twelve rules/.test(handoffV193) && /resolver-on-save/.test(handoffV193), "V193 rules doc");

  const storeText = readFileSync(join(process.cwd(), "app/scanner/operator-mobile/_components/operator-store-actions.ts"), "utf8");
  const retActions = readFileSync(join(process.cwd(), "app/returns/actions.ts"), "utf8");
  const retComp = readFileSync(join(process.cwd(), "app/returns/_components.tsx"), "utf8");
  const pageText = readFileSync(join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"), "utf8");
  const trackText = readFileSync(join(process.cwd(), "lib/scanner/operator-tracking-expectations.ts"), "utf8");
  const pathText = readFileSync(join(process.cwd(), "lib/scanner/operator-product-detail-path.ts"), "utf8");
  const contractText = readFileSync(join(process.cwd(), "lib/scanner/product-linkage-display-contract.ts"), "utf8");
  const returnLinkage = readFileSync(join(process.cwd(), "lib/scanner/return-record-product-linkage.ts"), "utf8");
  const previewHelper = readFileSync(join(process.cwd(), "lib/scanner/operator-barcode-preview-input.ts"), "utf8");

  add(steps, "rule1_backend_lookup", /previewOperatorItemBarcodeLinkageAction/.test(storeText) && /buildOperatorBarcodeResolverFields/.test(previewHelper), "preview + field split");
  add(steps, "rule2_resolver_on_save", /applyReturnItemProductEnrichmentAfterInsert/.test(retActions) && /hydrateReturnItemProductLinkage/.test(storeText), "server enrichment");
  const metaPath = join(process.cwd(), "app/scanner/operator-mobile/_components/OperatorProductLinkageMeta.tsx");
  add(steps, "rule3_display_contract", /ProductLinkageDisplayContract/.test(contractText) && existsSync(metaPath), "contract + meta");
  add(steps, "rule4_product_detail_href", /buildOperatorProductDetailHref/.test(pathText) && existsSync(join(process.cwd(), "app/scanner/operator-mobile/products/[productId]/page.tsx")), "detail route");
  add(steps, "rule5_row_vs_product_click", /stopPropagation/.test(retComp) && /onClick=\{\(\) => onItemClick/.test(retComp) && /ProductLinkagePrimaryLink/.test(retComp), "row + isolated link");
  add(steps, "rule6_package_child_contract", /productLinkageFromReturnRecord/.test(returnLinkage) && /detailFrom="package"/.test(retComp), "package drawer");
  add(steps, "rule7_product_id_first", /scannedByProductId/.test(trackText) && /mergeExpectedWithScannedCounts/.test(trackText), "EP merge");
  add(steps, "rule8_no_browser_db_writes", !/supabaseBrowser\.from\([^)]+\)\.(insert|update|upsert|delete)/.test(pageText), "scan page");
  const stale = scanStaleRefs();
  add(steps, "rule9_no_package_items", stale.package_items === 0, `stale package_items=${stale.package_items}`);
  add(steps, "rule10_no_returns_table", stale.returns_table === 0, `returns_table=${stale.returns_table}`);
  add(steps, "rule11_no_browser_amazon", !/fetchProductFromAmazon/.test(retComp), "wizard");
  add(steps, "rule12_sp_api_dev_gated", /showDevSpApi/.test(retComp) && /NODE_ENV === "development"/.test(retComp), "dev mock only");

  const forbidden = scanForbidden();
  add(steps, "forbidden_zero", forbidden.package_items === 0 && forbidden.returns_table === 0 && forbidden.products_insert === 0 && forbidden.products_client_select === 0, JSON.stringify(forbidden));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? null;
  add(steps, "staging_ref_active", ref === STAGING_REF, ref ?? "missing");
  add(steps, "not_original_dev_ref", ref !== ORIGINAL_REF, ref ?? "n/a");
  add(steps, "topology_doc_staging", handoffV193.includes(STAGING_REF), STAGING_REF);
  add(steps, "topology_doc_original", handoffV193.includes(ORIGINAL_REF), ORIGINAL_REF);

  let v194Pass = false;
  let v194Detail = "manifest missing";
  if (existsSync(V194_MANIFEST)) {
    try {
      const m = JSON.parse(readFileSync(V194_MANIFEST, "utf8")) as { verdict?: string; fail?: number };
      v194Pass = m.verdict === "PASS" && (m.fail ?? 1) === 0;
      v194Detail = `${m.verdict} fail=${m.fail ?? "?"}`;
    } catch (e) {
      v194Detail = String(e);
    }
  }
  add(steps, "v194_polish_pass", v194Pass, v194Detail);

  const memoryIndex = readFileSync(join(process.cwd(), ".ai-memory/NEDA_HANDOFF.md"), "utf8");
  add(steps, "memory_refs_v193", memoryIndex.includes("NEDA_FINAL_BACKEND_HANDOFF_V193.md"), "index");
  add(steps, "memory_refs_current_state", memoryIndex.includes("CURRENT_STATE.md"), "index");

  const pass = steps.filter((s) => s.pass).length;
  const fail = steps.filter((s) => !s.pass).length;
  const verdict = fail === 0 ? "PASS" : pass > 0 ? "PARTIAL" : "FAIL";

  writeReport(
    "manifest.json",
    JSON.stringify({ task: TASK, run_id: RUN_ID, verdict, pass, fail, steps, forbidden }, null, 2),
  );
  writeReport(
    "file-inventory.md",
    `# Required file inventory\n\n| Path | Status |\n|------|--------|\n${fileRows.join("\n")}\n\n**Verdict:** ${verdict}\n`,
  );
  writeReport(
    "rules-usage-proof.md",
    `# Rules usage proof\n\n${steps.filter((s) => s.id.startsWith("rule")).map((s) => `- **${s.id}**: ${s.pass ? "PASS" : "FAIL"} — ${s.detail}`).join("\n")}\n`,
  );
  writeReport(
    "forbidden-pattern-scan.md",
    `# Forbidden pattern scan\n\n\`\`\`json\n${JSON.stringify(forbidden, null, 2)}\n\`\`\`\n\nStale (app/scanner): \`\`\`json\n${JSON.stringify(scanStaleRefs(), null, 2)}\n\`\`\`\n`,
  );
  writeReport(
    "db-topology.md",
    `# DB topology\n\n| Role | Ref | Active in .env.local |\n|------|-----|----------------------|\n| Staging | \`${STAGING_REF}\` | ${ref === STAGING_REF ? "yes" : "no"} |\n| Original/current dev | \`${ORIGINAL_REF}\` | ${ref === ORIGINAL_REF ? "yes (wrong for Neda)" : "no"} |\n| Future production | *(not created)* | n/a |\n\n\`NEXT_PUBLIC_SUPABASE_URL\` ref: \`${ref ?? "missing"}\`\n`,
  );
  writeReport(
    "v194-regression.md",
    `# V194 regression\n\n- **manifest:** \`${V194_MANIFEST.replace(process.cwd(), ".")}\`\n- **result:** ${v194Pass ? "PASS (unchanged)" : v194Detail}\n`,
  );
  writeReport(
    "blockers.md",
    fail === 0 ? "None.\n" : steps.filter((s) => !s.pass).map((s) => `- **${s.id}**: ${s.detail}`).join("\n") + "\n",
  );

  console.log(`[${TASK}] ${verdict} → ${OUT}`);
  for (const s of steps) console.log(`  ${s.pass ? "✓" : "✗"} ${s.id}: ${s.detail}`);
  if (fail > 0) process.exitCode = 1;
}

main();
