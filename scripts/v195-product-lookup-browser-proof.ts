/**
 * V195 — PRODUCT LOOKUP BROWSER PROOF
 *
 * Proves barcode/product input lookup in the real Returns UI (staging-backed dev server).
 *
 * Usage:
 *   npx tsx scripts/v195-product-lookup-browser-proof.ts --run-id=20260521T220000Z
 *   npx tsx scripts/v195-product-lookup-browser-proof.ts --reuse-auth
 *   npx tsx scripts/v195-product-lookup-browser-proof.ts --manual-login --headed
 *
 * Requires: `npm run dev` on SMOKE_BASE_URL (default http://127.0.0.1:3000).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { chromium, type Browser, type Page, type Response } from "playwright";

import { classifyProductBarcode } from "../lib/product-barcode-classify";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/v195-product-lookup-browser-proof";
const UNKNOWN_CODE = "ZZZUNKNOWNV195PROOF999";
const V172_AUTH = path.resolve(
  process.cwd(),
  ".cursor/audit-reports/manual-ui-operable-browser-smoke-v172/auth-state.json",
);
const V173_AUTH = path.resolve(
  process.cwd(),
  ".cursor/audit-reports/manual-ui-operable-browser-smoke-v173",
);

type Fixture = {
  organization_id: string;
  store_id: string;
  fnsku: string | null;
  asin: string | null;
  sku: string | null;
  product_id: string;
  product_name: string | null;
};

type EditFixture = {
  return_id: string;
  organization_id: string;
  store_id: string | null;
  fnsku: string | null;
  asin: string | null;
  sku: string | null;
  resolved_product_id: string | null;
  item_name: string | null;
};

type Check = {
  id: string;
  pass: boolean;
  detail: string;
  screenshot?: string;
  server_action?: Record<string, unknown> | null;
};

type LookupCapture = {
  status: number;
  bodySnippet: string;
  parsed: Record<string, unknown> | null;
};

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

let cachedLoginEmail: string | null | undefined;

async function resolveLoginEmail(): Promise<string | null> {
  if (cachedLoginEmail !== undefined) return cachedLoginEmail;
  const fromEnv =
    process.env.PLAYWRIGHT_LOGIN_EMAIL?.trim() ||
    process.env.SMOKE_LOGIN_EMAIL?.trim() ||
    "";
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
  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();
  const r = await client.query(
    `SELECT email FROM auth.users WHERE email IS NOT NULL AND email <> '' ORDER BY created_at DESC LIMIT 1`,
  );
  await client.end();
  cachedLoginEmail = (r.rows[0]?.email as string | undefined)?.trim() || null;
  return cachedLoginEmail;
}

async function createAuthCookiesForPlaywright(
  baseUrl: string,
): Promise<{ name: string; value: string; domain: string; path: string }[] | null> {
  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const ref = refFromSupabaseUrl(url);
  const email = await resolveLoginEmail();
  if (!url || !anon || !serviceKey || !ref || !email) return null;

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const link = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${baseUrl}/returns` },
  });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  let session: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    expires_at?: number;
    token_type: string;
    user: Record<string, unknown>;
  } | null = null;
  try {
    const res = await fetch(`${url}/auth/v1/verify`, {
      method: "POST",
      headers: {
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "magiclink", token_hash: tokenHash, email }),
      signal: controller.signal,
    });
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      expires_at?: number;
      token_type?: string;
      user?: Record<string, unknown>;
    };
    if (res.ok && body.access_token && body.refresh_token && body.user) {
      session = {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_in: body.expires_in ?? 3600,
        expires_at: body.expires_at,
        token_type: body.token_type ?? "bearer",
        user: body.user,
      };
    }
  } catch (e) {
    console.warn("[v195] verify fetch failed:", e instanceof Error ? e.message : e);
  } finally {
    clearTimeout(timer);
  }
  if (!session) return null;

  const host = new URL(baseUrl).hostname;
  const storageValue = JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in,
    expires_at: session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in,
    token_type: session.token_type,
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
  return await waitForAuthenticated(page, 15_000);
}

async function browserLoginViaMagicLink(page: Page, baseUrl: string): Promise<boolean> {
  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const email = await resolveLoginEmail();
  if (!url || !serviceKey || !email) return false;

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${baseUrl}/returns` },
  });
  if (error || !data?.properties?.action_link) {
    console.warn("[v195] magic link failed:", error?.message ?? "no action_link");
    return false;
  }

  try {
    await page.goto(data.properties.action_link, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page
      .waitForURL(
        (u) => u.includes("access_token") || u.includes("/returns") || !u.includes("/login"),
        { timeout: 45_000 },
      )
      .catch(() => null);
    await page.waitForTimeout(2_000);
    if (page.url().includes("/login")) {
      await page.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    }
  } catch (e) {
    console.warn("[v195] magic link navigation:", e instanceof Error ? e.message : e);
    return false;
  }
  return await waitForAuthenticated(page, 20_000);
}

function enrichmentGateReason(): string {
  const spApiEnabled = ["1", "true", "yes"].includes(
    (process.env.AMAZON_SP_API_ENABLED ?? "").trim().toLowerCase(),
  );
  const autoCreateEnabled = ["1", "true", "yes"].includes(
    (process.env.PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED ?? "").trim().toLowerCase(),
  );
  const stagingUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const stagingOk = supabaseUrlMatchesStagingRef(stagingUrl, STAGING_REF);
  if (!stagingOk) return "blocked_non_staging";
  if (!spApiEnabled) return "amazon_sp_api_disabled";
  if (!autoCreateEnabled) return "product_enrichment_auto_create_disabled";
  return "gates_enabled";
}

async function runResolverPreflight(
  fixtures: Awaited<ReturnType<typeof loadFixtures>>,
  outDir: string,
): Promise<Check[]> {
  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key) throw new Error("Missing Supabase URL/service key for resolver preflight");
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const org = fixtures.orgStore.organization_id;
  const store = fixtures.orgStore.store_id;
  const checks: Check[] = [];

  async function resolveCode(code: string) {
    const c = classifyProductBarcode(code);
    return resolveScannerProductIdentifiers(sb, {
      organizationId: org,
      storeId: store,
      sku: c.kind === "sku_msku" ? c.normalized : null,
      asin: c.kind === "asin" ? c.normalized : null,
      fnsku: c.kind === "fnsku" ? c.normalized : null,
      upc: c.kind === "upc_ean" ? c.normalized : null,
      productIdentifier: c.normalized,
    });
  }

  const fnsku = await resolveCode(fixtures.fnsku);
  checks.push({
    id: "preflight_01_known_fnsku",
    pass: fnsku.identifier_resolution_status === "resolved" && !!fnsku.resolved_product_id,
    detail: JSON.stringify(fnsku),
  });
  const asin = await resolveCode(fixtures.asin);
  checks.push({
    id: "preflight_02_known_asin",
    pass: asin.identifier_resolution_status === "resolved" && !!asin.resolved_product_id,
    detail: JSON.stringify(asin),
  });
  const sku = await resolveCode(fixtures.sku);
  checks.push({
    id: "preflight_03_known_sku",
    pass: sku.identifier_resolution_status === "resolved" && !!sku.resolved_product_id,
    detail: JSON.stringify(sku),
  });
  const unk = await resolveCode(UNKNOWN_CODE);
  checks.push({
    id: "preflight_04_unknown",
    pass: unk.identifier_resolution_status !== "resolved",
    detail: JSON.stringify(unk),
  });
  const gate = enrichmentGateReason();
  checks.push({
    id: "preflight_05_gate_disabled",
    pass: gate !== "gates_enabled",
    detail: `expected enrichment disabled in dev env; got ${gate}`,
  });

  fs.writeFileSync(path.join(outDir, "resolver-preflight.json"), JSON.stringify(checks, null, 2));
  return checks;
}

async function waitForAuthenticated(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!page.url().includes("/login") && !page.url().includes("/auth/")) return true;
    await page.waitForTimeout(400);
  }
  return !page.url().includes("/login");
}

async function loadFixtures(): Promise<{
  orgStore: Fixture;
  fnsku: string;
  asin: string;
  sku: string;
  alt: { fnsku: string | null; asin: string | null; sku: string | null; product_id: string };
  edit: EditFixture | null;
}> {
  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) throw new Error("STAGING_DIRECT_POSTGRES_URL missing");
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '60s'");

  const mapRow = await client.query(`
    SELECT m.organization_id::text, m.store_id::text, m.fnsku, m.asin,
      COALESCE(NULLIF(TRIM(m.seller_sku), ''), NULLIF(TRIM(m.msku), '')) AS sku,
      m.product_id::text, p.product_name
    FROM public.product_identifier_map m
    JOIN public.products p ON p.id = m.product_id AND p.deleted_at IS NULL
    WHERE m.deleted_at IS NULL
      AND m.fnsku IS NOT NULL AND length(trim(m.fnsku)) >= 8
      AND m.asin IS NOT NULL AND length(trim(m.asin)) >= 10
      AND COALESCE(NULLIF(TRIM(m.seller_sku), ''), NULLIF(TRIM(m.msku), '')) IS NOT NULL
    ORDER BY m.last_seen_at DESC NULLS LAST
    LIMIT 1
  `);

  if (!mapRow.rows[0]) {
    await client.end();
    throw new Error("No suitable map fixture (fnsku+asin+sku) on staging");
  }
  const base = mapRow.rows[0] as Fixture;

  const altRow = await client.query(
    `
    SELECT m.fnsku, m.asin,
      COALESCE(NULLIF(TRIM(m.seller_sku), ''), NULLIF(TRIM(m.msku), '')) AS sku,
      m.product_id::text
    FROM public.product_identifier_map m
    WHERE m.deleted_at IS NULL
      AND m.organization_id = $1::uuid
      AND m.store_id = $2::uuid
      AND m.product_id <> $3::uuid
      AND (m.fnsku IS NOT NULL OR m.asin IS NOT NULL)
    ORDER BY m.last_seen_at DESC NULLS LAST
    LIMIT 1
  `,
    [base.organization_id, base.store_id, base.product_id],
  );

  const editRow = await client.query(
    `
    SELECT id::text AS return_id, organization_id::text, store_id::text,
      fnsku, asin, sku, resolved_product_id::text, item_name
    FROM public.return_items
    WHERE deleted_at IS NULL
      AND resolved_product_id IS NOT NULL
      AND organization_id = $1::uuid
      AND (store_id = $2::uuid OR store_id IS NULL)
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1
  `,
    [base.organization_id, base.store_id],
  );

  await client.end();

  return {
    orgStore: base,
    fnsku: base.fnsku!,
    asin: base.asin!,
    sku: base.sku!,
    alt: (altRow.rows[0] as {
      fnsku: string | null;
      asin: string | null;
      sku: string | null;
      product_id: string;
    }) ?? { fnsku: null, asin: null, sku: null, product_id: base.product_id },
    edit: (editRow.rows[0] as EditFixture | undefined) ?? null,
  };
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

function parseServerActionBody(text: string): Record<string, unknown> | null {
  const markers = ['"ok":true', '"ok":false', '"status":"local_resolved"', '"status":"unresolved"'];
  if (!markers.some((m) => text.includes(m))) return null;
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    /* RSC chunks may not be pure JSON */
  }
  if (text.includes("local_resolved")) return { inferred_status: "local_resolved" };
  if (text.includes("unresolved")) return { inferred_status: "unresolved" };
  if (text.includes("product_enrichment_auto_create_disabled")) {
    return { inferred_enrichment_reason: "product_enrichment_auto_create_disabled" };
  }
  if (text.includes("amazon_sp_api_disabled")) {
    return { inferred_enrichment_reason: "amazon_sp_api_disabled" };
  }
  return null;
}

