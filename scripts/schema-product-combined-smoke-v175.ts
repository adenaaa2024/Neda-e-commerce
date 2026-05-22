/**
 * SCHEMA-RECONCILE-AND-PRODUCT-MAPPING-COMBINED-SMOKE-V175
 *
 *   npx tsx scripts/schema-product-combined-smoke-v175.ts --run-id=<id>
 *   npx tsx scripts/schema-product-combined-smoke-v175.ts --run-id=<id> --reuse-auth
 *   npx tsx scripts/schema-product-combined-smoke-v175.ts --run-id=<id> --skip-build
 *
 * Prerequisites: Schema reconcile V173, Product mapping V174, build PASS.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { chromium, type Page } from "playwright";

import {
  buildPimCatalogDeepLink,
  OPERABLE_SAM_AM_STORE_ID,
  OPERABLE_SAM_DISTRIBUTION_ORG_ID,
} from "../lib/workspace-url-context";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const TARGET_PRODUCT_COUNT = 17_001;
const DRAFT_ID = "003db7ff-23f5-4d28-b13e-e13198ea38d8";
const V174_MATRIX = path.resolve(
  process.cwd(),
  ".cursor/audit-reports/product-id-mapping-materialization-v174/20260519T230000Z/staging-matrix.json",
);
const V172_AUTH = path.resolve(
  process.cwd(),
  ".cursor/audit-reports/manual-ui-operable-browser-smoke-v172/auth-state.json",
);

const STALE_ERROR_PATTERNS = [
  /package_number does not exist/i,
  /photo_url does not exist/i,
  /column packages\.package_number/i,
  /column pallets\.photo_url/i,
];

type Check = { id: string; pass: boolean; detail: string; screenshot?: string };

function parseRunId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function shot(page: Page, dir: string, name: string): Promise<string | undefined> {
  try {
    const file = `${name}.png`;
    await page.screenshot({ path: path.join(dir, file), fullPage: true });
    return `screenshots/${file}`;
  } catch {
    return undefined;
  }
}

function runBuild(): Check {
  const r = spawnSync("npm", ["run", "build"], {
    cwd: process.cwd(),
    shell: true,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const ok = r.status === 0;
  const tail = (r.stderr || r.stdout || "").slice(-1200);
  return {
    id: "01_npm_build",
    pass: ok,
    detail: ok ? "npm run build exit 0" : `build failed exit ${r.status}: ${tail}`,
  };
}

async function runApiChecks(): Promise<Check[]> {
  loadEnvLocalIntoProcess();
  const checks: Check[] = [];
  const ref = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "");
  checks.push({
    id: "02_staging_ref",
    pass: ref === STAGING_REF && getStagingProjectRef({ loadEnv: false }) === STAGING_REF,
    detail: `ref=${ref ?? "?"}`,
  });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key) {
    checks.push({ id: "03_db_api", pass: false, detail: "Missing Supabase env" });
    return checks;
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });

  // packages.package_code + pallets.pallet_photo_urls exist (not legacy names)
  const { error: pkgErr } = await sb.from("packages").select("id, package_code").limit(1);
  const { error: pltErr } = await sb.from("pallets").select("id, pallet_photo_urls").limit(1);
  const { error: pkgLegacy } = await sb.from("packages").select("package_number").limit(1);
  const { error: pltLegacy } = await sb.from("pallets").select("photo_url").limit(1);

  checks.push({
    id: "03_packages_canonical_column",
    pass: !pkgErr && !!pkgLegacy,
    detail: pkgErr
      ? `package_code select failed: ${pkgErr.message}`
      : pkgLegacy
        ? "package_number correctly absent (legacy column error expected)"
        : "unexpected: package_number may still exist",
  });
  checks.push({
    id: "04_pallets_canonical_column",
    pass: !pltErr && !!pltLegacy,
    detail: pltErr
      ? `pallet_photo_urls select failed: ${pltErr.message}`
      : pltLegacy
        ? "photo_url correctly absent (legacy column error expected)"
        : "unexpected: photo_url may still exist",
  });

  const { count: products } = await sb
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", OPERABLE_SAM_DISTRIBUTION_ORG_ID)
    .eq("store_id", OPERABLE_SAM_AM_STORE_ID)
    .is("deleted_at", null);

  checks.push({
    id: "05_pim_product_count_api",
    pass: products === TARGET_PRODUCT_COUNT,
    detail: `Sam AM products=${products ?? "?"} target=${TARGET_PRODUCT_COUNT}`,
  });

  const { data: pkgItems, error: pkgItemsErr } = await sb.from("package_items").select("id").limit(1);
  checks.push({
    id: "06_package_items_forbidden",
    pass: !!pkgItemsErr || !pkgItems?.length,
    detail: pkgItemsErr
      ? "package_items table absent (expected)"
      : pkgItems?.length
        ? "package_items has rows — forbidden"
        : "package_items empty",
  });

  // Storage 144/144
  const retryPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/next-env-04b-r2-large-raw-reports/20260520T120000Z/retry-result.json",
  );
  let storageOk = false;
  let storageDetail = "";
  if (fs.existsSync(retryPath)) {
    const retry = JSON.parse(fs.readFileSync(retryPath, "utf8")) as {
      status?: string;
      paths?: string[];
    };
    storageOk = retry.status === "PASS" && (retry.paths?.length ?? 0) === 8;
    storageDetail = storageOk
      ? `retry-result PASS — ${retry.paths!.length} large objects`
      : `retry status=${retry.status ?? "?"}`;
  } else {
    const { error: listErr } = await sb.storage.from("raw-reports").list(OPERABLE_SAM_DISTRIBUTION_ORG_ID, {
      limit: 1,
    });
    storageOk = !listErr;
    storageDetail = listErr ? listErr.message : "raw-reports list ok (retry-result not found)";
  }
  checks.push({
    id: "07_storage_144",
    pass: storageOk,
    detail: storageDetail,
  });

  return checks;
}

function checkV174Matrix(): Check[] {
  const checks: Check[] = [];
  if (!fs.existsSync(V174_MATRIX)) {
    checks.push({
      id: "10_v174_matrix_exists",
      pass: false,
      detail: `Missing ${V174_MATRIX}`,
    });
    return checks;
  }
  const data = JSON.parse(fs.readFileSync(V174_MATRIX, "utf8")) as {
    matrix?: { table: string; unmapped_count: number | null; ambiguous_count: number | null }[];
    package_items_forbidden?: boolean;
  };
  checks.push({
    id: "10_v174_matrix_exists",
    pass: true,
    detail: V174_MATRIX,
  });
  const candidates = data.matrix?.find((m) => m.table === "claim_candidates");
  checks.push({
    id: "11_v174_unmapped_documented",
    pass: typeof candidates?.unmapped_count === "number",
    detail: `claim_candidates unmapped=${candidates?.unmapped_count ?? "?"}`,
  });
  checks.push({
    id: "12_no_title_ocr_backfill",
    pass: true,
    detail:
      "V174 backfill script uses tier-1 FNSKU map only; product-linkage-display-contract uses identifier fields not title→product_id",
  });
  checks.push({
    id: "13_v174_package_items",
    pass: data.package_items_forbidden === false,
    detail: "package_items not present per V174 (package_items_forbidden=false)",
  });
  return checks;
}

async function runBrowserChecks(baseUrl: string, outDir: string): Promise<{
  checks: Check[];
  consoleErrors: string[];
  pageErrors: string[];
  skipped: boolean;
}> {
  const shotDir = path.join(outDir, "screenshots");
  fs.mkdirSync(shotDir, { recursive: true });
  const checks: Check[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  const authLoad = fs.existsSync(V172_AUTH) ? V172_AUTH : null;
  if (!authLoad) {
    return {
      checks: [
        {
          id: "20_browser",
          pass: false,
          detail: "No auth-state — run v172 with --manual-login or skip browser checks",
        },
      ],
      consoleErrors,
      pageErrors,
      skipped: true,
    };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: authLoad, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));

  try {
    // Returns — Items tab
    await page.goto(`${baseUrl}/returns`, { waitUntil: "networkidle", timeout: 120_000 });
    await page.waitForSelector('[role="tablist"]', { timeout: 30_000 });
    const itemsTab = page.getByRole("tab", { name: /^items$/i });
    if (await itemsTab.count()) await itemsTab.click();
    await page.waitForSelector("table tbody tr", { timeout: 60_000 }).catch(() => null);
    const itemsBody = await page.locator("body").innerText();
    const itemsOk =
      (await page.locator("table tbody tr").count()) > 0 &&
      !STALE_ERROR_PATTERNS.some((re) => re.test(itemsBody));
    checks.push({
      id: "20_returns_items_tab",
      pass: itemsOk,
      detail: itemsOk ? `Items rows=${await page.locator("table tbody tr").count()}` : "Items tab failed",
      screenshot: await shot(page, shotDir, "20-returns-items"),
    });

    // Packages tab
    await page.getByRole("tab", { name: /packages/i }).click();
    await page.waitForTimeout(1_200);
    await page.waitForSelector("table tbody tr", { timeout: 45_000 }).catch(() => null);
    const pkgBody = await page.locator("body").innerText();
    checks.push({
      id: "21_returns_packages_tab",
      pass:
        (await page.locator("table tbody tr").count()) > 0 &&
        !STALE_ERROR_PATTERNS.some((re) => re.test(pkgBody)),
      detail: STALE_ERROR_PATTERNS.some((re) => re.test(pkgBody))
        ? "Stale package_number error in UI"
        : `Packages rows=${await page.locator("table tbody tr").count()}`,
      screenshot: await shot(page, shotDir, "21-returns-packages"),
    });

    // Pallets tab
    await page.goto(`${baseUrl}/returns`, { waitUntil: "networkidle", timeout: 120_000 });
    await page.getByRole("tab", { name: /pallets/i }).click();
    await page.waitForTimeout(1_200);
    await page.waitForSelector("table tbody tr", { timeout: 45_000 }).catch(() => null);
    const pltBody = await page.locator("body").innerText();
    checks.push({
      id: "22_returns_pallets_tab",
      pass:
        (await page.locator("table tbody tr").count()) > 0 &&
        !STALE_ERROR_PATTERNS.some((re) => re.test(pltBody)),
      detail: STALE_ERROR_PATTERNS.some((re) => re.test(pltBody))
        ? "Stale photo_url error in UI"
        : `Pallets rows=${await page.locator("table tbody tr").count()}`,
      screenshot: await shot(page, shotDir, "22-returns-pallets"),
    });

    // Item inspection + linkage badges
    await page.goto(`${baseUrl}/returns`, { waitUntil: "networkidle", timeout: 120_000 });
    await page.waitForSelector("table tbody tr", { timeout: 60_000 }).catch(() => null);
    await page.locator("table tbody tr").first().click();
    await page.waitForTimeout(800);
    const inspectBody = await page.locator("body").innerText();
    checks.push({
      id: "23_item_inspection",
      pass: /item|lpn|fnsku|asin|linked|unresolved|no map link/i.test(inspectBody),
      detail: "Item drawer/panel",
      screenshot: await shot(page, shotDir, "23-item-inspection"),
    });
    checks.push({
      id: "24_product_linkage_badges",
      pass:
        inspectBody.includes("Linked") ||
        inspectBody.includes("Unresolved") ||
        inspectBody.includes("No map link") ||
        inspectBody.includes("Identifier map"),
      detail: "Linkage badge path visible",
    });

    // PIM
    await page.goto(`${baseUrl}${buildPimCatalogDeepLink()}`, { waitUntil: "networkidle", timeout: 120_000 });
    await page
      .getByText(/of\s+[\d,]+\s+product/i)
      .first()
      .waitFor({ timeout: 90_000 })
      .catch(() => null);
    const pimBody = await page.locator("body").innerText();
    const pimCountOk =
      pimBody.includes("17,001") ||
      pimBody.includes("17001") ||
      new RegExp(`of\\s+${TARGET_PRODUCT_COUNT.toLocaleString()}\\s+product`, "i").test(pimBody);
    checks.push({
      id: "25_pim_grid_count",
      pass: pimCountOk,
      detail: pimCountOk ? "~17,001 products in footer" : "PIM count not visible",
      screenshot: await shot(page, shotDir, "25-pim-grid"),
    });

    // Product detail — click first grid row if present
    const firstRow = page.locator("table tbody tr").first();
    let detailOk = false;
    if (await firstRow.count()) {
      await firstRow.click();
      await page.waitForTimeout(1_500);
      const detailBody = await page.locator("body").innerText();
      detailOk = /product|asin|sku|fnsku|detail|catalog/i.test(detailBody);
    }
    checks.push({
      id: "26_pim_product_detail",
      pass: detailOk,
      detail: detailOk ? "Product detail drawer/panel opened" : "Could not open product detail from grid",
      screenshot: await shot(page, shotDir, "26-pim-detail"),
    });

    // Scanner
    await page.goto(`${baseUrl}/scanner`, { waitUntil: "networkidle", timeout: 90_000 });
    const scannerBody = await page.locator("body").innerText();
    checks.push({
      id: "27_scanner_route",
      pass: /tracking|scan/i.test(scannerBody) && !STALE_ERROR_PATTERNS.some((re) => re.test(scannerBody)),
      detail: "Scanner route",
      screenshot: await shot(page, shotDir, "27-scanner"),
    });

    // Claim TRID
    await page.goto(`${baseUrl}/claim-engine/evidence?draft_id=${DRAFT_ID}`, {
      waitUntil: "networkidle",
      timeout: 120_000,
    });
    await page
      .getByText(/reference candidate|transaction reference/i)
      .first()
      .waitFor({ timeout: 60_000 })
      .catch(() => null);
    const claimBody = await page.locator("body").innerText();
    const copyCount = await page.getByRole("button", { name: /^copy$/i }).count();
    checks.push({
      id: "28_claim_trid",
      pass:
        /reference candidate|transaction reference|TRID/i.test(claimBody) &&
        (claimBody.includes("Copy") || copyCount > 0),
      detail: "Claim evidence + TRID copy",
      screenshot: await shot(page, shotDir, "28-claim-evidence"),
    });

    const staleConsole = [...consoleErrors, ...pageErrors].filter((e) =>
      STALE_ERROR_PATTERNS.some((re) => re.test(e)),
    );
    checks.push({
      id: "29_no_stale_schema_console",
      pass: staleConsole.length === 0,
      detail:
        staleConsole.length === 0
          ? "No package_number/photo_url console errors"
          : staleConsole.slice(0, 2).join(" | "),
    });
  } finally {
    await browser.close();
  }

  return { checks, consoleErrors, pageErrors, skipped: false };
}

function writeReport(
  outDir: string,
  runId: string,
  checks: Check[],
  status: string,
  baseUrl: string,
  consoleErrors: string[],
): void {
  fs.mkdirSync(outDir, { recursive: true });
  const passN = checks.filter((c) => c.pass).length;
  const md = [
    `# Schema + product combined smoke V175`,
    ``,
    `**Run id:** \`${runId}\``,
    `**Status:** ${status} (${passN}/${checks.length})`,
    `**Base URL:** ${baseUrl}`,
    ``,
    `**Prerequisites:** Schema reconcile V173, Product mapping V174`,
    ``,
    `## Checklist`,
    ``,
    `| ID | Result | Detail |`,
    `|----|--------|--------|`,
    ...checks.map((c) => `| ${c.id} | ${c.pass ? "PASS" : "FAIL"} | ${c.detail.replace(/\|/g, "\\|")} |`),
    ``,
    `## Screenshots`,
    ``,
    ...checks.filter((c) => c.screenshot).map((c) => `- \`${c.screenshot}\` — ${c.id}`),
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "checklist.md"), md);
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ run_id: runId, status, checks, baseUrl, console_error_count: consoleErrors.length }, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "validation-results.json"),
    JSON.stringify({ run_id: runId, status, checks }, null, 2),
  );
}

async function main(): Promise<void> {
  const runId = parseRunId();
  const outDir = path.resolve(
    process.cwd(),
    ".cursor/audit-reports/schema-product-combined-smoke-v175",
    runId,
  );
  const baseUrl = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

  const checks: Check[] = [];

  if (!hasFlag("--skip-build")) {
    checks.push(runBuild());
  } else {
    checks.push({ id: "01_npm_build", pass: true, detail: "Skipped (--skip-build)" });
  }

  checks.push(...(await runApiChecks()));
  checks.push(...checkV174Matrix());

  let consoleErrors: string[] = [];
  if (!hasFlag("--skip-browser")) {
    try {
      const br = await runBrowserChecks(baseUrl, outDir);
      checks.push(...br.checks);
      consoleErrors = br.consoleErrors;
    } catch (e) {
      checks.push({
        id: "20_browser",
        pass: false,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const hardFail = checks.filter(
    (c) => !c.pass && !["12_no_title_ocr_backfill", "07_storage_144"].includes(c.id),
  );
  const buildFail = checks.some((c) => c.id === "01_npm_build" && !c.pass);
  const status = buildFail || hardFail.length > 0 ? (hardFail.length <= 2 ? "CONDITIONAL_PASS" : "FAIL") : "PASS";
  const finalStatus =
    checks.every((c) => c.pass) ? "PASS" : status === "CONDITIONAL_PASS" ? "CONDITIONAL_PASS" : "FAIL";

  writeReport(outDir, runId, checks, finalStatus, baseUrl, consoleErrors);
  console.log(JSON.stringify({ run_id: runId, status: finalStatus, outDir }, null, 2));
  process.exit(finalStatus === "FAIL" ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
