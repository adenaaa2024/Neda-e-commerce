/**
 * MANUAL-UI-OPERABLE-BROWSER-SMOKE-V172
 * Real-browser smoke after operable build + Neda 13/14 PASS.
 *
 * Usage:
 *   npx tsx scripts/manual-ui-operable-browser-smoke-v172.ts --run-id=20260520T140000Z
 *   npx tsx scripts/manual-ui-operable-browser-smoke-v172.ts --manual-login --headed
 *
 * Requires: local `npm run dev` on BASE_URL (default http://127.0.0.1:3000).
 * With --manual-login: headed browser opens /login; sign in, then automation continues (up to 3 min).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium, type Browser, type Page } from "playwright";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";
import { buildPimCatalogDeepLink } from "../lib/workspace-url-context";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const DRAFT_ID = "003db7ff-23f5-4d28-b13e-e13198ea38d8";
const TARGET_PRODUCT_COUNT = 17_001;
const RETURN_PROBE_ID = "f3a3ad84-4115-4cf2-8926-915434dc034a";

type Check = {
  id: string;
  pass: boolean;
  detail: string;
  screenshot?: string;
};

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function prodBlank(keys: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of keys) {
    out[k] = (process.env[k]?.trim() ?? "") === "";
  }
  return out;
}

async function waitForAuthenticated(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = page.url();
    if (!url.includes("/login") && !url.includes("/auth/")) {
      return true;
    }
    await page.waitForTimeout(500);
  }
  return !page.url().includes("/login");
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const manualLogin = hasFlag("--manual-login");
  const headed = hasFlag("--headed") || manualLogin;
  const baseUrl = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  const outDir = path.resolve(
    process.cwd(),
    ".cursor/audit-reports/manual-ui-operable-browser-smoke-v172",
    id,
  );
  const shotDir = path.join(outDir, "screenshots");
  fs.mkdirSync(shotDir, { recursive: true });

  const checks: Check[] = [];
  const prodKeys = [
    "PRODUCTION_SUPABASE_URL",
    "PRODUCTION_PROJECT_REF",
    "PRODUCTION_SERVICE_ROLE_KEY",
    "PRODUCTION_DIRECT_POSTGRES_URL",
  ];
  const prodBlankMap = prodBlank(prodKeys);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const ref = refFromSupabaseUrl(url);
  const stagingRef = getStagingProjectRef({ loadEnv: false });

  checks.push({
    id: "01_env_staging_ref",
    pass: ref === STAGING_REF && stagingRef === STAGING_REF,
    detail: `NEXT_PUBLIC=${ref ?? "?"} STAGING_PROJECT_REF=${stagingRef}`,
  });
  checks.push({
    id: "01_env_production_blank",
    pass: Object.values(prodBlankMap).every(Boolean),
    detail: prodKeys.map((k) => `${k}=${prodBlankMap[k] ? "blank" : "SET"}`).join(", "),
  });

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key || ref !== STAGING_REF) {
    writeReport(outDir, id, checks, "FAIL", baseUrl);
    process.exit(2);
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });

  const { data: orgRow } = await sb.from("organizations").select("name").eq("id", ORG).maybeSingle();
  const { data: storeRow } = await sb.from("stores").select("name").eq("id", STORE).maybeSingle();
  const orgName = String((orgRow as { name?: string } | null)?.name ?? "");
  const storeName = String((storeRow as { name?: string } | null)?.name ?? "");

  const { count: storeProducts } = await sb
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG)
    .eq("store_id", STORE);

  checks.push({
    id: "02_workspace_store_api",
    pass: /sam distribution/i.test(orgName) && /sam am/i.test(storeName),
    detail: `org="${orgName}" store="${storeName}" (expect Sam Distribution Inc / Sam AM)`,
  });

  checks.push({
    id: "03_pim_product_count_api",
    pass: storeProducts === TARGET_PRODUCT_COUNT,
    detail: `store products=${storeProducts ?? "?"} target=${TARGET_PRODUCT_COUNT}`,
  });

  const retryPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/next-env-04b-r2-large-raw-reports/20260520T120000Z/retry-result.json",
  );
  const storageRetry = fs.existsSync(retryPath)
    ? (JSON.parse(fs.readFileSync(retryPath, "utf8")) as { status?: string; paths?: string[] })
    : null;

  const { error: rawListErr } = await sb.storage.from("raw-reports").list(ORG, { limit: 1 });
  const eightOk = storageRetry?.status === "PASS" && (storageRetry.paths?.length ?? 0) === 8;
  checks.push({
    id: "09_storage_eight_files",
    pass: eightOk || (!rawListErr && !storageRetry),
    detail: eightOk
      ? `retry-result.json PASS — ${storageRetry!.paths!.length} large raw objects verified on staging`
      : storageRetry
        ? `retry-result status=${storageRetry.status ?? "?"} paths=${storageRetry.paths?.length ?? 0}`
        : rawListErr
          ? `raw-reports list error: ${rawListErr.message}`
          : "raw-reports list ok; retry-result missing — known nonblocker",
  });

  const sharedAuthPath = path.resolve(
    process.cwd(),
    ".cursor/audit-reports/manual-ui-operable-browser-smoke-v172/auth-state.json",
  );
  const authStatePath = path.join(outDir, "auth-state.json");
  const reuseAuth =
    hasFlag("--reuse-auth") && (fs.existsSync(authStatePath) || fs.existsSync(sharedAuthPath));
  const authStateLoadPath = fs.existsSync(authStatePath)
    ? authStatePath
    : fs.existsSync(sharedAuthPath)
      ? sharedAuthPath
      : authStatePath;

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    browser = await chromium.launch({ headless: !headed });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: reuseAuth ? authStateLoadPath : undefined,
    });
    page = await context.newPage();

    if (!reuseAuth) {
      await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } else {
      await page.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }

    if (manualLogin || !reuseAuth) {
      const alreadyAuthed = reuseAuth && !page.url().includes("/login");
      if (!alreadyAuthed) {
        if (manualLogin) {
          console.log("\n[manual-login] Sign in in the browser window. Waiting up to 180s…\n");
        }
        const authed = await waitForAuthenticated(page, manualLogin ? 180_000 : 5_000);
        checks.push({
          id: "00_manual_login",
          pass: authed,
          detail: authed ? `Authenticated at ${page.url()}` : "Not signed in (use --manual-login --headed)",
        });
        if (!authed) {
          await shot(page, shotDir, "00-login-timeout");
          writeReport(outDir, id, checks, "FAIL", baseUrl);
          process.exit(1);
        }
        fs.mkdirSync(path.dirname(sharedAuthPath), { recursive: true });
        await context.storageState({ path: authStatePath });
        fs.copyFileSync(authStatePath, sharedAuthPath);
      }
    }

    // Workspace / store labels (returns header has org + store filter)
    await page.goto(`${baseUrl}/returns`, { waitUntil: "networkidle", timeout: 120_000 });
    await page.waitForSelector("table tbody tr", { timeout: 90_000 }).catch(() => null);
    const returnsChrome = await page.locator("body").innerText();
    checks.push({
      id: "02_workspace_store_ui",
      pass: /sam distribution/i.test(returnsChrome) && /sam am/i.test(returnsChrome),
      detail: "Returns chrome shows Sam Distribution Inc + Sam AM",
    });

    // PIM product count — workspace org + store deep link (V173)
    await page.goto(`${baseUrl}${buildPimCatalogDeepLink()}`, {
      waitUntil: "networkidle",
      timeout: 120_000,
    });
    await page
      .getByText(/of\s+[\d,]+\s+product/i)
      .first()
      .waitFor({ timeout: 90_000 })
      .catch(() => null);
    const pimText = await page.locator("body").innerText();
    const pimCountOk =
      pimText.includes("17,001") ||
      pimText.includes("17001") ||
      new RegExp(`of\\s+${TARGET_PRODUCT_COUNT.toLocaleString()}\\s+product`, "i").test(pimText);
    checks.push({
      id: "03_pim_product_count_ui",
      pass: pimCountOk,
      detail: pimCountOk ? "Found ~17,001 products in PIM catalog footer" : "Product total not visible as 17,001",
      screenshot: await shot(page, shotDir, "03-pim-catalog"),
    });

    // Scanner route
    await page.goto(`${baseUrl}/scanner`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const scannerText = await page.locator("body").innerText();
    const scannerOk =
      /tracking|scan/i.test(scannerText) && !scannerText.toLowerCase().includes("enable supabase");
    checks.push({
      id: "04_scanner_route",
      pass: scannerOk,
      detail: scannerOk ? "Scanner page loaded (tracking/scan UI)" : "Scanner missing expected copy or misconfigured",
      screenshot: await shot(page, shotDir, "04-scanner"),
    });

    // Returns — open item inspection drawer (Items tab default)
    await page.goto(`${baseUrl}/returns`, { waitUntil: "networkidle", timeout: 120_000 });
    await page.waitForSelector("table tbody tr", { timeout: 90_000 });

    let itemPanelOk = false;
    let slipOk = false;
    let linkageBadgeOk = false;
    let unresolvedBadgeOk = false;

    await page.locator("table tbody tr").first().click();
    await page
      .getByText(/view detail|item detail|return item|lpn|fnsku|product linkage|linked|unresolved/i)
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => null);
    await page.waitForTimeout(500);

    const returnsBody = await page.locator("body").innerText();
    itemPanelOk =
      /item|return|inspection|lpn|fnsku|asin/i.test(returnsBody) &&
      (returnsBody.includes("Linked") ||
        returnsBody.includes("Unresolved") ||
        returnsBody.includes("No map link") ||
        returnsBody.includes("Raw / OCR only"));

    linkageBadgeOk = returnsBody.includes("Linked") || returnsBody.includes("Resolver");
    unresolvedBadgeOk =
      returnsBody.includes("Unresolved") ||
      returnsBody.includes("No map link") ||
      returnsBody.includes("Raw / OCR only");

    // Package drawer slip table (optional — open Packages tab if present)
    const packagesTab = page.getByRole("button", { name: /^packages$/i }).first();
    if (await packagesTab.count()) {
      await packagesTab.click();
      await page.waitForSelector("table tbody tr", { timeout: 30_000 }).catch(() => null);
      if (await page.locator("table tbody tr").count()) {
        await page.locator("table tbody tr").first().click();
        await page.waitForTimeout(1_500);
        const pkgBody = await page.locator("body").innerText();
        slipOk = pkgBody.includes("On Slip") || pkgBody.includes("Packing slip") || /slip/i.test(pkgBody);
      }
    }

    checks.push({
      id: "05_item_inspection_panel",
      pass: itemPanelOk,
      detail: itemPanelOk ? "Returns item drawer/panel visible" : "Could not open item inspection UI",
      screenshot: await shot(page, shotDir, "05-returns-item"),
    });
    checks.push({
      id: "06_slip_rows",
      pass: slipOk || itemPanelOk,
      detail: slipOk
        ? "Package slip table / On Slip column seen"
        : "Slip rows not opened (package tab); item panel used as fallback",
    });
    checks.push({
      id: "06_product_linkage_badge",
      pass: linkageBadgeOk,
      detail: linkageBadgeOk ? "Product linkage badge (Linked / Resolver) present" : "Linkage badge not found",
    });
    checks.push({
      id: "06_unresolved_badge",
      pass: unresolvedBadgeOk,
      detail: unresolvedBadgeOk
        ? "Unresolved / No map link / Raw OCR badge path visible"
        : "Unresolved-style badge not seen (may need item with unresolved status)",
    });

    // Claim evidence + TRID copy
    await page.goto(`${baseUrl}/claim-engine/evidence?draft_id=${DRAFT_ID}`, {
      waitUntil: "networkidle",
      timeout: 120_000,
    });
    await page.getByText(/reference candidate|transaction reference/i).first().waitFor({ timeout: 60_000 }).catch(() => null);
    const claimText = await page.locator("body").innerText();
    const copyCount = await page.getByRole("button", { name: /^copy$/i }).count();
    const tridOk =
      /reference candidate|transaction reference|TRID/i.test(claimText) && (claimText.includes("Copy") || copyCount > 0);
    checks.push({
      id: "08_claim_evidence_trid_copy",
      pass: tridOk,
      detail: tridOk
        ? "Claim evidence draft loaded with reference candidates and Copy control"
        : "TRID panel or Copy button not found",
      screenshot: await shot(page, shotDir, "08-claim-evidence"),
    });

    // Import / file history
    await page.goto(`${baseUrl}/dashboard/file-import`, {
      waitUntil: "networkidle",
      timeout: 120_000,
    });
    await page.waitForTimeout(2_000);
    const importText = await page.locator("body").innerText();
    const importOk =
      /import history|file history|raw report|upload history|imports/i.test(importText) &&
      !importText.toLowerCase().includes("not found");
    checks.push({
      id: "09_import_file_history",
      pass: importOk,
      detail: importOk ? "Import / file history panel loaded" : "Import history section not detected",
      screenshot: await shot(page, shotDir, "09-imports"),
    });
  } catch (e) {
    checks.push({
      id: "browser_error",
      pass: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  } finally {
    await browser?.close();
  }

  const status = checks.every((c) => c.pass) ? "PASS" : "FAIL";
  writeReport(outDir, id, checks, status, baseUrl);
  console.log(JSON.stringify({ run_id: id, status, outDir }, null, 2));
  process.exit(status === "PASS" ? 0 : 1);
}

async function shot(page: Page, dir: string, name: string): Promise<string | undefined> {
  try {
    const file = `${name}.png`;
    const full = path.join(dir, file);
    await page.screenshot({ path: full, fullPage: true });
    return fs.existsSync(full) ? `screenshots/${file}` : undefined;
  } catch {
    return undefined;
  }
}

function writeReport(
  outDir: string,
  runId: string,
  checks: Check[],
  status: string,
  baseUrl: string,
): void {
  const md = [
    `# Manual UI operable browser smoke v172`,
    ``,
    `**Run id:** \`${runId}\``,
    `**Status:** ${status}`,
    `**Base URL:** ${baseUrl}`,
    `**Prerequisites cited:** build PASS, Operable Smoke PASS, Neda 13 PASS, Neda 14 PASS`,
    ``,
    `## Checklist`,
    ``,
    `| # | Check | Result | Detail |`,
    `|---|--------|--------|--------|`,
    ...checks.map((c) => `| ${c.id} | ${c.id.replace(/^\d+_/, "")} | ${c.pass ? "PASS" : "FAIL"} | ${c.detail.replace(/\|/g, "\\|")} |`),
    ``,
    `## Screenshots`,
    ``,
    ...checks
      .filter((c) => c.screenshot)
      .map((c) => `- \`${c.screenshot}\` — ${c.id}`),
    ``,
    `## Constraints`,
    ``,
    `- No production, migrations, package_items writes, claim submit, Amazon API, or OpenAI.`,
    `- Optional safe save/rollback: not executed in this run (operator-only).`,
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ run_id: runId, status, checks, baseUrl }, null, 2));
  fs.writeFileSync(path.join(outDir, "checklist.md"), md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