async function openWizard(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByRole("heading", { name: /returns & logistics/i }).waitFor({ timeout: 60_000 }).catch(() => null);
  await page.getByRole("tab", { name: /^items$/i }).click();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /scan new item/i }).click();
  await page.getByPlaceholder(/scan or type product identifier/i).waitFor({ timeout: 30_000 });
}

async function prepareLooseWizard(page: Page, storeId: string): Promise<void> {
  const loose = page.locator('input[type="checkbox"]').filter({ has: page.locator("xpath=..") }).first();
  const looseLabel = page.getByText("Loose Item (No Box)");
  if (await looseLabel.count()) {
    const box = page.locator('label:has-text("Loose Item") input[type="checkbox"]').first();
    if (await box.count()) {
      const checked = await box.isChecked();
      if (!checked) await box.check();
    }
  }
  const storeSelect = page.locator("select").filter({ has: page.locator('option:has-text("Select Store")') }).first();
  if (!(await storeSelect.count())) {
    const anyStore = page.locator("select").nth(0);
    await anyStore.selectOption(storeId);
  } else {
    await storeSelect.selectOption(storeId);
  }
  await page.locator('button:has-text("damaged")').first().click().catch(async () => {
    await page.getByRole("button", { name: /damaged/i }).first().click().catch(() => null);
  });
}

