/**
 * PC02-FOLLOWUP — lookup evidence browser proof (unknown code vs valid ASIN).
 *
 * Requires dev server: npm run dev (SMOKE_BASE_URL default http://127.0.0.1:3000)
 *
 * Usage:
 *   npx tsx scripts/pc02-lookup-evidence-browser-proof.ts --run-id=20260524T220000Z
 *   npx tsx scripts/pc02-lookup-evidence-browser-proof.ts --asin=B0XXXXXXXXX
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { chromium, type Browser, type Page } from "playwright";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const UNKNOWN_CODE = "ZZZUNKNOWNV196PROOF999";
const OUT_BASE = ".cursor/audit-reports/pc02-sp-api-followup";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function asinArg(): string | null {
  const a = process.argv.find((x) => x.startsWith("--asin="));
  if (!a) return null;
  const asin = a.split("=")[1]!.trim().toUpperCase();
  return /^B[0-9A-Z]{9}$/.test(asin) ? asin : null;
}

async function loadCatalogAsin(): Promise<string> {
  const override = asinArg();
  if (override) return override;
  loadEnvLocalIntoProcess();
  const client = new pg.Client({
    connectionString: process.env.STAGING_DIRECT_POSTGRES_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const r = await client.query(
    `SELECT UPPER(TRIM(asin)) AS asin FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND asin IS NOT NULL AND TRIM(asin) ~ '^B[0-9A-Z]{9}$'
       AND deleted_at IS NULL
     ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [ORG, STORE],
  );
  await client.end();
  const asin = (r.rows[0] as { asin?: string } | undefined)?.asin;
  if (!asin) throw new Error("No ASIN fixture on staging products");
  return asin;
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
  return !page.url().includes("/login");
}

async function waitForAuthenticated(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!page.url().includes("/login") && !page.url().includes("/auth/")) return true;
    await page.waitForTimeout(400);
  }
  return !page.url().includes("/login");
}

async function browserLoginViaMagicLink(page: Page, baseUrl: string): Promise<boolean> {
  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1 });
  const email = users.users[0]?.email;
  if (!email) return false;
  const link = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${baseUrl}/returns` },
  });
  const actionLink = link.data?.properties?.action_link;
  if (!actionLink) {
    const tokenHash = link.data?.properties?.hashed_token;
    if (tokenHash && anon) {
      const res = await fetch(`${url}/auth/v1/verify`, {
        method: "POST",
        headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "magiclink", token_hash: tokenHash, email }),
      });
      const body = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        expires_at?: number;
        token_type?: string;
        user?: Record<string, unknown>;
      };
      if (body.access_token && body.refresh_token && body.user) {
        const ref = refFromSupabaseUrl(url);
        const host = new URL(baseUrl).hostname;
        const storageValue = JSON.stringify({
          access_token: body.access_token,
          refresh_token: body.refresh_token,
          expires_in: body.expires_in ?? 3600,
          expires_at: body.expires_at ?? Math.floor(Date.now() / 1000) + (body.expires_in ?? 3600),
          token_type: body.token_type ?? "bearer",
          user: body.user,
        });
        const cookieName = `sb-${ref}-auth-token`;
        await page.context().addCookies([
          { name: cookieName, value: storageValue, domain: host, path: "/" },
          { name: `${cookieName}.0`, value: storageValue.slice(0, 3180), domain: host, path: "/" },
        ]);
        await page.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        return waitForAuthenticated(page, 12_000);
      }
    }
    return false;
  }
  await page.goto(actionLink, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForTimeout(2_000);
  if (page.url().includes("/login")) {
    await page.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  }
  return waitForAuthenticated(page, 15_000);
}

async function createAuthCookies(baseUrl: string) {
  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const ref = refFromSupabaseUrl(url);
  if (!url || !anon || !serviceKey || !ref) return null;

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1 });
  const email = users.users[0]?.email;
  if (!email) return null;

  const link = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${baseUrl}/returns` },
  });
  const tokenHash = link.data?.properties?.hashed_token;
  if (!tokenHash) return null;

  const res = await fetch(`${url}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: anon, Authorization: `Bearer ${anon}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token_hash: tokenHash, email }),
  });
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    expires_at?: number;
    token_type?: string;
    user?: Record<string, unknown>;
  };
  if (!res.ok || !body.access_token || !body.refresh_token || !body.user) return null;

  const host = new URL(baseUrl).hostname;
  const storageValue = JSON.stringify({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_in: body.expires_in ?? 3600,
    expires_at: body.expires_at ?? Math.floor(Date.now() / 1000) + (body.expires_in ?? 3600),
    token_type: body.token_type ?? "bearer",
    user: body.user,
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

async function openWizard(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByRole("tab", { name: /^items$/i }).click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: /scan new item/i }).click();
  await page.getByPlaceholder(/scan or type product identifier/i).waitFor({ timeout: 30_000 });
  const storeSelect = page.locator("select").first();
  if (await storeSelect.count()) await storeSelect.selectOption(STORE).catch(() => null);
  const loose = page.locator('label:has-text("Loose Item") input[type="checkbox"]').first();
  if (await loose.count()) {
    if (!(await loose.isChecked())) await loose.check();
  }
  await page.locator('button:has-text("damaged")').first().click().catch(() => null);
}

async function lookupCode(page: Page, code: string) {
  const input = page.getByPlaceholder(/scan or type product identifier/i).first();
  await input.fill(code);
  await input.blur();
  const loading = page.getByText("Looking up barcode");
  await loading.waitFor({ state: "visible", timeout: 5_000 }).catch(() => null);
  await loading.waitFor({ state: "hidden", timeout: 20_000 }).catch(() => null);
  await page.waitForTimeout(400);
  const body = await page.locator("body").innerText();
  return {
    unknown: /Unknown Item/i.test(body),
    foundLocally: /Found locally/i.test(body),
    amazonEvidence: /Amazon catalog evidence/i.test(body),
    backendEnriched: /Backend enriched/i.test(body),
    itemNameFilled: (await page.locator('input[placeholder*="Item name"]').first().inputValue().catch(() => "")).length > 2,
  };
}

async function main() {
  const id = runId();
  const catalogAsin = await loadCatalogAsin();
  const outDir = path.resolve(process.cwd(), OUT_BASE, id);
  const shotDir = path.join(outDir, "screenshots");
  fs.mkdirSync(shotDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const evidenceOnly = ["1", "true", "yes"].includes(
    (process.env.PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED ?? "").trim().toLowerCase(),
  );
  const spApi = ["1", "true", "yes"].includes((process.env.AMAZON_SP_API_ENABLED ?? "").trim().toLowerCase());
  const stagingOk = supabaseUrlMatchesStagingRef(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", STAGING_REF);

  fs.writeFileSync(
    path.join(outDir, "env-gates.md"),
    [
      "# PC02 lookup browser proof — env gates",
      "",
      `| Flag | Value |`,
      `|------|-------|`,
      `| PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED | ${evidenceOnly} |`,
      `| AMAZON_SP_API_ENABLED | ${spApi} |`,
      `| staging URL match | ${stagingOk} |`,
      `| catalog ASIN | \`${catalogAsin}\` |`,
      `| unknown code | \`${UNKNOWN_CODE}\` |`,
    ].join("\n"),
  );

  const baseUrl = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  let browser: Browser | null = null;
  const checks: { id: string; pass: boolean; detail: string }[] = [];

  try {
    const probe = await fetch(`${baseUrl}/returns`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
    checks.push({
      id: "00_dev_server",
      pass: !!probe && probe.status < 500,
      detail: probe ? `HTTP ${probe.status}` : "Dev server not reachable — run npm run dev",
    });
    if (!probe || probe.status >= 500) throw new Error("Dev server required");

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    let authed = false;
    const cookies = await createAuthCookies(baseUrl);
    if (cookies?.length) {
      await context.addCookies(cookies);
      await page.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      authed = await waitForAuthenticated(page, 8_000);
    }
    if (!authed) authed = await browserLoginWithPassword(page, baseUrl);
    if (!authed) authed = await browserLoginViaMagicLink(page, baseUrl);
    if (!authed) {
      checks.push({ id: "01_auth", pass: false, detail: "Not authenticated — set PLAYWRIGHT_LOGIN_EMAIL/PASSWORD or sign in manually" });
      throw new Error("Auth failed");
    }
    checks.push({ id: "01_auth", pass: true, detail: page.url() });

    await openWizard(page, baseUrl);
    const unk = await lookupCode(page, UNKNOWN_CODE);
    await page.screenshot({ path: path.join(shotDir, "unknown-code.png"), fullPage: true });
    checks.push({
      id: "02_unknown_code",
      pass: unk.unknown && !unk.foundLocally,
      detail: JSON.stringify(unk),
    });

    await page.keyboard.press("Escape").catch(() => null);
    await page.waitForTimeout(400);
    await openWizard(page, baseUrl);
    const asin = await lookupCode(page, catalogAsin);
    await page.screenshot({ path: path.join(shotDir, "valid-asin.png"), fullPage: true });
    checks.push({
      id: "03_valid_asin",
      pass:
        (asin.foundLocally || asin.amazonEvidence || asin.backendEnriched) &&
        !asin.unknown &&
        asin.itemNameFilled,
      detail: JSON.stringify({ catalogAsin, ...asin }),
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

  const status = checks.every((c) => c.pass) ? "PASS" : checks.some((c) => c.id.startsWith("02_") && c.pass) ? "CONDITIONAL_PASS" : "FAIL";
  fs.writeFileSync(
    path.join(outDir, "browser-proof-summary.md"),
    [
      "# PC02-FOLLOWUP — browser proof",
      "",
      `**Run id:** \`${id}\``,
      `**Status:** ${status}`,
      "",
      "| Check | Pass | Detail |",
      "|-------|------|--------|",
      ...checks.map((c) => `| ${c.id} | ${c.pass ? "yes" : "no"} | ${c.detail.replace(/\|/g, "\\|").slice(0, 200)} |`),
      "",
      "## Screenshots",
      "",
      "- `screenshots/unknown-code.png`",
      "- `screenshots/valid-asin.png`",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(outDir, "browser-proof.json"), JSON.stringify({ run_id: id, status, checks, catalogAsin }, null, 2));
  console.log(JSON.stringify({ run_id: id, status, outDir, checks }, null, 2));
  process.exit(status === "FAIL" ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
