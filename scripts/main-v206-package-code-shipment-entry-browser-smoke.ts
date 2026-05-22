/**
 * MAIN V206 — Browser smoke: package # via Returns → Packages tab (staging).
 *
 *   npx tsx scripts/main-v206-package-code-shipment-entry-browser-smoke.ts --headed --reuse-auth
 *   npx tsx scripts/main-v206-package-code-shipment-entry-browser-smoke.ts --manual-login --headed
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { chromium, type Page } from "playwright";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/main-v206-package-code-inventory-views-original-parity-apply";
const V172_AUTH = path.resolve(
  process.cwd(),
  ".cursor/audit-reports/manual-ui-operable-browser-smoke-v172/auth-state.json",
);
const V173_AUTH = path.resolve(process.cwd(), ".cursor/audit-reports/manual-ui-operable-browser-smoke-v173");

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
    await page.waitForTimeout(400);
  }
  return !page.url().includes("/login");
}

let cachedLoginEmail: string | null | undefined;

function buildSupabaseAuthCookies(
  baseUrl: string,
  ref: string,
  session: {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
    expires_at?: number;
    token_type?: string;
    user: Record<string, unknown> | { id: string; email?: string };
  },
): { name: string; value: string; domain: string; path: string }[] {
  const host = new URL(baseUrl).hostname;
  const storageValue = JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in ?? 3600,
    expires_at: session.expires_at ?? Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600),
    token_type: session.token_type ?? "bearer",
    user: session.user,
  });
  const cookieName = `sb-${ref}-auth-token`;
  return [
    { name: cookieName, value: storageValue, domain: host, path: "/" },
    { name: `${cookieName}.0`, value: storageValue.slice(0, 3180), domain: host, path: "/" },
    ...(storageValue.length > 3180
      ? [{ name: `${cookieName}.1`, value: storageValue.slice(3180), domain: host, path: "/" }]
      : []),
  ];
}

async function resolveLoginEmail(): Promise<string | null> {
  if (cachedLoginEmail !== undefined) return cachedLoginEmail;
  const fromEnv =
    process.env.PLAYWRIGHT_LOGIN_EMAIL?.trim() || process.env.SMOKE_LOGIN_EMAIL?.trim() || "";
  if (fromEnv) {
    cachedLoginEmail = fromEnv;
    return fromEnv;
  }
  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (url && key) {
    const admin = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await admin.auth.admin.listUsers({ perPage: 1 });
    if (!error && data.users[0]?.email) {
      cachedLoginEmail = data.users[0].email.trim();
      return cachedLoginEmail;
    }
  }
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) {
    cachedLoginEmail = null;
    return null;
  }
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  const r = await client.query(
    `SELECT email FROM auth.users WHERE email IS NOT NULL AND email <> '' ORDER BY created_at DESC LIMIT 1`,
  );
  await client.end();
  cachedLoginEmail = (r.rows[0]?.email as string | undefined)?.trim() || null;
  return cachedLoginEmail;
}

async function browserLoginViaMagicLink(page: Page, baseUrl: string): Promise<boolean> {
  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const email = await resolveLoginEmail();
  const ref = refFromSupabaseUrl(url);
  if (!url || !anon || !serviceKey || !email || !ref) {
    console.warn("[v206] magic link preconditions missing");
    return false;
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${baseUrl}/returns` },
  });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) {
    console.warn("[v206] generateLink failed:", error?.message ?? "no hashed_token");
    return false;
  }

  const anonClient = createClient(url, anon, { auth: { persistSession: false } });
  const { data: otpData, error: otpError } = await anonClient.auth.verifyOtp({
    type: "email",
    token_hash: tokenHash,
  });
  if (otpError || !otpData.session?.access_token) {
    console.warn("[v206] verifyOtp failed:", otpError?.message ?? "no session");
    return false;
  }

  const cookies = buildSupabaseAuthCookies(baseUrl, ref, otpData.session);
  await page.context().addCookies(cookies);
  await page.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return waitForAuthenticated(page, 12_000);
}

async function browserLoginWithPassword(page: Page, baseUrl: string): Promise<boolean> {
  const email =
    process.env.PLAYWRIGHT_LOGIN_EMAIL?.trim() || process.env.SMOKE_LOGIN_EMAIL?.trim() || "";
  const password =
    process.env.PLAYWRIGHT_LOGIN_PASSWORD?.trim() || process.env.SMOKE_LOGIN_PASSWORD?.trim() || "";
  if (!email || !password) return false;
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /^login$/i }).click();
  await page.waitForTimeout(2_000);
  return waitForAuthenticated(page, 15_000);
}

async function ensureAuth(page: Page, baseUrl: string, reusePath: string): Promise<boolean> {
  if (reusePath) {
    await page.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (await waitForAuthenticated(page, 8_000)) return true;
  }
  if (!hasFlag("--manual-login") && (await browserLoginViaMagicLink(page, baseUrl))) return true;
  if (hasFlag("--manual-login")) {
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.log("\n[manual-login] Sign in in the browser window (up to 180s)…\n");
    if (await waitForAuthenticated(page, 180_000)) return true;
  }
  if (await browserLoginWithPassword(page, baseUrl)) return true;
  if (!hasFlag("--manual-login") && (await browserLoginViaMagicLink(page, baseUrl))) return true;
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return waitForAuthenticated(page, 4_000);
}

async function main(): Promise<void> {
  const rid = process.argv.find((x) => x.startsWith("--run-id="))?.split("=")[1]?.trim() ?? "20260522T180000Z";
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  const shotDir = path.join(outDir, "screenshots");
  fs.mkdirSync(shotDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const baseUrl = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  if (!supabaseUrlMatchesStagingRef(process.env.NEXT_PUBLIC_SUPABASE_URL, STAGING_REF)) {
    console.error(JSON.stringify({ ok: false, error: "NEXT_PUBLIC_SUPABASE_URL must be staging ref" }));
    process.exit(2);
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  const pkg = await client.query(
    `SELECT p.package_code, p.organization_id::text AS organization_id
     FROM public.packages p
     INNER JOIN public.return_items r ON r.package_id = p.id AND r.deleted_at IS NULL
     WHERE p.deleted_at IS NULL AND p.package_code IS NOT NULL AND btrim(p.package_code) <> ''
     LIMIT 1`,
  );
  await client.end();
  const sampleCode = pkg.rows[0]?.package_code ? String(pkg.rows[0].package_code) : null;
  const sampleOrgId = pkg.rows[0]?.organization_id ? String(pkg.rows[0].organization_id) : null;
  if (!sampleCode) {
    fs.writeFileSync(path.join(outDir, "browser-shipment-entry-smoke.md"), "# Browser smoke\n\nFAIL — no sample package_code.\n");
    process.exit(1);
  }

  const authStateOut = path.join(outDir, "auth-state.json");
  let reusePath = "";
  if (hasFlag("--reuse-auth")) {
    if (fs.existsSync(authStateOut)) reusePath = authStateOut;
    else if (fs.existsSync(V172_AUTH)) reusePath = V172_AUTH;
    else if (fs.existsSync(V173_AUTH)) {
      const dirs = fs
        .readdirSync(V173_AUTH)
        .map((d) => path.join(V173_AUTH, d, "auth-state.json"))
        .filter((p) => fs.existsSync(p))
        .sort()
        .reverse();
      reusePath = dirs[0] ?? "";
    }
  }

  const checks: { id: string; pass: boolean; detail: string }[] = [];
  const headed = hasFlag("--headed") || hasFlag("--manual-login");
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState: reusePath || undefined,
  });
  const page = await context.newPage();

  try {
    const authed = await ensureAuth(page, baseUrl, reusePath);
    checks.push({
      id: "auth",
      pass: authed,
      detail: authed ? `Authenticated at ${page.url()}` : "Not signed in",
    });

    if (authed) {
      await context.storageState({ path: authStateOut });
      fs.mkdirSync(path.dirname(V172_AUTH), { recursive: true });
      await context.storageState({ path: V172_AUTH });

      await page.getByRole("heading", { name: /returns & logistics/i }).waitFor({ timeout: 60_000 });
      await page.getByText("Loading…").first().waitFor({ state: "hidden", timeout: 120_000 }).catch(() => {});

      const packagesTab = page.locator('[role="tablist"] [role="tab"]').filter({ hasText: /^Packages/i });
      await packagesTab.first().click({ timeout: 30_000 });
      await page.getByText("Inventory item status").first().waitFor({ timeout: 30_000 });
      await page.getByPlaceholder("package_code").waitFor({ timeout: 30_000 });

      if (sampleOrgId) {
        const createAs = page.locator('label:has-text("Create as") select');
        if ((await createAs.count()) > 0) {
          await createAs.selectOption(sampleOrgId);
        }
        const companySelect = page.locator('label:has-text("Company") select');
        if ((await companySelect.count()) > 0) {
          await companySelect.selectOption(sampleOrgId);
          await page.getByText("Loading…").first().waitFor({ state: "hidden", timeout: 120_000 }).catch(() => {});
        }
        const storeSelect = page.locator('label:has-text("Marketplace") select');
        if ((await storeSelect.count()) > 0) {
          await storeSelect.selectOption("");
        }
      }

      await page.getByPlaceholder("package_code").fill(sampleCode);
      await page.getByRole("button", { name: /search inventory/i }).click();
      await page.getByText("Loading inventory views…").waitFor({ state: "hidden", timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(1_500);

      const panelTitle = page.getByText("Inventory item status").first();
      const hasInventorySection = await panelTitle.isVisible();
      const noHardError =
        (await page.getByText(/v_inventory_item_status not present/i).count()) === 0 &&
        (await page.getByText(/Load failed/i).count()) === 0;
      const emptyFilter =
        (await page.getByText("No v_inventory_item_status rows for this filter.").count()) > 0;
      const hasResultRows =
        (await page.locator("table tbody tr").count()) > 0 ||
        (await page.getByText("Item status").count()) > 0;

      checks.push({
        id: "packages_tab",
        pass: hasInventorySection,
        detail: hasInventorySection ? "Inventory item status panel visible" : "Panel missing",
      });
      checks.push({
        id: "package_code_rows",
        pass: hasResultRows && !emptyFilter && noHardError,
        detail: hasResultRows
          ? `Rows returned for package # ${sampleCode}`
          : emptyFilter
            ? `No rows for ${sampleCode} (org/store filter?)`
            : "No item-status table rows after search",
      });

      await page.screenshot({ path: path.join(shotDir, "01-packages-package-code-search.png"), fullPage: true });
    } else {
      await page.screenshot({ path: path.join(shotDir, "00-login-required.png"), fullPage: true });
    }
  } catch (e) {
    checks.push({ id: "exception", pass: false, detail: e instanceof Error ? e.message : String(e) });
    try {
      await page.screenshot({ path: path.join(shotDir, "99-exception.png"), fullPage: true });
    } catch {
      /* ignore */
    }
  } finally {
    await browser.close();
  }

  const pass = checks.every((c) => c.pass);
  fs.writeFileSync(
    path.join(outDir, "browser-shipment-entry-smoke.md"),
    [
      "# Browser smoke — Shipment Entry package # (staging UI)",
      "",
      `Run: ${rid}`,
      `Base URL: ${baseUrl}`,
      `Sample package_code: \`${sampleCode}\``,
      `Screenshot: screenshots/01-packages-package-code-search.png`,
      "",
      "| Check | Pass | Detail |",
      "|-------|------|--------|",
      ...checks.map((c) => `| ${c.id} | ${c.pass ? "YES" : "NO"} | ${c.detail} |`),
      "",
      `**Overall:** ${pass ? "PASS" : "FAIL"}`,
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "browser-proof-manifest.json"),
    JSON.stringify({ run_id: rid, ok: pass, sampleCode, checks, screenshot: "screenshots/01-packages-package-code-search.png" }, null, 2),
  );

  console.log(JSON.stringify({ ok: pass, outDir, sampleCode, checks }, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