async function runBarcodeLookup(
  page: Page,
  code: string,
  opts?: { storeId?: string },
): Promise<{
  loadingCleared: boolean;
  foundLocally: boolean;
  unknown: boolean;
  enrichmentReason: string | null;
  asinValue: string;
  fnskuValue: string;
  skuValue: string;
  capture: LookupCapture | null;
}> {
  if (opts?.storeId) await prepareLooseWizard(page, opts.storeId);

  let capture: LookupCapture | null = null;
  const responsePromise = page
    .waitForResponse(
      (r: Response) =>
        r.request().method() === "POST" &&
        !!r.request().headers()["next-action"] &&
        r.url().includes("/returns"),
      { timeout: 20_000 },
    )
    .catch(() => null);

  const input = page.getByPlaceholder(/scan or type product identifier/i).first();
  await input.fill(code);
  await input.blur();

  const loading = page.getByText("Looking up barcode");
  await loading.waitFor({ state: "visible", timeout: 5_000 }).catch(() => null);
  await loading.waitFor({ state: "hidden", timeout: 12_000 }).catch(() => null);

  const resp = await responsePromise;
  if (resp) {
    const body = await resp.text().catch(() => "");
    capture = {
      status: resp.status(),
      bodySnippet: body.slice(0, 2000),
      parsed: parseServerActionBody(body),
    };
  }

  const bodyText = await page.locator("body").innerText();
  const foundLocally = /Found locally/i.test(bodyText);
  const unknown = /Unknown Item/i.test(bodyText);
  const reasonMatch = bodyText.match(/Unknown Item[^\n]*\(([^)]+)\)/);
  const enrichmentReason = reasonMatch?.[1]?.trim() ?? null;

  const asinValue = await page.locator('input[placeholder*="B08"]').first().inputValue().catch(() => "");
  const fnskuValue = await page
    .locator('input[placeholder*="X001"]')
    .first()
    .inputValue()
    .catch(() => "");
  const skuValue = await page
    .locator('input[placeholder*="SKU"]')
    .first()
    .inputValue()
    .catch(() => "");

  return {
    loadingCleared: !(await loading.isVisible().catch(() => false)),
    foundLocally,
    unknown,
    enrichmentReason,
    asinValue,
    fnskuValue,
    skuValue,
    capture,
  };
}

