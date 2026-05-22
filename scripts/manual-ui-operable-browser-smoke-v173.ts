/**
 * MANUAL-UI-OPERABLE-BROWSER-SMOKE-V173
 * Post SCHEMA-RECONCILE-NEDA-DB-RENAME-UI-FIX-V173 — Returns packages/pallets + scanner.
 *
 * Usage:
 *   npx tsx scripts/manual-ui-operable-browser-smoke-v173.ts --run-id=20260519T140000Z
 *   npx tsx scripts/manual-ui-operable-browser-smoke-v173.ts --reuse-auth
 *   npx tsx scripts/manual-ui-operable-browser-smoke-v173.ts --manual-login --headed
 *
 * Requires: `npm run dev` on BASE_URL (default http://127.0.0.1:3000).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const V172_AUTH = path.resolve(
  process.cwd(),
  ".cursor/audit-reports/manual-ui-operable-browser-smoke-v172/auth-state.json",
);

type Check = {
  id: string;
  pass: boolean;
  detail: string;
  screenshot?: string;
};

const STALE_ERROR_PATTERNS = [
  /package_number does not exist/i,
  /photo_url does not exist/i,
  /column packages\.package_number/i,
  /column pallets\.photo_url/i,
];

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

async function waitForAuthenticated(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!page.url().includes("/login") && !page.url().includes("/auth/")) return true;
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
    ".cursor/audit-reports/manual-ui-operable-browser-smoke-v173",
    id,
  );
  const shotDir = path.join(outDir, "screenshots");
  fs.mkdirSync(shotDir, { recursive: true });

  const checks: Check[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  const ref = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "");
  checks.push({
    id: "01_env_staging_ref",
    pass: ref === STAGING_REF,
    detail: `NEXT_PUBLIC ref=${ref ?? "?"}`,
  });

  const authStatePath = path.join(outDir, "auth-state.json");
  const reuseAuth = hasFlag("--reuse-auth") && (fs.existsSync(authStatePath) || fs.existsSync(V172_AUTH));
  const authLoad = fs.existsSync(authStatePath) ? authStatePath : V172_AUTH;

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    browser = await chromium.launch({ headless: !headed });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: reuseAuth ? authLoad : undefined,
    });
    page = await context.newPage();

    if (reuseAuth) {
      await page.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }

    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    if (!reuseAuth) {
      await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const authed = await waitForAuthenticated(page, manualLogin ? 180_000 : 8_000);
      checks.push({
        id: "00_auth",
        pass: authed,
        detail: authed ? `Authenticated at ${page.url()}` : "Not signed in — use --reuse-auth or --manual-login --headed",
      });
      if (!authed) {
        await shot(page, shotDir, "00-login-timeout");
        finish(outDir, id, checks, consoleErrors, pageErrors, baseUrl);
        process.exit(1);
      }
      await context.storageState({ path: authStatePath });
    } else {
      checks.push({
        id: "00_auth",
        pass: true,
        detail: `Reused auth from ${path.basename(authLoad)}`,
      });
    }

    // ── Returns: Packages tab ─────────────────────────────────────────────
    await page.goto(`${baseUrl}/returns`, { waitUntil: "networkidle", timeout: 120_000 });
    await page.getByRole("heading", { name: /returns & logistics/i }).waitFor({ timeout: 60_000 }).catch(() => null);
    await page.waitForSelector('[role="tablist"]', { timeout: 30_000 });
    await page.getByRole("tab", { name: /packages/i }).click();
    await page.waitForTimeout(1_500);

    await page.waitForSelector("table tbody tr", { timeout: 45_000 }).catch(() => null);
    const packagesTabBody = await page.locator("body").innerText();
    const packagesTableVisible = (await page.locator("table tbody tr").count()) > 0;
    const packagesStaleInUi = STALE_ERROR_PATTERNS.some((re) => re.test(packagesTabBody));
    const packagesErrBanner = /packages:\s/i.test(packagesTabBody) && /error|failed/i.test(packagesTabBody);
    const runtimeOverlay = /Runtime TypeError|Cannot read properties of undefined/i.test(packagesTabBody);

    checks.push({
      id: "02_packages_tab_load",
      pass: packagesTableVisible && !packagesStaleInUi && !packagesErrBanner && !runtimeOverlay,
      detail: runtimeOverlay
        ? "Next.js runtime overlay on Packages tab"
        : packagesTableVisible
          ? `Packages table rows=${await page.locator("table tbody tr").count()}`
          : packagesErrBanner
            ? "Packages list error banner"
            : packagesStaleInUi
              ? "Stale column error in UI"
              : "No package rows",
      screenshot: await shot(page, shotDir, "02-packages-tab"),
    });

    // Package drawer
    let packageDrawerOk = false;
    if (packagesTableVisible) {
      await page.locator("table tbody tr").first().click();
      await page.waitForTimeout(1_200);
      const drawerText = await page.locator("body").innerText();
      packageDrawerOk =
        /package|tracking|carrier|expected|manifest|pallet/i.test(drawerText) &&
        !STALE_ERROR_PATTERNS.some((re) => re.test(drawerText));
      checks.push({
        id: "03_package_drawer",
        pass: packageDrawerOk,
        detail: packageDrawerOk ? "Package drawer opened" : "Package drawer not detected or stale column error",
        screenshot: await shot(page, shotDir, "03-package-drawer"),
      });
      await page.keyboard.press("Escape").catch(() => null);
      await page.waitForTimeout(400);
    } else {
      checks.push({
        id: "03_package_drawer",
        pass: false,
        detail: "Skipped — no package rows",
      });
    }

    // Create Package modal
    const newPkgBtn = page.getByRole("button", { name: /new package/i }).first();
    let createPackageModalOk = false;
    if (await newPkgBtn.count()) {
      await newPkgBtn.click();
      await page.getByRole("heading", { name: /create package/i }).waitFor({ timeout: 15_000 }).catch(() => null);
      const modalText = await page.locator("body").innerText();
      createPackageModalOk =
        modalText.includes("Create Package") &&
        !STALE_ERROR_PATTERNS.some((re) => re.test(modalText));
      checks.push({
        id: "04_create_package_modal",
        pass: createPackageModalOk,
        detail: createPackageModalOk ? "Create Package modal visible" : "Modal missing or schema error text",
        screenshot: await shot(page, shotDir, "04-create-package-modal"),
      });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(600);
      await page.getByRole("heading", { name: /create package/i }).waitFor({ state: "hidden", timeout: 5_000 }).catch(() => null);
    } else {
      checks.push({
        id: "04_create_package_modal",
        pass: false,
        detail: "New Package button not found",
      });
    }

    // ── Pallets tab (fresh navigation — Create Package modal may still be open) ──
    await page.goto(`${baseUrl}/returns`, { waitUntil: "networkidle", timeout: 120_000 });
    await page.getByRole("tab", { name: /pallets/i }).click();
    await page.waitForTimeout(1_500);

    await page.waitForSelector("table tbody tr", { timeout: 45_000 }).catch(() => null);
    const palletsTabBody = await page.locator("body").innerText();
    const palletsTableVisible = (await page.locator("table tbody tr").count()) > 0;
    const palletsStaleInUi = STALE_ERROR_PATTERNS.some((re) => re.test(palletsTabBody));
    const palletsErrBanner = /pallets:\s/i.test(palletsTabBody) && /error|failed/i.test(palletsTabBody);
    const palletsRuntimeOverlay = /Runtime TypeError|Cannot read properties of undefined/i.test(palletsTabBody);

    checks.push({
      id: "05_pallets_tab_load",
      pass: palletsTableVisible && !palletsStaleInUi && !palletsErrBanner && !palletsRuntimeOverlay,
      detail: palletsRuntimeOverlay
        ? "Next.js runtime overlay on Pallets tab"
        : palletsTableVisible
          ? `Pallets table rows=${await page.locator("table tbody tr").count()}`
          : palletsErrBanner
            ? "Pallets list error banner"
            : "No pallet rows",
      screenshot: await shot(page, shotDir, "05-pallets-tab"),
    });

    let palletDrawerOk = false;
    if (palletsTableVisible) {
      await page.locator("table tbody tr").first().click();
      await page.waitForTimeout(1_200);
      const pltDrawer = await page.locator("body").innerText();
      palletDrawerOk =
        /pallet|tracking|carrier|package/i.test(pltDrawer) &&
        !STALE_ERROR_PATTERNS.some((re) => re.test(pltDrawer));
      checks.push({
        id: "06_pallet_drawer",
        pass: palletDrawerOk,
        detail: palletDrawerOk ? "Pallet drawer opened" : "Pallet drawer not detected or stale column error",
        screenshot: await shot(page, shotDir, "06-pallet-drawer"),
      });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(600);
    } else {
      checks.push({
        id: "06_pallet_drawer",
        pass: false,
        detail: "Skipped — no pallet rows",
      });
    }

    await page.goto(`${baseUrl}/returns`, { waitUntil: "networkidle", timeout: 120_000 });
    await page.getByRole("tab", { name: /pallets/i }).click();
    await page.waitForTimeout(800);

    const newPltBtn = page.getByRole("button", { name: /new pallet/i }).first();
    let createPalletModalOk = false;
    if (await newPltBtn.count()) {
      await newPltBtn.click();
      await page.getByRole("heading", { name: /create pallet/i }).waitFor({ timeout: 15_000 }).catch(() => null);
      const pltModal = await page.locator("body").innerText();
      createPalletModalOk =
        pltModal.includes("Create Pallet") && !STALE_ERROR_PATTERNS.some((re) => re.test(pltModal));
      checks.push({
        id: "07_create_pallet_modal",
        pass: createPalletModalOk,
        detail: createPalletModalOk ? "Create Pallet modal visible" : "Modal missing or schema error text",
        screenshot: await shot(page, shotDir, "07-create-pallet-modal"),
      });
      await page.keyboard.press("Escape").catch(() => null);
    } else {
      checks.push({
        id: "07_create_pallet_modal",
        pass: false,
        detail: "New Pallet button not found",
      });
    }

    // ── Scanner ─────────────────────────────────────────────────────────────
    await page.goto(`${baseUrl}/scanner`, { waitUntil: "networkidle", timeout: 90_000 });
    const scannerText = await page.locator("body").innerText();
    const scannerOk =
      /tracking|scan/i.test(scannerText) &&
      !scannerText.toLowerCase().includes("enable supabase") &&
      !STALE_ERROR_PATTERNS.some((re) => re.test(scannerText));
    checks.push({
      id: "08_scanner_route",
      pass: scannerOk,
      detail: scannerOk ? "Scanner route loaded" : "Scanner missing expected UI or schema error",
      screenshot: await shot(page, shotDir, "08-scanner"),
    });

    const staleConsole = [...consoleErrors, ...pageErrors].filter((e) =>
      STALE_ERROR_PATTERNS.some((re) => re.test(e)),
    );
    checks.push({
      id: "09_no_stale_column_console",
      pass: staleConsole.length === 0,
      detail:
        staleConsole.length === 0
          ? `No package_number/photo_url errors in console (${consoleErrors.length} other console errors)`
          : `Stale schema errors: ${staleConsole.slice(0, 3).join(" | ")}`,
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

  const coreIds = new Set([
    "02_packages_tab_load",
    "05_pallets_tab_load",
    "08_scanner_route",
    "09_no_stale_column_console",
  ]);
  const coreChecks = checks.filter((c) => coreIds.has(c.id));
  const corePass = coreChecks.length > 0 && coreChecks.every((c) => c.pass);
  const allPass = checks.every((c) => c.pass);
  const status = allPass ? "PASS" : corePass ? "CONDITIONAL_PASS" : "FAIL";
  finish(outDir, id, checks, consoleErrors, pageErrors, baseUrl, status);
  console.log(JSON.stringify({ run_id: id, status, outDir }, null, 2));
  process.exit(corePass ? 0 : 1);
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

function finish(
  outDir: string,
  runId: string,
  checks: Check[],
  consoleErrors: string[],
  pageErrors: string[],
  baseUrl: string,
  status = "FAIL",
): void {
  const passN = checks.filter((c) => c.pass).length;
  const md = [
    `# Manual UI operable browser smoke v173`,
    ``,
    `**Run id:** \`${runId}\``,
    `**Status:** ${status} (${passN}/${checks.length} checks)`,
    `**Base URL:** ${baseUrl}`,
    `**Context:** Post SCHEMA-RECONCILE-NEDA-DB-RENAME-UI-FIX-V173 (\`package_code\`, \`pallet_photo_urls\`, etc.)`,
    ``,
    `## Checklist`,
    ``,
    `| # | Check | Result | Detail |`,
    `|---|--------|--------|--------|`,
    ...checks.map(
      (c) =>
        `| ${c.id} | ${c.id.replace(/^\d+_/, "")} | ${c.pass ? "PASS" : "FAIL"} | ${c.detail.replace(/\|/g, "\\|")} |`,
    ),
    ``,
    `## Screenshots`,
    ``,
    ...checks
      .filter((c) => c.screenshot)
      .map((c) => `- \`${c.screenshot}\` — ${c.id}`),
    ``,
    `## Console (stale column watch)`,
    ``,
    staleSection(consoleErrors, pageErrors),
    ``,
    `## Constraints`,
    ``,
    `- No production, migrations, \`package_items\`, claim submit, Amazon API, or OpenAI.`,
  ].join("\n");

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        run_id: runId,
        status,
        prompt: "MANUAL-UI-OPERABLE-BROWSER-SMOKE-V173-RETURNS-PACKAGES-PALLETS",
        baseUrl,
        checks,
        console_error_count: consoleErrors.length,
        page_error_count: pageErrors.length,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(outDir, "checklist.md"), md);

  const signoff = [
    `# Signoff — manual UI smoke v173`,
    ``,
    `**Run:** \`${runId}\` **Status:** ${status}`,
    ``,
    `Packages/pallets/scanner surfaces exercised after canonical column reconcile.`,
    status === "PASS"
      ? `Ready for operator spot-check only if desired.`
      : `Review failing checks and screenshots before merge.`,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "signoff.md"), signoff);
}

function staleSection(consoleErrors: string[], pageErrors: string[]): string {
  const stale = [...consoleErrors, ...pageErrors].filter((e) =>
    /package_number|photo_url does not exist/i.test(e),
  );
  if (stale.length === 0) {
    return "No `package_number` / `pallets.photo_url` errors captured.";
  }
  return stale.map((e) => `- ${e}`).join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