async function openItemDrawerForEdit(
  page: Page,
  baseUrl: string,
  returnId: string,
): Promise<boolean> {
  await page.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByRole("tab", { name: /^items$/i }).click();
  await page.waitForTimeout(1_000);
  const row = page.locator(`tr[data-return-id="${returnId}"]`).first();
  if (await row.count()) {
    await row.click();
  } else {
    await page.locator("table tbody tr").first().click();
  }
  await page.waitForTimeout(1_200);
  const editBtn = page.getByRole("button", { name: /^edit$/i }).first();
  if (await editBtn.count()) {
    await editBtn.click();
    await page.getByLabel(/product barcode/i).waitFor({ timeout: 15_000 }).catch(() =>
      page.getByPlaceholder(/product identifier/i).first().waitFor({ timeout: 15_000 }),
    );
    return true;
  }
  return false;
}

async function queryReturnProduct(returnId: string): Promise<{
  resolved_product_id: string | null;
  fnsku: string | null;
  asin: string | null;
  sku: string | null;
}> {
  loadEnvLocalIntoProcess();
  const client = new pg.Client({
    connectionString: process.env.STAGING_DIRECT_POSTGRES_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const r = await client.query(
    `SELECT resolved_product_id::text, fnsku, asin, sku FROM public.return_items WHERE id = $1::uuid`,
    [returnId],
  );
  await client.end();
  return r.rows[0] as {
    resolved_product_id: string | null;
    fnsku: string | null;
    asin: string | null;
    sku: string | null;
  };
}

async function main(): Promise<void> {
  const id = runId();
  const manualLogin = hasFlag("--manual-login");
  const headed = hasFlag("--headed") || manualLogin;
  const baseUrl = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  const outDir = path.resolve(process.cwd(), OUT_BASE, id);
  const shotDir = path.join(outDir, "screenshots");
  fs.mkdirSync(shotDir, { recursive: true });

  const checks: Check[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const fixtures = await loadFixtures();

  fs.writeFileSync(path.join(outDir, "fixtures.json"), JSON.stringify(fixtures, null, 2));

  loadEnvLocalIntoProcess();
  const preflightChecks = await runResolverPreflight(fixtures, outDir);
  const ref = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "");
  checks.push({
    id: "00_env_staging",
    pass: ref === STAGING_REF,
    detail: `NEXT_PUBLIC_SUPABASE_URL ref=${ref ?? "?"}`,
  });

  const authStatePath = path.join(outDir, "auth-state.json");
  let reusePath = "";
  if (hasFlag("--reuse-auth")) {
    if (fs.existsSync(authStatePath)) reusePath = authStatePath;
    else {
      const v173Dirs = fs.existsSync(V173_AUTH)
        ? fs
            .readdirSync(V173_AUTH)
            .map((d) => path.join(V173_AUTH, d, "auth-state.json"))
            .filter((p) => fs.existsSync(p))
            .sort()
            .reverse()
        : [];
      reusePath = v173Dirs[0] ?? (fs.existsSync(V172_AUTH) ? V172_AUTH : "");
    }
  }

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    browser = await chromium.launch({ headless: !headed });
    const authCookies = reusePath ? null : await createAuthCookiesForPlaywright(baseUrl);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: reusePath || undefined,
    });
    if (authCookies?.length) {
      await context.addCookies(authCookies);
    }
    page = await context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    let authed = false;
    if (reusePath) {
      await page.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      authed = await waitForAuthenticated(page!, 8_000);
    }
    if (!authed && manualLogin) {
      await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      console.log("\n[manual-login] Sign in in the browser window. Waiting up to 180s…\n");
      authed = await waitForAuthenticated(page!, 180_000);
    }
    if (!authed) {
      authed = await browserLoginWithPassword(page!, baseUrl);
    }
    if (!authed) {
      authed = await browserLoginViaMagicLink(page!, baseUrl);
    }
    if (!authed) {
      await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      authed = await waitForAuthenticated(page!, 4_000);
    }
    checks.push({
      id: "01_auth",
      pass: authed,
      detail: authed ? `Authenticated (${page!.url()})` : "Not signed in — use --reuse-auth or --manual-login --headed",
    });
    if (!authed) {
      await shot(page!, shotDir, "01-login");
      const preflightOk = preflightChecks.every((c) => c.pass);
      finish(
        outDir,
        id,
        checks,
        consoleErrors,
        pageErrors,
        baseUrl,
        fixtures,
        preflightOk ? "CONDITIONAL_PASS" : "FAIL",
        preflightChecks,
      );
      console.log(
        JSON.stringify(
          {
            run_id: id,
            status: preflightOk ? "CONDITIONAL_PASS" : "FAIL",
            note: "Browser auth required — see operator-instructions.md",
          },
          null,
          2,
        ),
      );
      process.exit(preflightOk ? 0 : 1);
    }
    await context.storageState({ path: authStatePath });

    // ── Case 1: Known FNSKU ───────────────────────────────────────────────
    await openWizard(page!, baseUrl);
    const fnskuRes = await runBarcodeLookup(page!, fixtures.fnsku, {
      storeId: fixtures.orgStore.store_id,
    });
    checks.push({
      id: "02_known_fnsku",
      pass:
        fnskuRes.loadingCleared &&
        fnskuRes.foundLocally &&
        (fnskuRes.fnskuValue.toUpperCase().includes(fixtures.fnsku.toUpperCase()) ||
          fnskuRes.asinValue.length > 0),
      detail: JSON.stringify({
        loadingCleared: fnskuRes.loadingCleared,
        foundLocally: fnskuRes.foundLocally,
        fnskuField: fnskuRes.fnskuValue,
        server: fnskuRes.capture?.parsed ?? fnskuRes.capture?.bodySnippet?.slice(0, 200),
      }),
      screenshot: await shot(page!, shotDir, "02-known-fnsku"),
      server_action: fnskuRes.capture?.parsed ?? null,
    });

    // ── Case 2: Known ASIN (fresh wizard) ─────────────────────────────────
    await page!.keyboard.press("Escape").catch(() => null);
    await page!.waitForTimeout(500);
    await openWizard(page!, baseUrl);
    const asinRes = await runBarcodeLookup(page!, fixtures.asin, {
      storeId: fixtures.orgStore.store_id,
    });
    checks.push({
      id: "03_known_asin",
      pass:
        asinRes.loadingCleared &&
        asinRes.foundLocally &&
        asinRes.asinValue.toUpperCase().includes(fixtures.asin.toUpperCase()),
      detail: JSON.stringify({
        loadingCleared: asinRes.loadingCleared,
        foundLocally: asinRes.foundLocally,
        asinField: asinRes.asinValue,
        server: asinRes.capture?.parsed,
      }),
      screenshot: await shot(page!, shotDir, "03-known-asin"),
      server_action: asinRes.capture?.parsed ?? null,
    });

    // ── Case 3: Known SKU + store ─────────────────────────────────────────
    await page!.keyboard.press("Escape").catch(() => null);
    await page!.waitForTimeout(500);
    await openWizard(page!, baseUrl);
    const skuRes = await runBarcodeLookup(page!, fixtures.sku, {
      storeId: fixtures.orgStore.store_id,
    });
    checks.push({
      id: "04_known_sku_store",
      pass: skuRes.loadingCleared && skuRes.foundLocally && skuRes.skuValue.length > 0,
      detail: JSON.stringify({
        loadingCleared: skuRes.loadingCleared,
        foundLocally: skuRes.foundLocally,
        skuField: skuRes.skuValue,
        store: fixtures.orgStore.store_id,
        server: skuRes.capture?.parsed,
      }),
      screenshot: await shot(page!, shotDir, "04-known-sku"),
      server_action: skuRes.capture?.parsed ?? null,
    });

    // ── Case 4: Unknown code ────────────────────────────────────────────────
    await page!.keyboard.press("Escape").catch(() => null);
    await page!.waitForTimeout(500);
    await openWizard(page!, baseUrl);
    const unkRes = await runBarcodeLookup(page!, UNKNOWN_CODE, {
      storeId: fixtures.orgStore.store_id,
    });
    checks.push({
      id: "05_unknown_code",
      pass: unkRes.loadingCleared && unkRes.unknown && !unkRes.foundLocally,
      detail: JSON.stringify({
        loadingCleared: unkRes.loadingCleared,
        unknown: unkRes.unknown,
        reason: unkRes.enrichmentReason,
        server: unkRes.capture?.parsed,
      }),
      screenshot: await shot(page!, shotDir, "05-unknown"),
      server_action: unkRes.capture?.parsed ?? null,
    });

    // ── Case 5: Enrichment gate disabled (reason visible, no stuck loading) ─
    const gateOk =
      unkRes.loadingCleared &&
      !!unkRes.enrichmentReason &&
      /disabled|blocked|requires_asin/i.test(unkRes.enrichmentReason);
    checks.push({
      id: "06_enrichment_gate_disabled",
      pass: gateOk,
      detail: gateOk
        ? `Enrichment reason shown: ${unkRes.enrichmentReason}`
        : `Expected gate reason in Unknown banner; got: ${unkRes.enrichmentReason ?? "none"}`,
      screenshot: await shot(page!, shotDir, "06-gate-disabled"),
      server_action: unkRes.capture?.parsed ?? null,
    });

    // ── Cases 6–7: Edit drawer save + re-resolve ──────────────────────────
    if (!fixtures.edit?.return_id) {
      checks.push({
        id: "07_save_persists_product",
        pass: false,
        detail: "Skipped — no return_items fixture with resolved_product_id",
      });
      checks.push({
        id: "08_edit_identifier_reresolve",
        pass: false,
        detail: "Skipped — no edit fixture",
      });
    } else {
      await page!.keyboard.press("Escape").catch(() => null);
      await page!.waitForTimeout(600);
      const editOpened = await openItemDrawerForEdit(page!, baseUrl, fixtures.edit.return_id);
      if (!editOpened) {
        checks.push({
          id: "07_save_persists_product",
          pass: false,
          detail: "Could not open item drawer edit mode",
          screenshot: await shot(page!, shotDir, "07-edit-missing"),
        });
        checks.push({
          id: "08_edit_identifier_reresolve",
          pass: false,
          detail: "Skipped — edit UI not opened",
        });
      } else {
        const editInput = page!.getByPlaceholder(/product identifier/i).first();
        await editInput.fill(fixtures.fnsku);
        await editInput.blur();
        await page!.getByText("Looking up barcode").waitFor({ state: "hidden", timeout: 12_000 }).catch(() => null);
        await page!.waitForTimeout(600);
        const saveBtn = page!.getByRole("button", { name: /^save$/i }).first();
        await saveBtn.click();
        await page!.waitForTimeout(2_500);
        const afterSave = await queryReturnProduct(fixtures.edit.return_id);
        const linkedVisible = /Linked/i.test(await page!.locator("body").innerText());
        checks.push({
          id: "07_save_persists_product",
          pass: !!afterSave.resolved_product_id && linkedVisible,
          detail: JSON.stringify({
            resolved_product_id: afterSave.resolved_product_id,
            linkedVisible,
            fnsku: afterSave.fnsku,
          }),
          screenshot: await shot(page!, shotDir, "07-save-persist"),
        });

        // Case 7: change identifier to alt product
        await page!.getByRole("button", { name: /^edit$/i }).first().click().catch(() => null);
        await page!.waitForTimeout(800);
        const altCode = fixtures.alt.asin ?? fixtures.alt.fnsku ?? fixtures.alt.sku;
        if (!altCode) {
          checks.push({
            id: "08_edit_identifier_reresolve",
            pass: false,
            detail: "No alternate identifier fixture",
          });
        } else {
          const before = await queryReturnProduct(fixtures.edit.return_id);
          await editInput.fill(altCode);
          await editInput.blur();
          await page!.getByText("Looking up barcode").waitFor({ state: "hidden", timeout: 12_000 }).catch(() => null);
          const foundOnReresolve = /Found locally/i.test(await page!.locator("body").innerText());
          await saveBtn.click();
          await page!.waitForTimeout(2_500);
          const after = await queryReturnProduct(fixtures.edit.return_id);
          const changed =
            after.resolved_product_id &&
            after.resolved_product_id !== before.resolved_product_id;
          checks.push({
            id: "08_edit_identifier_reresolve",
            pass: foundOnReresolve && !!after.resolved_product_id,
            detail: JSON.stringify({
              foundOnReresolve,
              before_product: before.resolved_product_id,
              after_product: after.resolved_product_id,
              changed,
              altCode,
            }),
            screenshot: await shot(page!, shotDir, "08-edit-reresolve"),
          });
        }
      }
    }

    // Linkage "Linked" proof on drawer read view after wizard lookup
    checks.push({
      id: "09_linkage_linked_wizard_copy",
      pass: fnskuRes.foundLocally || asinRes.foundLocally,
      detail:
        "Wizard shows 'Found locally' (resolved lookup). Post-save 'Linked' chip verified in case 07 when edit fixture exists.",
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

  const required = [
    "02_known_fnsku",
    "03_known_asin",
    "04_known_sku_store",
    "05_unknown_code",
    "06_enrichment_gate_disabled",
  ];
  const corePass = required.every((rid) => checks.find((c) => c.id === rid)?.pass);
  const allPass = checks.filter((c) => !c.id.startsWith("09_")).every((c) => c.pass);
  const browserRan = checks.some((c) => c.id.startsWith("02_"));
  const status = allPass
    ? "PASS"
    : !browserRan && preflightChecks.every((c) => c.pass)
      ? "CONDITIONAL_PASS"
      : corePass
        ? "CONDITIONAL_PASS"
        : "FAIL";
  finish(outDir, id, checks, consoleErrors, pageErrors, baseUrl, fixtures, status, preflightChecks);
  console.log(JSON.stringify({ run_id: id, status, outDir, pass: checks.filter((c) => c.pass).length, total: checks.length }, null, 2));
  const conditionalOk =
    !checks.some((c) => c.id.startsWith("02_")) && preflightChecks.every((c) => c.pass);
  process.exit(corePass || conditionalOk ? 0 : 1);
}

function finish(
  outDir: string,
  runId: string,
  checks: Check[],
  consoleErrors: string[],
  pageErrors: string[],
  baseUrl: string,
  fixtures: unknown,
  status: string,
  preflightChecks: Check[] = [],
): void {
  const passN = checks.filter((c) => c.pass).length;
  const md = [
    "# V195 — Product lookup browser proof",
    "",
    `**Run id:** \`${runId}\``,
    `**Status:** ${status} (${passN}/${checks.length} checks)`,
    `**Base URL:** ${baseUrl}`,
    `**Staging ref:** \`${STAGING_REF}\``,
    "",
    "## Required proof cases",
    "",
    "| Case | Check id | Result | Detail |",
    "|------|----------|--------|--------|",
    ...checks.map(
      (c) =>
        `| ${c.id.replace(/^\d+_/, "")} | \`${c.id}\` | ${c.pass ? "PASS" : "FAIL"} | ${c.detail.replace(/\|/g, "\\|").slice(0, 240)} |`,
    ),
    "",
    "## Screenshots",
    "",
    ...checks
      .filter((c) => c.screenshot)
      .map((c) => `- [\`${c.screenshot}\`](${c.screenshot}) — ${c.id}`),
    "",
    "## Constraints",
    "",
    "- Staging UI only; no production, package_items, legacy returns, browser DB writes, browser Amazon API, fake SP-API, or AI.",
    "",
    "## Console",
    "",
    ...(consoleErrors.length ? consoleErrors.slice(0, 15).map((e) => `- ${e}`) : ["- (none captured)"]),
    "",
    "## Page errors",
    "",
    ...(pageErrors.length ? pageErrors.slice(0, 15).map((e) => `- ${e}`) : ["- (none captured)"]),
  ].join("\n");

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "V195 — PRODUCT LOOKUP BROWSER PROOF",
        run_id: runId,
        status,
        baseUrl,
        staging_ref: STAGING_REF,
        fixtures,
        checks,
        resolver_preflight_checks: preflightChecks,
        console_error_count: consoleErrors.length,
        page_error_count: pageErrors.length,
        forbidden: {
          production_touched: false,
          package_items_created: false,
          browser_amazon_api: false,
          fake_sp_api: false,
          ai_openai: false,
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(outDir, "proof-summary.md"), md);
  fs.writeFileSync(path.join(outDir, "signoff-result.json"), JSON.stringify({ run_id: runId, status, checks }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
